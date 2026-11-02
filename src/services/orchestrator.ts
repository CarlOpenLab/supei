import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore, type NewArtboardInput } from '@/stores/workspace'
import type { Artboard, ArtifactMode, ChatAttachment, ElementContext, PlanPayload, PlanStyle, Version } from '@/types'
import { ARTIFACT_MODE_QUESTION_ID, artifactModePromptLabel, inferArtifactMode, makeArtifactModeQuestion, resolveArtifactMode } from '@/utils/artifactMode'
import { applyEdits } from '@/utils/editable'
import { branchPosition, branchTitle, captureRootOf, findFreeSpot, manualBranchTitle } from '@/utils/boardBranch'
import { describeChanges } from '@/utils/diff'
import { describeElement, generatePrototype } from './generator'
import { isAgentProvider, streamAgent } from './llm'
import { planIteration, planPrototype } from './planner'
import { pluginRegistry } from '@/plugins/registry'
import type { TemplatePluginData } from '@/plugins/types'

const activeControllers = new Set<AbortController>()

/** 最近一次失败的请求（生成原型或 Agent 改代码），供错误卡上的「重试」使用 */
let retryAction: (() => Promise<void>) | null = null

function defaultTemplate(): TemplatePluginData {
  const t = pluginRegistry.listByKind('template')[0]
  return t ? (t.data as TemplatePluginData) : { width: 1280, height: 800 }
}

const VARIANT_SUFFIX = ['方案 A', '方案 B', '方案 C']
const VARIANT_HINT = [
  '走经典稳妥的布局方向。',
  '与常规布局形成差异：尝试不对称构图、杂志式排版等更大胆的设计方向。',
  '换一种气质：尝试深色主题或强对比的视觉方向。',
]

export function isGenerating(): boolean {
  return useCanvasStore().busy
}

export function stopGeneration() {
  activeControllers.forEach((c) => c.abort())
}

export async function retryLast() {
  const action = retryAction
  if (!action || useCanvasStore().busy) return
  retryAction = null
  await action()
}

function cascadePosition(): { x: number; y: number } {
  const cv = useCanvasStore()
  const ws = useWorkspaceStore()
  const { w, h } = cv.containerSize
  const n = ws.artboards.length
  // 容器尺寸未就绪时退化为固定网格，避免画板落到可视区外
  if (!w || !h) return { x: 80 + n * 48, y: 80 + n * 48 }
  const worldCx = (w / 2 - cv.viewport.x) / cv.viewport.zoom
  const worldCy = (h / 2 - cv.viewport.y) / cv.viewport.zoom
  return { x: worldCx - 640 + n * 36, y: Math.max(0, worldCy - 400 + n * 36) }
}

/**
 * @description 把画板上待保存的手动修改落成一块新画板，放在源画板右侧；源画板保留原样。
 * 检查器「保存」和画板头栏「保存」调用。
 * @param boardId - 源画板 id
 * @returns 新画板与新版本；没有待保存修改时返回 null
 */
export async function commitManualEdits(
  boardId: string,
): Promise<{ board: Artboard; version: Version } | null> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const edits = cv.edits[boardId]
  const source = ws.findArtboard(boardId)
  if (!source || !edits || !Object.keys(edits).length) return null
  const current = ws.currentVersionOf(source)
  if (!current) throw new Error('画板还没有版本，无法保存手动修改')
  const count = Object.keys(edits).length
  const target = await ws.createArtboard({
    title: manualBranchTitle(source.title, ws.artboards.map((b) => b.title)),
    width: source.width,
    height: source.height,
    ...branchPosition(source, ws.artboards),
    parent: source.id,
    artifactMode: source.artifactMode,
    capture: source.capture,
  })
  if (source.artifactMode) await ws.setArtifactMode(target.id, source.artifactMode)
  const version = await ws.addVersion(target.id, applyEdits(current.html, edits))
  cv.clearEdits(source.id)
  cv.select(target.id)
  cv.clearInspect()
  cv.requestReveal([source.id, target.id])
  await ws.addMessage({
    artboardId: target.id,
    role: 'assistant',
    content: `已保存手动修改为新画板「${target.title}」（${count} 个元素）`,
    versionId: version.id,
  })
  return { board: target, version }
}

