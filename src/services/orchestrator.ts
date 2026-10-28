import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore, type NewArtboardInput } from '@/stores/workspace'
import type { Artboard, ElementContext, PlanPayload, PlanStyle } from '@/types'
import { generatePrototype } from './generator'
import { planIteration, planPrototype } from './planner'
import { pluginRegistry } from '@/plugins/registry'
import type { TemplatePluginData } from '@/plugins/types'

const activeControllers = new Set<AbortController>()

interface FailedRequest {
  boardId: string
  prompt: string
  isNew: boolean
  elementContext: ElementContext | null
}

/** 最近一次失败请求，供「重试」使用 */
let lastFailed: FailedRequest | null = null

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
  return useCanvasStore().generating.length > 0
}

export function stopGeneration() {
  activeControllers.forEach((c) => c.abort())
}

export async function retryLast() {
  const cv = useCanvasStore()
  if (!lastFailed || cv.generating.length > 0) return
  const board = useWorkspaceStore().findArtboard(lastFailed.boardId)
  if (!board) {
    lastFailed = null
    return
  }
  const { prompt, isNew, elementContext } = lastFailed
  lastFailed = null
  await runGeneration({ board, prompt, isNew, elementContext })
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
      lastFailed = { boardId: board.id, prompt, isNew, elementContext }
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
  if (!trimmed || cv.generating.length > 0) return

  if (variantCount <= 1) {
    let board = ws.findArtboard(cv.selectedArtboardId)
    if (board && board.versions.length > 0) {
      // 长指令先确认意图：AI 拆解执行项清单，用户确认后执行
      const complex = trimmed.length > 48 || (trimmed.match(/[，；]/g) ?? []).length >= 2
      if (complex && board) {
        const b: Artboard = board
        cv.select(b.id)
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
  if (!board || cv.generating.length > 0) return

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
  if (!board || !msg?.plan || cv.generating.length > 0) return

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
  if (!trimmed || cv.generating.length > 0) return
  const board = ws.findArtboard(cv.selectedArtboardId)
  if (!board || board.versions.length === 0) return
  await runGeneration({ board, prompt: trimmed, isNew: false, elementContext: ctx })
}
