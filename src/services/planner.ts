import type { PlanPayload, PlanQuestion, ProviderConfig } from '@/types'
import { inferArtifactMode, isArtifactModeQuestion, looksLikeArtifactModeQuestion, makeArtifactModeQuestion, normalizePlannedMode } from '@/utils/artifactMode'
import { streamCompletion } from './llm'

export interface PlanOptions {
  provider: ProviderConfig | null
  prompt: string
  reasoningEffort?: string
  signal: AbortSignal
}

const PLANNER_PROMPT = `你是 v0 式的设计助理。用户会给你一个设计需求，你做三件事：

1. 先判断最终交付物类型，输出 mode：
   - "page"：整页原型（网页、官网、落地页、后台、仪表盘、详情页等完整页面）。
   - "component"：单个 UI 组件的视觉设计稿（按钮、输入框、卡片、弹窗、表格、导航栏、表单、下拉、标签页等单个控件或紧密相关的一组控件），用户要的是组件本身，不是把它拼成一个页面。
   - "ambiguous"：确实无法判断。
   判断口径：以「最终交付给用户的东西」为准。整页需求即使里面出现按钮、卡片等词，也算 page；「只要一个搜索框」「做一个登录表单组件」算 component。拿不准时输出 ambiguous，不要硬猜。
2. 提出最多 2 个有助于明确设计方向的澄清问题（需求已足够明确时可以不出题）。每个问题恰好 3 个具体、互斥的选项；用户可以自由输入其他答案，所以不要给「其他」「自定义」这类选项。
   - component：优先问状态覆盖（只做默认态 / 含 hover·focus·disabled / 含加载与错误态）、尺寸与变体（单尺寸 / S·M·L / 主按钮与次按钮 · 危险态）、使用场景与密度（后台工具 / 消费产品 / 营销页）。
   - page：优先问信息架构、内容密度、目标人群等页面方向。
   不要自己输出「整页原型还是单个组件」的二选一问题，应用会统一补充类型选择。
3. 设计 3 个截然不同的视觉风格方案。每个方案包含：name（风格名，4-8 字，有记忆点）、desc（一句话气质描述）、directive（完整风格指令，4-6 条，每条一行以 - 开头，必须给出确切色值 hex、字体栈、构图手法，最后一条以「- 禁止：」开头列 2-3 条不允许的东西）。组件的 directive 要给组件级令牌（高度、内边距、圆角、描边、字重、hover / focus / disabled 态），不要写英雄区、页脚、导航等页面级内容。

只输出一个 JSON 对象，不要任何解释或代码围栏：
{
  "mode": "page | component | ambiguous",
  "questions": [{ "id": "tone", "q": "问题", "options": ["a", "b", "c"] }],
  "styles": [{ "name": "风格名", "desc": "一句话", "directive": "【设计风格：…】\\n- …\\n- 禁止：…" }]
}

要求：questions 可以为空数组；styles 恰好 3 个且方向差异明显。`

const ITERATION_PROMPT = `你是设计执行助理。用户会对现有设计稿（可能是一个页面原型，也可能是一个 UI 组件）提出一条修改指令。你的任务是把这条指令拆解为清晰、无歧义的执行项清单，向用户确认理解是否正确。

要求：
1. 输出一个 JSON 对象：{ "items": ["要点1", "要点2", ...] }
2. 每条要点一句话、可独立执行；把模糊表述具体化（例如「好看一点」→「提升标题字号对比并收紧配色」）。
3. 不要发明用户没提的需求；不要建议把组件扩展成页面，也不要建议给页面新增用户没提的组件。
4. 只输出 JSON，不要解释。`

/** 迭代意图确认：把长/复杂修改指令拆解为执行项清单。失败由调用方回退直接生成。 */
export async function planIteration(
  opts: PlanOptions & { currentHtml: string },
): Promise<PlanPayload> {
  const provider = opts.provider
  if (!provider) throw new Error('未配置模型：请到「设置 → 模型设置」选择服务商')
  let acc = ''
  for await (const delta of streamCompletion(provider, {
    messages: [
      { role: 'system', content: ITERATION_PROMPT },
      { role: 'user', content: `【当前设计稿 HTML（节选）】
${opts.currentHtml.slice(0, 6000)}

【修改指令】
${opts.prompt}` },
    ],
    signal: opts.signal,
    temperature: 0.4,
    reasoningEffort: opts.reasoningEffort,
  })) {
    acc += delta
  }
  const plan = sanitizePlan(extractJson(acc))
  return { questions: [], styles: [], iteration: true, items: (plan as { items?: string[] }).items ?? [] }
}