/** 工具栏「新建画板」：创建一块空白画板（之后可在聊天中向它生成） */
export async function createEmptyArtboard(
  input: Partial<NewArtboardInput> = {},
): Promise<Artboard> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const pos =
    input.x !== undefined && input.y !== undefined
      ? { x: input.x, y: input.y }
      : cascadePosition()
  const board = await ws.createArtboard({
    ...input,
    title: input.title ?? `画板 ${ws.artboards.length + 1}`,
    width: input.width ?? defaultTemplate().width,
    height: input.height ?? defaultTemplate().height,
    x: pos.x,
    y: pos.y,
  })
  cv.select(board.id)
  return board
}

async function runGeneration(params: {
  board: Artboard
  prompt: string
  isNew: boolean
  elementContext: ElementContext | null
  /** 是否随本次生成写入一条用户消息 */
  withUserMessage?: boolean
  /** 指定风格指令（来自 AI 规划卡），优先于风格预设 */
  styleOverride?: string
  /** 写入对话流的展示文案（不含附件正文）；缺省用 prompt */
  displayPrompt?: string
  /** 随用户消息展示的参考图 / 资料 */
  attachments?: ChatAttachment[]
  /** 产物类型；缺省沿用画板已有类型 */
  artifactMode?: ArtifactMode
  /** 新画板标题提示：迭代时用用户原话；缺省用源标题 · 改版 */
  titleHint?: string
}) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const { board, prompt, elementContext } = params
  // 以画板实际版本为准，避免调用方传错 isNew 把已有设计稿整页重生成
  const isNew = params.isNew && board.versions.length === 0
  const artifactMode = params.artifactMode ?? board.artifactMode ?? 'page'

  cv.select(board.id)
  if (params.withUserMessage !== false) {
    await ws.addMessage({
      artboardId: board.id,
      role: 'user',
      content: params.displayPrompt ?? prompt,
      elementContext,
      attachments: params.attachments,
      promptText: prompt,
    })
  }

  // 迭代不再在同一块画板里堆版本：先在源画板右侧建一块新画板，流式内容直接画在新画板上。
  const source = board
  const target = isNew
    ? board
    : await ws.createArtboard({
        title: branchTitle(source.title, ws.artboards.map((b) => b.title), params.titleHint ?? prompt),
        width: source.width,
        height: source.height,
        ...branchPosition(source, ws.artboards),
        parent: source.id,
        artifactMode,
        capture: source.capture,
      })
  // 首版生成前确定类型并落盘，画板徽章即时更新；迭代时保持不变
  await ws.setArtifactMode(target.id, artifactMode)
  if (!isNew) {
    cv.select(target.id)
    cv.clearInspect()
    cv.requestReveal([source.id, target.id])
  }
  cv.startGenerating(target.id)
  const ac = new AbortController()
  activeControllers.add(ac)
  let succeeded = false

  try {
    // 迭代沿用源画板的对话上下文；新画板本身还没有消息
    const contextBoardId = isNew ? target.id : source.id
    const recent = ws.messages
      .filter((m) => m.artboardId === contextBoardId && m.role === 'user')
      .slice(-4)
      .map((m) => ({ role: 'user' as const, content: m.content }))

    // 未保存的手动修改直接烘进本次生成的基线，生成成功后从源画板清掉
    const current = isNew ? null : ws.currentVersionOf(source)
    const edits = isNew ? null : cv.edits[source.id]
    const currentHtml = current
      ? edits && Object.keys(edits).length
        ? applyEdits(current.html, edits)
        : current.html
      : undefined

    const result = await generatePrototype({
      provider: st.active,
      isNew,
      artifactMode,
      styleId: params.styleOverride ? undefined : cv.designStyleId,
      styleOverride: params.styleOverride,
      reasoningEffort: cv.deepThink ? 'high' : undefined,
      prompt,
      currentHtml,
      elementContext,
      recent,
      sizeHint: `${target.width}×${target.height}`,
      signal: ac.signal,
      onStreamingHtml: (h) => cv.setStreamingHtml(target.id, h),
    })

    const version = await ws.addVersion(target.id, result.html)
    succeeded = true
    if (!isNew) cv.clearEdits(source.id)
    const tail =
      result.mode === 'diff' ? '（增量）' : result.mode === 'fallback' ? '（回退全量）' : ''
    const noun = artifactMode === 'component' ? '组件' : '原型'
    await ws.addMessage({
      artboardId: target.id,
      role: 'assistant',
      content: isNew
        ? `已生成${noun}`
        : `已根据反馈生成新画板「${target.title}」${tail}`,
      versionId: version.id,
    })
  } catch (err) {
    const e = err as Error
    const aborted = e.name === 'AbortError'
    if (!aborted) {
      retryAction = async () => {
        const b = ws.findArtboard(source.id)
        if (b) {
          await runGeneration({
            ...params,
            board: b,
            isNew: b.versions.length === 0,
            withUserMessage: false,
          })
        }
      }
    }
    await ws.addMessage({
      artboardId: isNew ? target.id : source.id,
      role: 'assistant',
      content: aborted ? '已停止生成。' : `生成失败：${e.message || '未知错误'}`,
      status: aborted ? 'aborted' : 'error',
    })
    if (!aborted) console.error('[generation]', err)
  } finally {
    activeControllers.delete(ac)
    cv.stopGenerating(target.id)
    // 迭代失败/中止：新画板还没有版本，撤掉，选中回到源画板
    if (!isNew && !succeeded) {
      const still = ws.findArtboard(target.id)
      if (still && still.versions.length === 0) {
        await ws.removeArtboard(target.id)
        if (cv.selectedArtboardId === target.id) cv.select(source.id)
      }
    }
  }
}

