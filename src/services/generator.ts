import type { ChatMessage, ElementContext, ProviderConfig } from '@/types'
import { extractHtml, looksLikeCompleteHtml } from '@/utils/html'
import { streamChat } from './llm'
import { DEMO_PALETTES, streamDemo, streamDemoDiff } from './demo'
import { pluginRegistry } from '@/plugins/registry'

/** 从演示 HTML 的 --accent 色值反推 seed（兼容未记录 demoSeed 的旧版本） */
function inferDemoSeed(html: string): number {
  const m = html.match(/--accent:\s*(#[0-9a-fA-F]{6})/)
  const idx = m ? DEMO_PALETTES.indexOf(m[1].toLowerCase()) : -1
  return idx >= 0 ? idx : 0
}

export const AI_STYLE_ID = "style:ai"

export const SYSTEM_PROMPT = `你是一位有强烈个人风格的资深 UI 设计师兼前端工程师，正在为用户产出「网页设计原型」。你的作品要像出自专业设计工作室，而不是 AI 模板拼装。

硬性输出要求：
1. 只输出一个完整的 HTML5 文档（以 <!DOCTYPE html> 开头，以 </html> 结尾），不要任何解释说明，不要 markdown 代码围栏。
2. 所有 CSS 写在 <style> 中，所有 JS 写在 <script> 中；不引用任何外部 JS/CSS 库；可以引用 Google Fonts（仅字体），不要引用任何外部图片。
3. 页面必须自包含，可直接在浏览器中打开运行。
4. 使用真实、可信、具体的中文示例内容（真实感的人名、产品名、数据），禁止 Lorem ipsum、「占位文本」、「点击了解更多」这类空洞填充。内容本身就是设计的一部分。

【先立体系，再动手】写第一行 CSS 前，先在心里定好设计令牌并贯穿全页：
- 配色：纸色/底色 + 近黑墨色文字 + 一个主色 + （可选）一个锐利强调色。强调色面积 < 5%，只用在最关键的 1-3 处（主按钮、关键数据、激活态）。
- 字号阶梯（参考）：64/44/28/20/15/13/12，相邻层级至少 1.4 倍差距；层级靠字号与字重对比，不靠装饰。
- 间距尺度：4/8/12/16/24/32/48/64/96；区块间距远大于元素间距，一处大胆的留白胜过十处平均分布的空隙。
- 圆角、阴影、描边各定 1-2 档，全页统一，不要混用。

【排版纪律】
- 字体栈拉丁在前、中文在后，如：-apple-system, "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif；标题可用衬线制造性格：Georgia, "Songti SC", "SimSun", serif。
- 中文正文行高 1.7-1.8；大标题收到 1.1-1.2，字距 -0.02em。
- 数字与英文标签可用等宽字体（ui-monospace）做 micro-label（11px、大写、letter-spacing 0.08em）。
- 每一屏都要有一个明确的视觉锚点（超大标题、大数字或大图），其余元素为它服务。

【布局与构图】
- 用 flex/grid + gap 布局，行与组永远用 gap 对齐，不用 margin 拼凑。
- 敢于非对称：主栏与侧栏不必等分；重要内容可以跨栏、放大、突出。均分三列的卡片阵列是下策。
- 桌面视口下页面自适应宽度（max-width + 弹性栅格），不留大面积横向死白。

【氛围与细节】
- 背景要有层次：极淡的网格线、柔和渐变、噪点纹理或分层阴影都可以，不要大平白。
- 阴影克制且方向一致；分隔优先用留白，其次细线，最后才色块。
- 交互态完整：按钮 hover/active、输入框 focus、卡片 hover 都要有细腻过渡（150-250ms）。
- 对比度：正文对底色 ≥ 4.5:1，大字标题 ≥ 3:1。

【禁止（AI 模板腔）】
- 蓝紫渐变英雄区、紫色 #6366f1 主色、emoji 当图标、Inter/Roboto 当标识字体。
- 圆角卡片 + 左侧彩色竖条的组合；到处毛玻璃；到处渐变。
- 没有锚点的均质信息流；为凑数堆砌的图表、数字、图标。`

const ADVISOR_PROMPT = `你是一位以打破常规著称的设计总监。根据用户的页面需求，现场设计一段「风格指令」——它将作为另一位设计师执行页面时的唯一风格约束。

要求：
1. 输出 5-7 条要点，每条一行，以 - 开头，第一行以【设计风格：你为它起的名字】开头。
2. 必须具体到可直接执行：给出确切色值（hex）、字体栈、字号或间距的关键数字、构图手法、组件质感。
3. 方向要独特而果断：避开最常见的蓝紫渐变、居中对称英雄区、均分卡片阵列。
4. 最后一行以「- 禁止：」开头，列出 2-3 条该风格明确不允许出现的东西。
5. 只输出风格指令本身，不要任何开场白或解释。`

/** 演示模式的顾问输出（不调网络）。 */
const DEMO_ADVISOR_STYLE = `【设计风格：暖纸工作室（Studio Paper）】
- 底色用未涂布纸的暖白 #F5F2EB，墨色文字 #26251F，正文行高 1.8。
- 主色取陶土橙 #C4572E，只用于一处标题下划线与主按钮，面积 < 5%。
- 标题用衬线（Georgia + 宋体栈），字号阶梯 56/32/18/14，大标题字距 -0.01em。
- 构图采用 8:4 非对称双栏，左文右图，图片占位用同色系深一档的纯色块。
- 组件直角化：圆角 2px，分隔用 0.5px 墨色细线，不用阴影。
- 禁止：渐变、emoji 图标、居中对称的英雄区、均分三列卡片。`

/** 剥掉模型回复可能带上的 markdown 围栏。 */
function stripFences(text: string): string {
  let s = text.trim()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    s = nl >= 0 ? s.slice(nl + 1) : ''
  }
  return s.replace(/```\s*$/g, '').trim()
}

/** AI 风格顾问：让模型根据需求现场设计一段风格指令。 */
async function advisorStyle(opts: GenerateOptions): Promise<string> {
  const isDemo = !opts.provider || opts.provider.id === 'demo'
  if (isDemo) return DEMO_ADVISOR_STYLE
  let acc = ''
  for await (const delta of streamChat({
    baseURL: opts.provider!.baseURL,
    apiKey: opts.provider!.apiKey,
    model: opts.provider!.model,
    messages: [
      { role: 'system', content: ADVISOR_PROMPT },
      { role: 'user', content: `页面需求：\n${opts.prompt}\n\n请为它现场设计风格指令。` },
    ],
    signal: opts.signal,
    temperature: 1,
  })) {
    acc += delta
  }
  return stripFences(acc)
}

const DIFF_PROTOCOL = `你现在处于「增量修改」模式。不要输出完整 HTML，只输出一个或多个修改块，格式严格如下：

<<<<<<< SEARCH
（要被替换的原文，必须是当前 HTML 中连续的若干行，逐字符一致，不要自行增删空格）
=======
（替换后的新内容）
>>>>>>> REPLACE

规则：
1. SEARCH 内容必须与当前 HTML 完全匹配（可多次复制原行，保证精确）。
2. 每个块只做一处修改；多处修改输出多个块。
3. 只输出修改块本身，不要任何解释文字或 markdown 代码围栏。
4. 未被修改的内容不要出现在输出中。`

export interface GenerateOptions {
  /** 为空或 id === 'demo' 时走内置演示模式 */
  provider: ProviderConfig | null
  isNew: boolean
  /** 设计风格预设 id（plugins registry）；'ai' 表示由 AI 现场生成风格指令 */
  styleId?: string
  /** 直接指定风格指令（来自 AI 规划卡的用户选择），优先于 styleId */
  styleOverride?: string
  /** 思考档位（深度思考开关），透传给支持的服务商 */
  reasoningEffort?: string
  prompt: string
  currentHtml?: string
  elementContext?: ElementContext | null
  recent?: Pick<ChatMessage, 'role' | 'content'>[]
  sizeHint?: string
  /** 演示模式种子：新建时为方案序号，迭代时为当前版本序号 */
  demoSeed?: number
  signal: AbortSignal
  /** 流式过程中的中间 HTML（已清洗）；diff 模式的中间态不会回调 */
  onStreamingHtml: (html: string) => void
}

export interface GenerateResult {
  html: string
  /** diff = 增量应用成功；full = 全量生成；fallback = 增量失败后回退全量 */
  mode: 'diff' | 'full' | 'fallback'
  /** 演示模式下新版本的种子（迭代路径为 fromSeed + 1），供版本记录追溯 */
  demoSeed?: number
}

export interface SearchReplaceBlock {
  search: string
  replace: string
}

function describeElement(ctx: ElementContext): string {
  const lines = [
    `- selector: ${ctx.selector}`,
    `- 标签: ${ctx.tag}${ctx.classes.length ? ` .${ctx.classes.join('.')}` : ''}`,
  ]
  if (ctx.text) lines.push(`- 文本内容: ${ctx.text}`)
  lines.push(`- HTML 片段:\n${ctx.outerHTML}`)
  return lines.join('\n')
}

function buildFullUserContent(opts: GenerateOptions): string {
  if (opts.isNew) {
    const size = opts.sizeHint ? `\n页面按 ${opts.sizeHint} 视口尺寸设计，内容需自适应。` : ''
    return `请为以下需求设计一个网页原型：\n\n${opts.prompt}${size}`
  }
  const parts = ['【当前页面 HTML】', opts.currentHtml ?? '', '', '【用户反馈】', opts.prompt]
  if (opts.elementContext) {
    parts.push(
      '',
      '【反馈针对的元素】（用户在页面上选中了该元素，反馈主要针对它）',
      describeElement(opts.elementContext),
    )
  }
  parts.push('', '请输出修改后的完整 HTML 文档。再次强调：未提及的部分逐字保持不变。')
  return parts.join('\n')
}

function buildDiffUserContent(opts: GenerateOptions): string {
  const parts = ['【当前页面 HTML】', opts.currentHtml ?? '', '', '【用户反馈】', opts.prompt]
  if (opts.elementContext) {
    parts.push(
      '',
      '【反馈针对的元素】（用户在页面上选中了该元素，反馈主要针对它）',
      describeElement(opts.elementContext),
    )
  }
  parts.push('', '请按增量格式输出修改块。')
  return parts.join('\n')
}

/** 组装 system prompt：基础规范 + 风格段（预设指令或 AI 现场生成的指令） */
function systemPromptFor(
  opts: GenerateOptions,
  withDiffProtocol = false,
  styleOverride = '',
): string {
  const style = styleOverride || pluginRegistry.stylePrompt(opts.styleId)
  const parts = [SYSTEM_PROMPT]
  if (style) parts.push(style)
  if (withDiffProtocol) parts.push(DIFF_PROTOCOL)
  return parts.join('\n\n')
}

/** 从模型输出解析 SEARCH/REPLACE 块（容忍代码围栏与超长的分隔标记行）。 */
export function parseSearchReplace(raw: string): SearchReplaceBlock[] {
  let s = raw.trim()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    s = nl >= 0 ? s.slice(nl + 1) : ''
  }
  s = s.replace(/```\s*$/g, '')

  const blocks: SearchReplaceBlock[] = []
  const lines = s.split('\n')
  let i = 0
  const isSearchMark = (l: string) => /^<{5,}\s*SEARCH\s*$/.test(l.trim())
  const isSplitMark = (l: string) => /^={5,}\s*$/.test(l.trim())
  const isEndMark = (l: string) => /^>{5,}\s*REPLACE\s*$/.test(l.trim())

  while (i < lines.length) {
    if (!isSearchMark(lines[i])) {
      i++
      continue
    }
    i++
    const search: string[] = []
    while (i < lines.length && !isSplitMark(lines[i])) search.push(lines[i++])
    i++ // 跳过 =======
    const replace: string[] = []
    while (i < lines.length && !isEndMark(lines[i])) replace.push(lines[i++])
    if (i >= lines.length) break
    i++ // 跳过 >>>>>>> REPLACE
    if (search.length || replace.length) {
      blocks.push({ search: search.join('\n'), replace: replace.join('\n') })
    }
  }
  return blocks
}

/** 应用修改块：先精确匹配，失败后按「行 trim」宽松匹配。任一块失败即抛错。 */
export function applySearchReplace(html: string, blocks: SearchReplaceBlock[]): string {
  let out = html
  for (let bi = 0; bi < blocks.length; bi++) {
    const { search, replace } = blocks[bi]
    if (!search) continue
    const idx = out.indexOf(search)
    if (idx >= 0) {
      out = out.slice(0, idx) + replace + out.slice(idx + search.length)
      continue
    }
    // 宽松匹配：按行 trim 对齐（模型常在行尾空格/缩进上有细微出入）
    const applied = applyLenientByLines(out, search, replace)
    if (!applied) {
      throw new Error(`第 ${bi + 1} 个修改块的 SEARCH 内容在当前页面中找不到`)
    }
    out = applied
  }
  return out
}

function applyLenientByLines(html: string, search: string, replace: string): string | null {
  const doc = html.split('\n')
  const pat = search.split('\n').map((l) => l.trim())
  const rep = replace.split('\n')
  if (pat.some((l) => l === '')) return null
  for (let start = 0; start <= doc.length - pat.length; start++) {
    let ok = true
    for (let j = 0; j < pat.length; j++) {
      if (doc[start + j].trim() !== pat[j]) {
        ok = false
        break
      }
    }
    if (ok) {
      return [...doc.slice(0, start), ...rep, ...doc.slice(start + pat.length)].join('\n')
    }
  }
  return null
}

/**
 * 消费一个流并累计全文。streamHtml 为 true 时按全量 HTML 模式
 * 节流回调中间渲染态；diff 模式传 false（中间态不可渲染）。
 */
async function streamInto(
  source: AsyncGenerator<string>,
  opts: GenerateOptions,
  streamHtml: boolean,
): Promise<string> {
  let acc = ''
  let lastSent = 0
  let lastLen = -1
  for await (const delta of source) {
    acc += delta
    if (!streamHtml) continue
    const html = extractHtml(acc)
    if (html.length === lastLen) continue
    const now = Date.now()
    if (now - lastSent >= 350) {
      lastSent = now
      lastLen = html.length
      opts.onStreamingHtml(html)
    }
  }
  return acc
}

/** 执行一次原型生成（真实模型或演示模式）。迭代优先走增量，失败自动回退全量。 */
export async function generatePrototype(opts: GenerateOptions): Promise<GenerateResult> {
  const isDemo = !opts.provider || opts.provider.id === 'demo'
  const seed = opts.demoSeed ?? 0

  // —— AI 风格顾问：由模型根据需求现场设计风格指令 ——
  let styleOverride = ''
  if (opts.styleOverride) {
    styleOverride = opts.styleOverride
  } else if (opts.styleId === AI_STYLE_ID) {
    styleOverride = await advisorStyle(opts)
    opts.onStreamingHtml(extractHtml(opts.currentHtml ?? '')) // 让画板先刷新掉 advisor 阶段的等待感
  }
  const effectiveOpts = styleOverride ? { ...opts, styleId: undefined } : opts

  // —— 演示模式 ——
  if (isDemo) {
    if (!opts.isNew) {
      const from = opts.demoSeed ?? inferDemoSeed(opts.currentHtml ?? '')
      const raw = await streamInto(streamDemoDiff(from, from + 1, opts.signal), effectiveOpts, false)
      const blocks = parseSearchReplace(raw)
      const html = applySearchReplace(opts.currentHtml ?? '', blocks)
      opts.onStreamingHtml(html)
      return { html, mode: 'diff', demoSeed: from + 1 }
    }
    const raw = await streamInto(streamDemo(seed, opts.signal), effectiveOpts, true)
    const html = extractHtml(raw)
    opts.onStreamingHtml(html)
    if (!html || !/<[a-z!]/i.test(html)) throw new Error('没有生成有效的 HTML 内容')
    return { html, mode: 'full', demoSeed: seed }
  }

  // —— 真实模型：迭代先尝试增量 ——
  if (!opts.isNew) {
    try {
      const raw = await streamInto(
        streamChat({
          baseURL: opts.provider!.baseURL,
          apiKey: opts.provider!.apiKey,
          model: opts.provider!.model,
          messages: [
            { role: 'system', content: systemPromptFor(effectiveOpts, true) },
            { role: 'user', content: buildDiffUserContent(opts) },
          ],
          signal: opts.signal,
          temperature: 0.4,
          reasoningEffort: opts.reasoningEffort,
        }),
        opts,
        false,
      )
      const blocks = parseSearchReplace(raw)
      if (blocks.length === 0) throw new Error('模型未输出修改块')
      const html = applySearchReplace(opts.currentHtml ?? '', blocks)
      opts.onStreamingHtml(html)
      return { html, mode: 'diff' }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || opts.signal.aborted) throw err
      console.warn('[generator] 增量修改失败，回退全量生成：', (err as Error).message)
    }
  }

  // —— 全量生成（新建 / 增量失败的回退）——
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPromptFor(effectiveOpts) },
  ]
  for (const m of opts.recent ?? []) {
    messages.push({
      role: m.role,
      content: m.role === 'assistant' ? '（已更新页面原型）' : m.content,
    })
  }
  messages.push({ role: 'user', content: buildFullUserContent(opts) })

  const raw = await streamInto(
    streamChat({
      baseURL: opts.provider!.baseURL,
      apiKey: opts.provider!.apiKey,
      model: opts.provider!.model,
      messages,
      signal: opts.signal,
      reasoningEffort: opts.reasoningEffort,
    }),
    opts,
    true,
  )
  const finalHtml = extractHtml(raw)
  opts.onStreamingHtml(finalHtml)
  if (!finalHtml || !/<[a-z!]/i.test(finalHtml)) {
    throw new Error('模型没有输出有效的 HTML 内容，请重试或更换模型。')
  }
  if (!looksLikeCompleteHtml(finalHtml)) {
    console.warn('[generator] HTML 似乎不完整（缺少 </html>）')
  }
  return { html: finalHtml, mode: opts.isNew ? 'full' : 'fallback' }
}
