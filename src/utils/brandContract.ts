/**
 * 项目级品牌契约的纯文本渲染（无 store / DOM 依赖，可被 node 单测直接加载）：
 * - tokensCSS：契约 → tokens.css 内容（导出用，也是生成提示词里的「必须逐字声明」清单）
 * - contractPrompt：契约 → 拼进 system prompt 的约束段（生成原型与 Agent 改代码共用）
 * 契约本身存在 Project.brandContract，编辑入口在品牌契约抽屉。
 */
import type { BrandContract } from '../types'

export const TOKEN_PREFIX = '--brand-'

/** 把 token 名清洗成合法 CSS 变量片段：小写、仅 a-z0-9 与连字符 */
export function sanitizeToken(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** 契约是否值得渲染（一个有效字段都没有 = 未启用）；谓词收窄：true 时 c 非空 */
export function hasContract(c: BrandContract | null | undefined): c is BrandContract {
  if (!c) return false
  return (
    Boolean(c.voice.trim()) ||
    c.palette.some((p) => sanitizeToken(p.token) && p.color.trim()) ||
    Boolean(c.fontDisplay.trim() || c.fontBody.trim() || c.radius.trim() || c.spacing.trim() || c.rules.trim())
  )
}

/**
 * 契约 → tokens.css 文本；没有有效 token 时返回空串（调用方跳过导出）。
 * 同一份文本也出现在生成提示词里，要求模型在 :root 逐字声明。
 */
export function tokensCSS(c: BrandContract, title = 'project'): string {
  const lines: string[] = []
  for (const p of c.palette) {
    const token = sanitizeToken(p.token)
    const color = p.color.trim()
    if (token && color) lines.push(`  ${TOKEN_PREFIX}${token}: ${color};`)
  }
  const fontDisplay = c.fontDisplay.trim()
  const fontBody = c.fontBody.trim()
  const radius = c.radius.trim()
  const spacing = c.spacing.trim()
  if (fontDisplay) lines.push(`  ${TOKEN_PREFIX}font-display: ${quoteFont(fontDisplay)};`)
  if (fontBody) lines.push(`  ${TOKEN_PREFIX}font-body: ${quoteFont(fontBody)};`)
  if (radius) lines.push(`  ${TOKEN_PREFIX}radius: ${radius};`)
  if (spacing) lines.push(`  ${TOKEN_PREFIX}spacing: ${spacing};`)
  if (!lines.length) return ''
  return [
    `/* tokens.css — ${title} 的品牌契约（由 AI 原型画布生成） */`,
    ':root {',
    ...lines,
    '}',
  ].join('\n')
}

/** 字体值带空格/逗号时包成 CSS 字符串，如 "Fraunces", serif → "Fraunces","serif"? 不：字体名逐个加引号 */
function quoteFont(value: string): string {
  // 用户可填字体名或字体栈；family 含空格时需要引号，纯栈内容原样使用
  return /[",]/.test(value) ? value : `"${value}"`
}

/**
 * 契约 → 拼进 system prompt 的约束段；未启用契约时返回空串。
 * 同时用于原型生成（system prompt 末尾）与本机 Agent 改代码（指令前置）。
 */
export function contractPrompt(c: BrandContract | null | undefined): string {
  if (!hasContract(c)) return ''
  const parts: string[] = ['【品牌契约 —— 本项目所有设计的最高优先级约束】']
  const css = tokensCSS(c)
  parts.push('进入任何新稿前，先在 :root 声明以下 CSS 变量（与下面逐字一致），并全页引用；不得引入与契约色板明显冲突的颜色：')
  parts.push(css)
  if (c?.voice.trim()) parts.push(`品牌调性：${c.voice.trim()}`)
  if (c?.fontDisplay.trim() || c?.fontBody.trim()) {
    const display = c?.fontDisplay.trim() || c?.fontBody.trim()
    const body = c?.fontBody.trim() || c?.fontDisplay.trim()
    parts.push(
      `字体纪律：标题用 ${TOKEN_PREFIX}font-display（${display}）；正文用 ${TOKEN_PREFIX}font-body（${body}），` +
        `字体栈拉丁在前、中文回退在后（"PingFang SC", "Microsoft YaHei"）；用到的是 Google Fonts 字族时引入对应的 <link>。`,
    )
  }
  if (c?.radius.trim()) parts.push(`圆角统一 ${TOKEN_PREFIX}radius = ${c.radius.trim()}，全页不得混用其它圆角档位。`)
  if (c?.spacing.trim()) parts.push(`间距以 ${TOKEN_PREFIX}spacing = ${c.spacing.trim()} 为基准取整数倍，形成清晰的节奏。`)
  if (c?.rules.trim()) parts.push(`自定义硬规则：\n${c.rules.trim()}`)
  parts.push('【优先级】与风格指令冲突时，以本契约为准。')
  return parts.join('\n\n')
}

/** 新项目 / 未启用契约时的默认种子（抽屉里可随意改） */
export function defaultBrandContract(): BrandContract {
  return {
    voice: '克制、纸感、像数据杂志：大量留白，层级靠字号与字重，不靠装饰。',
    palette: [
      { token: 'bg', color: '#F7F5F0' },
      { token: 'surface', color: '#FFFFFF' },
      { token: 'text', color: '#1A1817' },
      { token: 'muted', color: '#6E6A64' },
      { token: 'primary', color: '#2F5D50' },
    ],
    fontDisplay: 'Fraunces',
    fontBody: 'Inter',
    radius: '10px',
    spacing: '8px',
    rules: '强调色面积 < 5%，只用于主按钮与关键数据；不使用蓝紫渐变和毛玻璃。',
  }
}