export interface SendPromptOptions {
  /** 写进对话流的展示文案；附件正文只进入生成提示词，不污染气泡 */
  displayText?: string
  /** 随用户消息展示的参考图 / 资料 */
  attachments?: ChatAttachment[]
  /** 输入卡元素标签携带的点选上下文：反馈只作用于该元素，跳过意图确认直接生成 */
  elementContext?: ElementContext | null
}

/**
 * 聊天面板发送指令：
 * - 带 elementContext：定向元素反馈，直接增量生成（实时画板交给本机 Agent）
 * - variantCount = 1：选中空画板 → 首个版本；选中已有版本 → 迭代；无选中 → 新建画板
 * - variantCount > 1：忽略已有版本的画板，并排出 N 个方案（选中的空画板作为方案 A）
 */
export async function sendPrompt(text: string, variantCount = 1, options: SendPromptOptions = {}) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const trimmed = text.trim()
  if (!trimmed || cv.busy) return
  const displayText = options.displayText?.trim() || trimmed
  const attachments = options.attachments
  const elementCtx = options.elementContext ?? null

  // 实时画板：对话直接交给本机 Agent 改仓库代码（网页实时画板没有源码，先捕获为设计稿）
  const selectedBoard = ws.findArtboard(cv.selectedArtboardId)
  if (selectedBoard?.kind === 'live') {
    await sendLiveFeedback(selectedBoard, elementCtx, trimmed, { displayText, attachments })
    return
  }

  // 元素定向反馈：只改选中的元素，跳过意图确认，直接增量生成
  if (elementCtx) {
    const board = selectedBoard
    if (!board || board.versions.length === 0) return
    await runGeneration({ board, prompt: trimmed, isNew: false, elementContext: elementCtx, displayPrompt: displayText, attachments })
    return
  }

  if (variantCount <= 1) {
    let board = ws.findArtboard(cv.selectedArtboardId)
    if (board && board.versions.length > 0) {
      // 长指令先确认意图：AI 拆解执行项清单，用户确认后执行
      const complex = trimmed.length > 48 || (trimmed.match(/[，；]/g) ?? []).length >= 2
      if (complex && board) {
        const b: Artboard = board
        cv.select(b.id)
        await commitManualEdits(b.id)
        await ws.addMessage({
          artboardId: b.id,
          role: 'user',
          content: displayText,
          attachments,
          promptText: trimmed,
        })
        cv.startGenerating(b.id)
        const ac = new AbortController()
        activeControllers.add(ac)
        try {
          const cur = ws.currentVersionOf(b)
          const pending = cv.edits[b.id]
          const currentHtml = cur
            ? pending && Object.keys(pending).length
              ? applyEdits(cur.html, pending)
              : cur.html
            : ''
          const plan = await planIteration({
            provider: st.active,
            prompt: trimmed,
            currentHtml,
            reasoningEffort: cv.deepThink ? 'high' : undefined,
            signal: ac.signal,
          })
          cv.stopGenerating(board.id)
          await ws.addMessage({
            artboardId: board.id,
            role: 'assistant',
            content: '我把这条指令拆解成了执行项，确认后我就动手。',
            plan,
          })
        } catch (err) {
          cv.stopGenerating(board.id)
          const aborted = (err as Error).name === 'AbortError'
          if (aborted) {
            await ws.addMessage({ artboardId: b.id, role: 'assistant', content: '已停止。', status: 'aborted' })
            return
          }
          console.warn('[plan-iteration] 确认失败，直接生成', err)
          await runGeneration({
            board,
            prompt: trimmed,
            isNew: false,
            elementContext: null,
            displayPrompt: displayText,
            attachments,
            withUserMessage: false,
          })
        } finally {
          activeControllers.delete(ac)
        }
        return
      }
      await runGeneration({
        board,
        prompt: trimmed,
        isNew: false,
        elementContext: null,
        displayPrompt: displayText,
        attachments,
      })
      return
    }
    if (!board) {
      board = await createEmptyArtboard({ title: displayText.slice(0, 16) })
    }
    cv.select(board.id)
    await ws.addMessage({
      artboardId: board.id,
      role: 'user',
      content: displayText,
      attachments,
      promptText: trimmed,
    })

    // —— v0 式规划：AI 先在对话流里提问 + 给风格方向，用户点选后才生成 ——
    cv.startGenerating(board.id)
    const ac = new AbortController()
    activeControllers.add(ac)
    try {
      const plan = await planPrototype({
        provider: st.active,
        prompt: trimmed,
        reasoningEffort: cv.deepThink ? 'high' : undefined,
        signal: ac.signal,
      })
      cv.stopGenerating(board.id)
      await ws.addMessage({
        artboardId: board.id,
        role: 'assistant',
        content: plan.questions.length
          ? '先对齐几个问题，再挑一个风格方向，我就开始生成。'
          : '挑一个风格方向，我就按它开始生成。',
        plan,
      })
    } catch (err) {
      const e = err as Error
      const aborted = e.name === 'AbortError'
      cv.stopGenerating(board.id)
      if (aborted) {
        await ws.addMessage({ artboardId: board.id, role: 'assistant', content: '已停止规划。', status: 'aborted' })
        return
      }
      // 规划失败：能判断类型就直接生成；判断不了只让用户选类型，不静默猜 page
      console.warn('[plan] 规划失败，回退直接生成', err)
      const inferred = inferArtifactMode(trimmed)
      if (inferred) {
        await runGeneration({ board, prompt: trimmed, isNew: true, elementContext: null, artifactMode: inferred, withUserMessage: false })
      } else {
        await ws.addMessage({
          artboardId: board.id,
          role: 'assistant',
          content: '先确认一下这次要生成什么，我再开始。',
          plan: { questions: [makeArtifactModeQuestion()], styles: [], artifactMode: 'ambiguous' },
        })
      }
    } finally {
      activeControllers.delete(ac)
      cv.stopGenerating(board.id)
    }
    return
  }

  // —— 多方案并行 ——
  const n = Math.min(3, variantCount)
  const selected = ws.findArtboard(cv.selectedArtboardId)
  const baseTitle = displayText.slice(0, 12)
  const first =
    selected && selected.versions.length === 0
      ? selected
      : await createEmptyArtboard({ title: `${baseTitle} · ${VARIANT_SUFFIX[0]}` })
  cv.select(first.id)

  const boards: Artboard[] = [first]
  for (let i = 1; i < n; i++) {
    boards.push(
      await createEmptyArtboard({
        title: `${baseTitle} · ${VARIANT_SUFFIX[i]}`,
        x: first.x + i * (first.width + 60),
        y: first.y,
        parent: first.id,
      }),
    )
  }

  // 多方案方向来自 AI 规划（失败回退内置提示），并以信息卡形式展示在对话流
  let directions = VARIANT_HINT.slice(0, n - 1)
  let planCard: PlanPayload | null = null
  let artifactMode: ArtifactMode = resolveArtifactMode({
    boardMode: selected?.artifactMode,
    fallback: inferArtifactMode(trimmed) ?? 'page',
  })
  cv.startGenerating(first.id)
  const planAc = new AbortController()
  activeControllers.add(planAc)
  try {
    const plan = await planPrototype({ provider: st.active, prompt: trimmed, signal: planAc.signal })
    artifactMode = resolveArtifactMode({
      planMode: plan.artifactMode,
      boardMode: selected?.artifactMode,
      fallback: inferArtifactMode(trimmed) ?? 'page',
    })
    if (plan.styles.length) {
      const chosen = plan.styles.slice(0, n)
      directions = chosen.map((s2) => `采用「${s2.name}」方向：\n${s2.directive}`)
      planCard = {
        questions: [],
        styles: chosen,
        info: true,
        title: `已按 AI 规划的 ${chosen.length} 个方向并排生成`,
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') console.warn('[plan-variants] 规划失败，回退内置方向', err)
  } finally {
    activeControllers.delete(planAc)
    cv.stopGenerating(first.id)
  }

  await Promise.all(
    boards.map((board, i) =>
      runGeneration({
        board,
        prompt: i === 0 ? trimmed : `${trimmed}\n\n设计方向提示：${directions[i - 1] ?? VARIANT_HINT[i % VARIANT_HINT.length]}`,
        isNew: true,
        elementContext: null,
        artifactMode,
        withUserMessage: i === 0,
        displayPrompt: i === 0 ? displayText : undefined,
        attachments: i === 0 ? attachments : undefined,
      }),
    ),
  )

  if (planCard) {
    await ws.addMessage({
      artboardId: first.id,
      role: 'assistant',
      content: planCard.title ?? '',
      plan: planCard,
    })
  }
}

/** 用户在规划卡上点选完毕：带着澄清答案与选定风格开始生成。 */
export async function startFromPlan(params: {
  boardId: string
  originalPrompt: string
  plan: PlanPayload
  answers?: Record<string, string>
  style?: PlanStyle | null
  /** 对话流展示文案（不含附件正文）；缺省显示完整提示词 */
  displayPrompt?: string
  /** 随用户消息展示的参考图 / 资料 */
  attachments?: ChatAttachment[]
}) {
  const cv = useCanvasStore()
  const ws = useWorkspaceStore()
  const board = ws.findArtboard(params.boardId)
  if (!board || cv.busy) return

  const isNew = board.versions.length === 0
  // 迭代确认卡沿用画板类型；新画板按「用户答案 → 规划判断 → 画板既有类型」决定
  const artifactMode: ArtifactMode = isNew
    ? resolveArtifactMode({
        answer: params.answers?.[ARTIFACT_MODE_QUESTION_ID],
        planMode: params.plan.artifactMode,
        boardMode: board.artifactMode,
      })
    : (board.artifactMode ?? 'page')

  // 用问题原文做标签，比 qid 更能让模型理解答案含义
  const answerLines = params.plan.questions
    .map((q) => {
      const a = params.answers?.[q.id]?.trim()
      return a ? `- ${q.q}：${a}` : ''
    })
    .filter(Boolean)
    .join('\n')
  const enhanced = [
    `【产物类型】${artifactModePromptLabel(artifactMode)}`,
    params.originalPrompt,
    params.plan.items?.length
      ? `【执行项清单】\n${params.plan.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
      : '',
    answerLines ? `【已确认的设计决策】\n${answerLines}` : '',
    params.style ? `【选定风格】\n${params.style.directive}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  await ws.setArtifactMode(board.id, artifactMode)
  await runGeneration({
    board,
    prompt: enhanced,
    isNew,
    artifactMode,
    elementContext: null,
    styleOverride: params.style?.directive,
    withUserMessage: false,
    titleHint: params.originalPrompt,
  })
}

/** 规划卡「换一批」：AI 重新设计一组澄清问题与风格方案，原地替换托盘内容 */
export async function replan(
  boardId: string,
  planMessageId: string,
  originalPrompt: string,
): Promise<PlanPayload | null> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const board = ws.findArtboard(boardId)
  const msg = ws.messages.find((m) => m.id === planMessageId)
  if (!board || !msg?.plan || cv.busy) return null

  cv.startGenerating(board.id)
  const ac = new AbortController()
  activeControllers.add(ac)
  try {
    const plan = await planPrototype({
      provider: st.active,
      prompt: originalPrompt,
      reasoningEffort: cv.deepThink ? 'high' : undefined,
      signal: ac.signal,
    })
    cv.stopGenerating(board.id)
    await ws.updateMessage(planMessageId, { plan })
    return plan
  } catch (err) {
    cv.stopGenerating(board.id)
    const aborted = (err as Error).name === 'AbortError'
    if (!aborted) console.warn('[replan] 换一批失败，保留原方案', err)
    return null
  } finally {
    activeControllers.delete(ac)
  }
}

// —— 本机 Agent 改代码：实时画板反馈 / 设计稿写回 ——

const CODE_AGENT_PROMPT = `你正在用户的前端项目仓库里工作。用户在一个可视化设计画布上查看这个项目的实时页面：dev server 已经在运行，保存文件后页面会热更新。
要求：
- 按用户的设计要求直接修改源码；改动尽量小，遵循项目现有的组件结构、样式方案（CSS / Tailwind / CSS-in-JS 等）和代码风格。
- 不要启动、重启或停止 dev server，不要安装新依赖，不要提交 git。
- 完成后用 2-4 句中文说明改了哪些文件、做了什么。`

/** 进度消息里最多保留的工具调用行数 */
const MAX_TOOL_LINES = 12

/**
 * @description 生成「去掉仓库目录前缀」的函数，工具调用里的绝对路径显示成仓库内相对路径（两种斜杠都处理）。
 * @param repoDir - 仓库目录
 * @returns 把文本里的仓库前缀去掉的函数
 */
function relativeTo(repoDir: string): (text: string) => string {
  const dir = repoDir.replace(/[\\/]+$/, '')
  const prefixes = [dir.replace(/\//g, '\\') + '\\', dir.replace(/\\/g, '/') + '/']
  return (text) => prefixes.reduce((s, p) => s.split(p).join(''), text)
}

/**
 * @description 让本机 Agent（Claude Code / Codex）在仓库里改代码，工具调用与回答实时写进一条 assistant 消息，
 * 可被聊天面板的「停止」中止。当前模型不是本机 Agent 时给出可重试的配置提示。
 * @param params.boardId - 消息归属的画板
 * @param params.repoDir - 仓库目录（Agent 工作目录）
 * @param params.userText - 显示在对话流里的用户原话
 * @param params.prompt - 实际发给 Agent 的完整指令
 * @param params.elementContext - 用户点选的元素（可选）
 * @param params.attachments - 随用户消息展示的参考图 / 资料（可选）
 */
export async function runCodeAgent(params: {
  boardId: string
  repoDir: string
  userText: string
  prompt: string
  elementContext?: ElementContext | null
  attachments?: ChatAttachment[]
}): Promise<void> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const provider = useSettingsStore().active
  if (cv.busy) return
  const { boardId } = params
  await ws.addMessage({
    artboardId: boardId,
    role: 'user',
    content: params.userText,
    elementContext: params.elementContext ?? null,
    attachments: params.attachments,
    promptText: params.prompt,
  })
  if (!provider || !isAgentProvider(provider)) {
    retryAction = () => runCodeAgent(params)
    await ws.addMessage({
      artboardId: boardId,
      role: 'assistant',
      status: 'error',
      content: !provider
        ? '还没有配置模型：请到「设置 → 模型设置」配置并选择服务商，然后重试。'
        : '改代码需要本机 Agent：请在「设置 → 模型设置」添加 Claude Code 或 Codex，并在下方模型选择里切换过去，然后重试。',
    })
    return
  }

  const working = `${provider.name} 正在修改代码…`
  const msg = await ws.addMessage({ artboardId: boardId, role: 'assistant', content: working })
  const ac = new AbortController()
  activeControllers.add(ac)
  cv.agentRun = { boardId, messageId: msg.id }
  const tools: string[] = []
  const rel = relativeTo(params.repoDir)
  let answer = ''
  const render = () => {
    const shown = tools.slice(-MAX_TOOL_LINES).map((t) => `› ${t}`)
    if (tools.length > MAX_TOOL_LINES) shown.unshift(`… 共 ${tools.length} 步`)
    return [shown.join('\n'), answer.trim()].filter(Boolean).join('\n\n') || working
  }
  // 进度写库节流：工具事件可能很密
  let timer: number | null = null
  const schedule = () => {
    timer ??= window.setTimeout(() => {
      timer = null
      void ws.updateMessage(msg.id, { content: render() })
    }, 300)
  }

  try {
    for await (const delta of streamAgent({
      kind: provider.kind,
      model: provider.model,
      mode: 'code',
      cwd: params.repoDir,
      systemPrompt: CODE_AGENT_PROMPT,
      prompt: params.prompt,
      signal: ac.signal,
      onEvent: (e) => {
        if (e.type === 'tool') {
          tools.push(rel(e.text))
          schedule()
        }
      },
    })) {
      answer += delta
      schedule()
    }
    if (timer !== null) window.clearTimeout(timer)
    await ws.updateMessage(msg.id, { content: render() })
  } catch (err) {
    if (timer !== null) window.clearTimeout(timer)
    const e = err as Error
    if (e.name === 'AbortError') {
      await ws.updateMessage(msg.id, { content: `已停止。\n\n${render()}`, status: 'aborted' })
    } else {
      retryAction = () => runCodeAgent(params)
      await ws.updateMessage(msg.id, { content: `改代码失败：${e.message}`, status: 'error' })
      console.error('[code-agent]', err)
    }
  } finally {
    activeControllers.delete(ac)
    cv.agentRun = null
  }
}

/**
 * @description 实时画板上的反馈：点选元素（或直接在对话里描述）后交给本机 Agent 改仓库源码。
 * 网页实时画板没有源码，提示先捕获为设计稿。
 * @param board - 实时画板
 * @param ctx - 点选的元素；对话直接描述时为 null
 * @param text - 修改要求
 * @param options - 对话流展示文案与随消息附带的参考图 / 资料
 */
export async function sendLiveFeedback(
  board: Artboard,
  ctx: ElementContext | null,
  text: string,
  options: SendPromptOptions = {},
): Promise<void> {
  const live = board.live
  if (!live) return
  const displayText = options.displayText?.trim() || text
  if (live.type !== 'repo' || !live.repoDir) {
    const ws = useWorkspaceStore()
    await ws.addMessage({
      artboardId: board.id,
      role: 'user',
      content: displayText,
      elementContext: ctx,
      attachments: options.attachments,
      promptText: text,
    })
    await ws.addMessage({
      artboardId: board.id,
      role: 'assistant',
      content: '这是网页实时画板，没有可修改的源码。先在画板头栏点「捕获」生成设计稿，再在设计稿上让 AI 迭代或手动编辑。',
    })
    return
  }
  const parts = [`【页面路由】${live.route}`]
  if (ctx) parts.push('', '【用户在实时页面上选中的元素】', describeElement(ctx))
  parts.push('', '【修改要求】', text, '', ctx ? '请在源码中找到渲染该元素的组件，按要求修改。' : '请按要求修改这个页面的源码。')
  await runCodeAgent({
    boardId: board.id,
    repoDir: live.repoDir,
    userText: displayText,
    prompt: parts.join('\n'),
    elementContext: ctx,
    attachments: options.attachments,
  })
}

/**
 * @description 从期望位置起找一块不与已有画板重叠的空位：撞上就移到那块画板下方继续找。
 * @param x - 期望 x（保持不变）
 * @param y - 期望 y
 * @param w - 新画板宽
 * @param h - 新画板高
 * @returns 可放置的坐标
 */
function freeSpot(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return findFreeSpot(x, y, w, h, useWorkspaceStore().artboards)
}

/**
 * @description 把实时画板的当前页面捕获为可编辑的设计稿画板（放在右侧）。快照里的资源地址指向代理源，
 * 换回真实源（dev server / 网站），代理关掉后图片和字体仍能加载。
 * @param board - 实时画板
 * @param snap - bridge 序列化出的页面
 * @param origins - 本次会话的代理源与真实源
 * @returns 新建的设计稿画板
 */
export async function captureLiveBoard(
  board: Artboard,
  snap: { html: string; title: string },
  origins: { proxyOrigin: string; targetOrigin: string },
): Promise<Artboard> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const live = board.live!
  const html = snap.html.split(origins.proxyOrigin).join(origins.targetOrigin)
  const design = await ws.createArtboard({
    title: `${snap.title || board.title} · 设计稿`.slice(0, 40),
    width: board.width,
    height: board.height,
    ...freeSpot(board.x + board.width + 80, board.y, board.width, board.height),
    parent: board.id,
    artifactMode: 'page',
    capture: {
      boardId: board.id,
      repoDir: live.type === 'repo' ? live.repoDir : undefined,
      route: live.route,
      url: origins.targetOrigin + live.route,
    },
  })
  const version = await ws.addVersion(design.id, html)
  await ws.addMessage({
    artboardId: design.id,
    role: 'assistant',
    versionId: version.id,
    content:
      `已把「${live.route}」捕获为设计稿 v1：可以让 AI 迭代或用 ✎ 手动编辑` +
      (live.type === 'repo' ? '，满意后在画板菜单选「写回代码」。' : '。'),
  })
  cv.select(design.id)
  return design
}

/** 写回代码时附带的设计稿 HTML 上限（去掉内联样式后），避免提示词过长 */
const MAX_REFERENCE_HTML = 40_000

/**
 * @description 设计稿写回代码：先把手动修改存成新画板，再把「捕获基线 → 当前分支」的改动清单
 * 连同当前设计稿结构交给本机 Agent，在仓库里实现。
 * @param boardId - 设计稿画板（捕获画板本身，或由它迭代/手动保存出的分支）
 * @returns 没有可写回的改动时抛错，调用方提示用户
 */
export async function writeBackToCode(boardId: string): Promise<void> {
  const ws = useWorkspaceStore()
  const board = ws.findArtboard(boardId)
  if (!board) throw new Error('画板不存在')
  // 扁平分支可能让「写回代码」作用在子画板上；改动基线始终是最上层的捕获画板
  const origin = captureRootOf(board, (id) => ws.findArtboard(id) ?? undefined)
  const capture = origin?.capture
  if (!origin || !capture?.repoDir) throw new Error('这块画板不是从代码仓库捕获的设计稿')
  const saved = await commitManualEdits(boardId)
  const currentBoard = saved?.board ?? board
  const base = origin.versions[0]
  const current = ws.currentVersionOf(currentBoard)
  const changes = base && current && base.id !== current.id ? describeChanges(base.html, current.html) : ''
  if (!changes) throw new Error('设计稿相对捕获时还没有改动')
  const doc = new DOMParser().parseFromString(current!.html, 'text/html')
  doc.querySelectorAll('style, script').forEach((el) => el.remove())
  const reference = doc.body.outerHTML.slice(0, MAX_REFERENCE_HTML)
  const prompt = [
    `【页面路由】${capture.route}`,
    '用户把这个页面捕获到设计画布上，经过 AI 迭代和手动调整，得到了新的设计稿。下面是设计稿相对捕获时的改动（选择器路径基于捕获时的 DOM）：',
    changes,
    '',
    '【当前设计稿的页面结构（已去掉内联样式表，仅供理解目标效果，不要整份照搬）】',
    reference,
    '',
    '请把这些设计改动实现到项目源码中，保持现有组件结构与样式方案。',
  ].join('\n')
  await runCodeAgent({
    boardId: currentBoard.id,
    repoDir: capture.repoDir,
    userText: `把设计稿 v${currentBoard.versions.findIndex((v) => v.id === current!.id) + 1} 的改动写回代码`,
    prompt,
  })
}
