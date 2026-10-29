import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore, type NewArtboardInput } from '@/stores/workspace'
import type { Artboard, ElementContext, PlanPayload, PlanStyle, Version } from '@/types'
import { applyEdits } from '@/utils/editable'
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
 * @description 把画板上待保存的手动修改落成一个新版本。检查器「保存」调用；AI 迭代前也会自动调用，
 * 因为 AI 总是基于当前版本源码修改，不先落盘的话手动修改会被 AI 结果覆盖丢失。
 * @param boardId - 画板 id
 * @returns 新版本；没有待保存修改时返回 null
 */
export async function commitManualEdits(boardId: string): Promise<Version | null> {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const edits = cv.edits[boardId]
  const board = ws.findArtboard(boardId)
  if (!board || !edits || !Object.keys(edits).length) return null
  const current = ws.currentVersionOf(board)
  if (!current) throw new Error('画板还没有版本，无法保存手动修改')
  const count = Object.keys(edits).length
  const version = await ws.addVersion(boardId, applyEdits(current.html, edits))
  // 先落新版本再清修改：iframe 换成已含修改的新版本时不会闪回旧样式
  cv.clearEdits(boardId)
  await ws.addMessage({
    artboardId: boardId,
    role: 'assistant',
    content: `已保存手动编辑（${count} 个元素）为 v${board.versions.length}`,
    versionId: version.id,
  })
  return version
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
  /** 多方案时传入方案序号（演示配色区分）；缺省按画板版本推算 */
  demoSeed?: number
  /** 是否随本次生成写入一条用户消息（多方案时仅首块画板写） */
  withUserMessage?: boolean
  /** 指定风格指令（来自 AI 规划卡），优先于风格预设 */
  styleOverride?: string
}) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const { board, prompt, isNew, elementContext } = params
  // 新建时用方案序号区分演示配色；迭代时不传，由 generator 从当前版本推导
  const demoSeed = params.demoSeed ?? (isNew ? 0 : undefined)

  cv.select(board.id)
  if (params.withUserMessage !== false) {
    await ws.addMessage({
      artboardId: board.id,
      role: 'user',
      content: prompt,
      elementContext,
    })
  }

  if (!isNew) await commitManualEdits(board.id)
  cv.startGenerating(board.id)
  const ac = new AbortController()
  activeControllers.add(ac)

  try {
    const recent = ws.messages
      .filter((m) => m.artboardId === board.id && m.role === 'user')
      .slice(-4)
      .map((m) => ({ role: 'user' as const, content: m.content }))

    const currentHtml = isNew
      ? undefined
      : (board.versions.find((v) => v.id === board.currentVersionId)?.html ?? undefined)

    const result = await generatePrototype({
      provider: st.active,
      isNew,
      styleId: params.styleOverride ? undefined : cv.designStyleId,
      styleOverride: params.styleOverride,
      reasoningEffort: cv.deepThink ? 'high' : undefined,
      prompt,
      currentHtml,
      elementContext,
      recent,
      sizeHint: `${board.width}×${board.height}`,
      demoSeed,
      signal: ac.signal,
      onStreamingHtml: (h) => cv.setStreamingHtml(board.id, h),
    })

    const version = await ws.addVersion(board.id, result.html, { demoSeed: result.demoSeed })
    const idx = board.versions.findIndex((v) => v.id === version.id)
    const tail =
      result.mode === 'diff' ? '（增量）' : result.mode === 'fallback' ? '（回退全量）' : ''
    await ws.addMessage({
      artboardId: board.id,
      role: 'assistant',
      content: isNew ? `已生成原型 v${idx + 1}` : `已按反馈更新至 v${idx + 1}${tail}`,
      versionId: version.id,
    })
  } catch (err) {
    const e = err as Error
    const aborted = e.name === 'AbortError'
    if (!aborted) {
      retryAction = async () => {
        const b = ws.findArtboard(board.id)
        if (b) await runGeneration({ board: b, prompt, isNew, elementContext })
      }
    }
    await ws.addMessage({
      artboardId: board.id,
      role: 'assistant',
      content: aborted ? '已停止生成。' : `生成失败：${e.message || '未知错误'}`,
      status: aborted ? 'aborted' : 'error',
    })
    if (!aborted) console.error('[generation]', err)
  } finally {
    activeControllers.delete(ac)
    cv.stopGenerating(board.id)
  }
}

/**
 * 聊天面板发送指令：
 * - variantCount = 1：选中空画板 → 首个版本；选中已有版本 → 迭代；无选中 → 新建画板
 * - variantCount > 1：忽略已有版本的画板，并排出 N 个方案（选中的空画板作为方案 A）
 */
