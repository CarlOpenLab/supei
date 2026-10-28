import type { PlanPayload, PlanStyle } from '@/types'
import { streamChat } from './llm'

export interface PlanOptions {
  provider: { id: string; baseURL: string; apiKey: string; model: string } | null
  prompt: string
  reasoningEffort?: string
  signal: AbortSignal
}

const PLANNER_PROMPT = `你是 v0 式的设计助理。用户会给你一个页面需求，你做两件事：

1. 提出最多 2 个有助于明确设计方向的澄清问题（不确定才问；每个问题 3 个选项，选项要具体且互斥）。
2. 设计 3 个截然不同的视觉风格方案。每个方案包含：name（风格名，4-8 字，有记忆点）、desc（一句话气质描述）、directive（完整风格指令，4-6 条，每条一行以 - 开头，必须给出确切色值 hex、字体栈、构图手法，最后一条以「- 禁止：」开头列 2-3 条不允许的东西）。

只输出一个 JSON 对象，不要任何解释或代码围栏：
{
  "questions": [{ "id": "tone", "q": "问题", "options": ["a", "b", "c"] }],
  "styles": [{ "name": "风格名", "desc": "一句话", "directive": "【设计风格：…】\\n- …\\n- 禁止：…" }]
}

要求：questions 可以为空数组（需求已足够明确时）；styles 恰好 3 个且方向差异明显。`

/** 演示模式的规划输出（不调网络）。 */
export const DEMO_PLAN: PlanPayload = {
  questions: [
    { id: 'tone', q: '页面的整体气质偏向哪种？', options: ['高级克制', '活泼有亲和力', '先锋实验'] },
    { id: 'density', q: '信息密度希望如何？', options: ['大量留白', '均衡', '高密度数据感'] },
  ],
  styles: [
    {
      name: '暖纸工作室',
      desc: '未涂布纸的暖白底、衬线标题、陶土橙点睛',
      directive:
        '【设计风格：暖纸工作室】\n- 底色 #F5F2EB，墨色 #26251F，主色陶土橙 #C4572E 只用于主按钮与下划线。\n- 标题衬线（Georgia + 宋体栈）56/32/18，字距 -0.01em。\n- 8:4 非对称双栏构图，图片占位用同色系深一档纯色块。\n- 圆角 2px，0.5px 墨色细线分隔，不用阴影。\n- 禁止：渐变、emoji 图标、均分三列卡片。',
    },
    {
      name: '墨绿期刊',
      desc: '深墨绿底、奶白衬线、金铜色细节的编辑部气质',
      directive:
        '【设计风格：墨绿期刊】\n- 底色深墨绿 #122B23，文字奶白 #F2EFE6，强调金铜 #C8A96A。\n- 标题衬线斜体混排，行首悬挂序号（01/02）。\n- 12 列网格，图文跨栏错位排布，段间距 48px。\n- 分隔线 1px 金铜 30% 透明，按钮为细描边胶囊。\n- 禁止：纯黑、荧光色、居中对称英雄区。',
    },
    {
      name: '电感微光',
      desc: '近黑底、电光青数据感、玻璃层次',
      directive:
        '【设计风格：电感微光】\n- 底色 #0B0D10，卡片 #14171B + 1px rgba(255,255,255,.07) 描边。\n- 强调电光青 #5CE1E6，仅用于关键数据与激活态。\n- 数字等宽大号（32px+），micro-label 11px 大写字距 0.08em。\n- 背景细网格线 24px 间距，透明度 4%。\n- 禁止：纯白大底、彩色渐变、emoji。',
    },
  ],
}

const ITERATION_PROMPT = `你是设计执行助理。用户会对现有页面原型提出一条修改指令。你的任务是把这条指令拆解为清晰、无歧义的执行项清单，向用户确认理解是否正确。

要求：
1. 输出一个 JSON 对象：{ "items": ["要点1", "要点2", ...] }
2. 每条要点一句话、可独立执行；把模糊表述具体化（例如「好看一点」→「提升标题字号对比并收紧配色」）。
3. 不要发明用户没提的需求。
4. 只输出 JSON，不要解释。`

/** 迭代意图确认：把长/复杂修改指令拆解为执行项清单。失败由调用方回退直接生成。 */
export async function planIteration(
  opts: PlanOptions & { currentHtml: string },
): Promise<PlanPayload> {
  const provider = opts.provider
  if (!provider || provider.id === 'demo') {
    return {
      questions: [],
      styles: [],
      iteration: true,
      items: ['理解指令并定位涉及的元素', '执行修改，保持页面其余部分不变'],
    }
  }
  let acc = ''
  for await (const delta of streamChat({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      { role: 'system', content: ITERATION_PROMPT },
      { role: 'user', content: `【当前页面 HTML（节选）】
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
  const questions = Array.isArray(o.questions)
    ? (o.questions as unknown[])
        .map((q) => {
          const qo = q as Record<string, unknown>
          const options = Array.isArray(qo.options) ? (qo.options as unknown[]).map(String) : []
          return { id: String(qo.id ?? `q${Math.random().toString(36).slice(2, 6)}`), q: String(qo.q ?? '').trim(), options }
        })
        .filter((q) => q.q && q.options.length >= 2)
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
    : []
  return { title: typeof o.title === 'string' ? o.title : undefined, questions, styles }
}

/**
 * 规划调用：LLM 根据需求产出澄清问题与 3 个风格方案。
 * 任何失败都由调用方回退为直接生成。
 */
export async function planPrototype(opts: PlanOptions): Promise<PlanPayload> {
  const provider = opts.provider
  if (!provider || provider.id === 'demo') return DEMO_PLAN

  let acc = ''
  for await (const delta of streamChat({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: [
      { role: 'system', content: PLANNER_PROMPT },
      { role: 'user', content: `页面需求：\n${opts.prompt}` },
    ],
    signal: opts.signal,
    temperature: 0.8,
    reasoningEffort: opts.reasoningEffort,
  })) {
    acc += delta
  }
  return sanitizePlan(extractJson(acc))
}