/** 从模型输出中提取 JSON 对象（容忍围栏与前后杂质）。 */
function extractJson(text: string): unknown {
  let s = text.trim()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    s = nl >= 0 ? s.slice(nl + 1) : ''
  }
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('no json')
  return JSON.parse(s.slice(start, end + 1))
}

function sanitizePlan(raw: unknown): PlanPayload {
  const o = raw as Record<string, unknown>
  const seenQuestions = new Set<string>()
  const questions: PlanQuestion[] = Array.isArray(o.questions)
    ? (o.questions as unknown[])
        .map((q) => {
          const qo = q as Record<string, unknown>
          const options = Array.isArray(qo.options)
            ? [...new Set((qo.options as unknown[]).map((x) => String(x).trim()).filter(Boolean))]
            : []
          return { id: String(qo.id ?? `q${Math.random().toString(36).slice(2, 6)}`), q: String(qo.q ?? '').trim(), options }
        })
        .filter((q) => {
          if (!q.q || q.options.length < 2) return false
          // 类型问题由应用统一补充，模型自己写的先丢掉，避免占用澄清问题名额
          if (isArtifactModeQuestion(q) || looksLikeArtifactModeQuestion(q)) return false
          const key = `${q.q}::${q.options.join('|')}`
          if (seenQuestions.has(key)) return false
          seenQuestions.add(key)
          return true
        })
        .slice(0, 2)
    : []
  const styles = Array.isArray(o.styles)
    ? (o.styles as unknown[])
        .map((s) => {
          const so = s as Record<string, unknown>
          return {
            name: String(so.name ?? '').trim(),
            desc: String(so.desc ?? '').trim(),
            directive: String(so.directive ?? '').trim(),
          }
        })
        .filter((s) => s.name && s.directive)
        .slice(0, 3)
    : []
  return {
    title: typeof o.title === 'string' ? o.title : undefined,
    questions,
    styles,
    artifactMode: normalizePlannedMode(o.mode ?? o.artifactMode),
  }
}

/**
 * @description 规划结果收口：类型问题由应用统一插入到最前面，模型自作主张的类型二选一会被移除。
 * 模型未判断或判断为 ambiguous 时用本地关键词兜底，尽量给用户一个预选项。
 * @param plan - sanitize 后的规划
 * @param prompt - 用户原始需求
 * @returns 最终展示的规划卡数据
 */
export function finalizePlan(plan: PlanPayload, prompt: string): PlanPayload {
  let mode = plan.artifactMode
  if (!mode || mode === 'ambiguous') mode = inferArtifactMode(prompt) ?? 'ambiguous'

  const questions = plan.questions
    .filter((q) => !isArtifactModeQuestion(q) && !looksLikeArtifactModeQuestion(q))
    .slice(0, 2)

  return {
    ...plan,
    artifactMode: mode,
    questions: [makeArtifactModeQuestion(), ...questions].slice(0, 3),
  }
}

/**
 * 规划调用：LLM 根据需求判断产物类型，产出澄清问题与 3 个风格方案。
 * 任何失败都由调用方回退为直接生成（或只让用户选产物类型）。
 */
export async function planPrototype(opts: PlanOptions): Promise<PlanPayload> {
  const provider = opts.provider
  if (!provider) throw new Error('未配置模型：请到「设置 → 模型设置」选择服务商')

  let acc = ''
  for await (const delta of streamCompletion(provider, {
    messages: [
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: `设计需求：\n${opts.prompt}` },
    ],
    signal: opts.signal,
    temperature: 0.8,
    reasoningEffort: opts.reasoningEffort,
  })) {
    acc += delta
  }
  return finalizePlan(sanitizePlan(extractJson(acc)), opts.prompt)
}