export async function sendPrompt(text: string, variantCount = 1) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const trimmed = text.trim()
  if (!trimmed || cv.busy) return

  // 实时画板：对话直接交给本机 Agent 改仓库代码（网页实时画板没有源码，先捕获为设计稿）
  const selectedBoard = ws.findArtboard(cv.selectedArtboardId)
  if (selectedBoard?.kind === 'live') {
    await sendLiveFeedback(selectedBoard, null, trimmed)
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
        await ws.addMessage({ artboardId: b.id, role: 'user', content: trimmed })
        cv.startGenerating(b.id)
        const ac = new AbortController()
        activeControllers.add(ac)
        try {
          const currentHtml = b.versions.find((v) => v.id === b.currentVersionId)?.html ?? ''
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
          await runGeneration({ board, prompt: trimmed, isNew: false, elementContext: null })
        } finally {
          activeControllers.delete(ac)
        }
        return
      }
      await runGeneration({ board, prompt: trimmed, isNew: false, elementContext: null })
      return
    }
    if (!board) {
      board = await createEmptyArtboard({ title: trimmed.slice(0, 16) })
    }
    cv.select(board.id)
    await ws.addMessage({ artboardId: board.id, role: 'user', content: trimmed })

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
      // 规划失败：回退为直接生成，不让用户卡在流程里
      console.warn('[plan] 规划失败，回退直接生成', err)
      await runGeneration({ board, prompt: trimmed, isNew: true, elementContext: null })
    } finally {
      activeControllers.delete(ac)
      cv.stopGenerating(board.id)
    }
    return
  }

  // —— 多方案并行 ——
  const n = Math.min(3, variantCount)
  const selected = ws.findArtboard(cv.selectedArtboardId)
  const baseTitle = trimmed.slice(0, 12)
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
  cv.startGenerating(first.id)
  const planAc = new AbortController()
  activeControllers.add(planAc)
  try {
    const plan = await planPrototype({ provider: st.active, prompt: trimmed, signal: planAc.signal })
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
        demoSeed: i,
        withUserMessage: i === 0,
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
  answers?: Record<string, string>
  style?: PlanStyle | null
  items?: string[]
}) {
  const cv = useCanvasStore()
  const ws = useWorkspaceStore()
  const board = ws.findArtboard(params.boardId)
  if (!board || cv.busy) return

  const answerLines = Object.entries(params.answers ?? {})
    .map(([q, a]) => `- ${q}：${a}`)
    .join('\n')
  const enhanced = [
    params.originalPrompt,
    params.items?.length
      ? `【执行项清单】\n${params.items.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
      : '',
    answerLines ? `【已确认的设计决策】\n${answerLines}` : '',
    params.style ? `【选定风格】\n${params.style.directive}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')

  await runGeneration({
    board,
    prompt: enhanced,
    isNew: true,
    elementContext: null,
    styleOverride: params.style?.directive,
  })
}

/** 规划卡「换一批」：AI 重新设计一组澄清问题与风格方案，原地替换托盘内容 */
export async function replan(boardId: string, planMessageId: string, originalPrompt: string) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const st = useSettingsStore()
  const board = ws.findArtboard(boardId)
  const msg = ws.messages.find((m) => m.id === planMessageId)
  if (!board || !msg?.plan || cv.busy) return

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
  } catch (err) {
    cv.stopGenerating(board.id)
    const aborted = (err as Error).name === 'AbortError'
    if (!aborted) console.warn('[replan] 换一批失败，保留原方案', err)
  } finally {
    activeControllers.delete(ac)
  }
}

/** 画布上点选元素后的定向反馈 */
export async function sendElementFeedback(ctx: ElementContext, text: string) {
  const ws = useWorkspaceStore()
  const cv = useCanvasStore()
  const trimmed = text.trim()
  if (!trimmed || cv.busy) return
  const board = ws.findArtboard(cv.selectedArtboardId)
  if (!board || board.versions.length === 0) return
  await runGeneration({ board, prompt: trimmed, isNew: false, elementContext: ctx })
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
 */
export async function runCodeAgent(params: {
  boardId: string
  repoDir: string
  userText: string
  prompt: string
  elementContext?: ElementContext | null
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
  })
  if (!isAgentProvider(provider)) {
    retryAction = () => runCodeAgent(params)
    await ws.addMessage({
      artboardId: boardId,
      role: 'assistant',
      status: 'error',
      content: '改代码需要本机 Agent：请在「设置 → 模型设置」添加 Claude Code 或 Codex，并在下方模型选择里切换过去，然后重试。',
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
 */
export async function sendLiveFeedback(board: Artboard, ctx: ElementContext | null, text: string): Promise<void> {
  const live = board.live
  if (!live) return
  if (live.type !== 'repo' || !live.repoDir) {
    const ws = useWorkspaceStore()
    await ws.addMessage({ artboardId: board.id, role: 'user', content: text, elementContext: ctx })
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
  await runCodeAgent({ boardId: board.id, repoDir: live.repoDir, userText: text, prompt: parts.join('\n'), elementContext: ctx })
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
  const GAP = 48
  const boards = useWorkspaceStore().artboards
  let top = y
  for (;;) {
    const hit = boards.find(
      (b) => x < b.x + b.width + GAP && x + w + GAP > b.x && top < b.y + b.height + GAP && top + h + GAP > b.y,
    )
    if (!hit) return { x, y: top }
    top = hit.y + hit.height + GAP
  }
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
 * @description 设计稿写回代码：先保存未保存的手动修改，再把「捕获基线 v1 → 当前版本」的改动清单
 * 连同当前设计稿结构交给本机 Agent，在仓库里实现。
 * @param boardId - 设计稿画板（由实时仓库画板捕获而来）
 * @returns 没有可写回的改动时抛错，调用方提示用户
 */
export async function writeBackToCode(boardId: string): Promise<void> {
  const ws = useWorkspaceStore()
  const board = ws.findArtboard(boardId)
  const capture = board?.capture
  if (!board || !capture?.repoDir) throw new Error('这块画板不是从代码仓库捕获的设计稿')
  await commitManualEdits(boardId)
  const base = board.versions[0]
  const current = ws.currentVersionOf(board)
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
    boardId,
    repoDir: capture.repoDir,
    userText: `把设计稿 v${board.versions.findIndex((v) => v.id === current!.id) + 1} 的改动写回代码`,
    prompt,
  })
}
