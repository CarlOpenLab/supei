import type { ArtifactMode, ChatMessage, ElementContext, ProviderConfig } from '@/types'
import { extractHtml, looksLikeCompleteHtml } from '@/utils/html'
import { streamCompletion } from './llm'
import { pluginRegistry } from '@/plugins/registry'

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

export const COMPONENT_SYSTEM_PROMPT = `你是一位有强烈个人风格的资深 UI 设计师兼前端工程师，正在产出「单个 UI 组件的视觉设计稿」。画板是展示台，不是网页视口：用户要看的是组件本身，以及需求中要求的状态、变体与尺寸，而不是一个塞进组件的页面。

硬性输出要求：
1. 只输出一个完整的 HTML5 文档（以 <!DOCTYPE html> 开头，以 </html> 结尾），不要任何解释说明，不要 markdown 代码围栏。
2. <body> 只呈现组件规格展示：组件本体 + 必要的状态/变体标签。禁止导航栏、页脚、hero、营销区块、侧边栏、面包屑等页面框架；禁止把组件拼成一个应用页面或落地页。
3. 所有 CSS 写在 <style> 中，所有 JS 写在 <script> 中；不引用任何外部 JS/CSS 库；可以引用 Google Fonts（仅字体），不要引用任何外部图片；图标用内联 SVG。
4. 使用真实语义元素与真实交互态：button / a / input / select / textarea / dialog 等，配合 :hover、:active、:focus-visible、:disabled、[aria-busy="true"]；禁止用 div 伪装按钮。
5. 使用真实、可信、具体的中文示例内容（按钮文案、表单标签、表格数据、人名），禁止 Lorem ipsum、「占位文本」、「点击了解更多」这类空洞填充。

【展示台与构图】
- 画板即展示台：中性底色（浅灰或纸色），组件表面与底色拉开层次，四周留出 ≥ 48px 呼吸空间；不依赖滚动。
- 用户没有要求状态/变体时，只展示一个默认实例；要求了状态、变体或尺寸时，用「变体 × 状态」矩阵排布。
- 每个实例旁放 11px 等宽 micro-label（如 DEFAULT / HOVER / FOCUS / DISABLED / LOADING、S / M / L），统一大小写与颜色，标签是注释，不抢组件本身。
- 矩阵用 grid + gap 对齐，行距列距一致；同一行的实例尺寸一致（尺寸变体本身除外）。
- 不要为了填满画板而添加用户没要求的组件、装饰卡片或说明段落。

【组件级设计体系】写第一行 CSS 前先定好令牌并贯穿组件：
- 颜色：surface / text / muted / border / primary / primary-hover / danger，先用 CSS 变量定义再使用。若给了风格指令，以风格指令的色值为准。
- 尺寸：高度档位（如 32 / 40 / 48）、内边距、圆角、字号、图标尺寸各定 1-2 档，组件内部统一。
- 状态：hover、active、focus-visible、disabled、loading 的差异要明确但克制（颜色、阴影、透明度、光标），过渡 150-200ms。
- 层级靠字号、字重与颜色对比建立；组件内文字行高紧凑（1.2-1.4）。
- 对比度：正文对底色 ≥ 4.5:1；焦点环必须清晰可见。
- 焦点环用 box-shadow 或 outline 实现，不能只把 :focus-visible 轮廓去掉而不给替代。

【细节】
- 图标与文字基线、间距对齐；数字用等宽字体（ui-monospace）。
- 背景可加极淡网格或柔和渐变增加层次，但不得干扰组件。
- 阴影克制且方向一致；分隔优先用留白，其次细线，最后才色块。

【禁止（AI 模板腔）】
- 蓝紫渐变、#6366f1 紫色主色、emoji 当图标、Inter/Roboto 当标识字体。
- 圆角卡片 + 左侧彩色竖条的组合；到处毛玻璃；到处渐变；无意义的阴影堆叠。
- 把组件放回页面框架里「演示」；添加用户没要求的状态、区块或假数据。

【交付边界】输出的是组件视觉设计稿（HTML），不是 Vue/React 源码：不要输出 .vue / .tsx、props 定义、安装说明或使用文档。若用户明确要「一组相关组件」（如按钮 + 输入框 + 下拉），按组件目录分组排布，每组独立，但不要拼成一个应用页面。`

const ADVISOR_PROMPT = `你是一位以打破常规著称的设计总监。根据用户的设计需求（可能是整页原型，也可能是单个 UI 组件），现场设计一段「风格指令」——它将作为另一位设计师执行设计时的唯一风格约束。

要求：
1. 输出 5-7 条要点，每条一行，以 - 开头，第一行以【设计风格：你为它起的名字】开头。
2. 必须具体到可直接执行：给出确切色值（hex）、字体栈、字号或间距的关键数字、构图手法、组件质感。
3. 方向要独特而果断：避开最常见的蓝紫渐变、居中对称英雄区、均分卡片阵列。若是单个组件，给组件级令牌（高度、内边距、圆角、描边、字重、hover / focus / disabled 态），不要写页面级构图。
4. 最后一行以「- 禁止：」开头，列出 2-3 条该风格明确不允许出现的东西。
5. 只输出风格指令本身，不要任何开场白或解释。`

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
  if (!opts.provider) throw new Error('未配置模型：请到「设置 → 模型设置」选择服务商')
  const isComponent = opts.artifactMode === 'component'
  let acc = ''
  for await (const delta of streamCompletion(opts.provider, {
    messages: [
      { role: 'system', content: ADVISOR_PROMPT },
      { role: 'user', content: `${isComponent ? '组件' : '页面'}需求：\n${opts.prompt}\n\n请为它现场设计${isComponent ? '组件级' : '页面级'}风格指令。` },
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
  /** 未配置时 generatePrototype 直接抛错，由调用方提示 */
  provider: ProviderConfig | null
  isNew: boolean
  /** 产物类型：整页原型或单个 UI 组件；缺省视为 page */
  artifactMode?: ArtifactMode
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
  signal: AbortSignal
  /** 流式过程中的中间 HTML（已清洗）；diff 模式的中间态不会回调 */
  onStreamingHtml: (html: string) => void
}

export interface GenerateResult {
  html: string
  /** diff = 增量应用成功；full = 全量生成；fallback = 增量失败后回退全量 */
  mode: 'diff' | 'full' | 'fallback'
}

export interface SearchReplaceBlock {
  search: string
  replace: string
}

/**
 * @description 把点选元素描述成提示词片段（选择器、标签、文本、HTML 片段），生成与 Agent 改代码共用。
 * @param ctx - bridge 上报的元素上下文
 * @returns 多行描述文本
 */
export function describeElement(ctx: ElementContext): string {
  const lines = [
    `- selector: ${ctx.selector}`,
    `- 标签: ${ctx.tag}${ctx.classes.length ? ` .${ctx.classes.join('.')}` : ''}`,
  ]
  if (ctx.text) lines.push(`- 文本内容: ${ctx.text}`)
  lines.push(`- HTML 片段:\n${ctx.outerHTML}`)
  return lines.join('\n')
}

function buildFullUserContent(opts: GenerateOptions): string {
  const isComponent = opts.artifactMode === 'component'
  if (opts.isNew) {
    const size = opts.sizeHint
      ? isComponent
        ? `\n画板按 ${opts.sizeHint} 尺寸设计；画板是组件展示台，组件本体尺寸由需求决定，不要求铺满。`
        : `\n页面按 ${opts.sizeHint} 视口尺寸设计，内容需自适应。`
      : ''
    return isComponent
      ? `请为以下需求设计一个单个 UI 组件的视觉设计稿（不是整页，不是 Vue/React 源码）：\n\n${opts.prompt}${size}`
      : `请为以下需求设计一个网页原型：\n\n${opts.prompt}${size}`
  }
  const parts = [isComponent ? '【当前组件设计稿 HTML】' : '【当前页面 HTML】', opts.currentHtml ?? '', '', '【用户反馈】', opts.prompt]
  if (opts.elementContext) {
    parts.push(
      '',
      '【反馈针对的元素】（用户在设计稿里选中了该元素，反馈主要针对它）',
      describeElement(opts.elementContext),
    )
  }
  parts.push(
    '',
    isComponent
      ? '请输出修改后的完整 HTML 文档。再次强调：只调整组件本身，不要新增页面级区块，不要改动未要求的状态，未提及的部分逐字保持不变。'
      : '请输出修改后的完整 HTML 文档。再次强调：未提及的部分逐字保持不变。',
  )
  return parts.join('\n')
}

function buildDiffUserContent(opts: GenerateOptions): string {
  const isComponent = opts.artifactMode === 'component'
  const parts = [isComponent ? '【当前组件设计稿 HTML】' : '【当前页面 HTML】', opts.currentHtml ?? '', '', '【用户反馈】', opts.prompt]
  if (opts.elementContext) {
    parts.push(
      '',
      '【反馈针对的元素】（用户在设计稿里选中了该元素，反馈主要针对它）',
      describeElement(opts.elementContext),
    )
  }
  parts.push(
    '',
    isComponent ? '请按增量格式输出修改块；只改组件相关部分，不要新增页面级区块。' : '请按增量格式输出修改块。',
  )
  return parts.join('\n')
}

/** 组件模式兜底：模型只给了 HTML 片段时，包成完整文档，保证预览/缩略图/导出可用。 */
function ensureHtmlDocument(html: string): string {
  if (/<html[\s>]/i.test(html) || /<!doctype/i.test(html)) return html
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '</head>',
    '<body>',
    html,
    '</body>',
    '</html>',
  ].join('\n')
}

/** 组装 system prompt：基础规范 + 风格段（预设指令或 AI 现场生成的指令） */
function systemPromptFor(
  opts: GenerateOptions,
  withDiffProtocol = false,
  styleOverride = '',
): string {
  const isComponent = opts.artifactMode === 'component'
  const style = styleOverride || pluginRegistry.stylePrompt(opts.styleId)
  const parts = [isComponent ? COMPONENT_SYSTEM_PROMPT : SYSTEM_PROMPT]
  if (style) {
    parts.push(style)
    if (isComponent) {
      parts.push(
        '【范围提醒】以上风格指令中的「页面 / 全页」措辞，一律收缩到组件本身：只把配色、字体、圆角、描边与质感应用到这一个组件上，不要扩展成页面，不要新增页面级区块。',
      )
    }
  }
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
      throw new Error(`第 ${bi + 1} 个修改块的 SEARCH 内容在当前设计稿中找不到`)
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

/** 执行一次原型生成。迭代优先走增量，失败自动回退全量。 */
export async function generatePrototype(opts: GenerateOptions): Promise<GenerateResult> {
  if (!opts.provider) throw new Error('未配置模型：请到「设置 → 模型设置」选择服务商')

  // —— AI 风格顾问：由模型根据需求现场设计风格指令 ——
  let styleOverride = ''
  if (opts.styleOverride) {
    styleOverride = opts.styleOverride
  } else if (opts.styleId === AI_STYLE_ID) {
    styleOverride = await advisorStyle(opts)
    opts.onStreamingHtml(extractHtml(opts.currentHtml ?? '')) // 让画板先刷新掉 advisor 阶段的等待感
  }
  const effectiveOpts = styleOverride ? { ...opts, styleId: undefined } : opts

  // —— 真实模型：迭代先尝试增量 ——
  if (!opts.isNew) {
    try {
      const raw = await streamInto(
        streamCompletion(opts.provider, {
          messages: [
            { role: 'system', content: systemPromptFor(effectiveOpts, true, styleOverride) },
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
      const html = ensureHtmlDocument(applySearchReplace(opts.currentHtml ?? '', blocks))
      opts.onStreamingHtml(html)
      return { html, mode: 'diff' }
    } catch (err) {
      if ((err as Error).name === 'AbortError' || opts.signal.aborted) throw err
      console.warn('[generator] 增量修改失败，回退全量生成：', (err as Error).message)
    }
  }

  // —— 全量生成（新建 / 增量失败的回退）——
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: systemPromptFor(effectiveOpts, false, styleOverride) },
  ]
  for (const m of opts.recent ?? []) {
    messages.push({
      role: m.role,
      content:
        m.role === 'assistant'
          ? opts.artifactMode === 'component'
            ? '（已更新组件设计稿）'
            : '（已更新页面原型）'
          : m.content,
    })
  }
  messages.push({ role: 'user', content: buildFullUserContent(opts) })

  const raw = await streamInto(
    streamCompletion(opts.provider, {
      messages,
      signal: opts.signal,
      reasoningEffort: opts.reasoningEffort,
    }),
    opts,
    true,
  )
  const extracted = extractHtml(raw)
  const finalHtml = opts.artifactMode === 'component' ? ensureHtmlDocument(extracted) : extracted
  opts.onStreamingHtml(finalHtml)
  if (!finalHtml || !/<[a-z!]/i.test(finalHtml)) {
    throw new Error('模型没有输出有效的 HTML 内容，请重试或更换模型。')
  }
  if (!looksLikeCompleteHtml(finalHtml)) {
    console.warn('[generator] HTML 似乎不完整（缺少 </html>）')
  }
  return { html: finalHtml, mode: opts.isNew ? 'full' : 'fallback' }
}
