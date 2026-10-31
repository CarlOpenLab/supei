/**
 * 版本 diff：基于「直接文本节点」的轻量 HTML 对比。
 * 只比较叶子级文本（跳过纯容器），避免父子重复计数；
 * 选择器路径用于把改动映射回另一份文档做高亮标记。
 */

export interface DiffEntry {
  sel: string
  kind: 'add' | 'chg' | 'attr' | 'del'
}

export interface DiffResult {
  added: number
  changed: number
  /** 仅属性/样式变化（class、style、src 等），文本未动 */
  attrChanged: number
  removed: number
  entries: DiffEntry[]
}

const MAX_MARKS = 80

function selPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    const parent: Element | null = cur.parentElement
    let idx = 0
    if (parent) {
      const sibs: Element[] = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (sibs.length > 1) idx = sibs.indexOf(cur)
    }
    const cls =
      typeof cur.className === 'string' && cur.className.trim()
        ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.')
        : ''
    parts.unshift(cur.tagName.toLowerCase() + cls + (idx > 0 ? `:nth-of-type(${idx + 1})` : ''))
    cur = parent
  }
  return parts.join('>')
}

/** 元素自身的直接文本（不含子元素） */
function directText(el: Element): string {
  let out = ''
  for (const n of el.childNodes) {
    if (n.nodeType === 3) out += n.textContent ?? ''
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** 属性签名：class / style / 资源地址等视觉属性 */
const ATTR_KEYS = ['class', 'style', 'src', 'href', 'placeholder', 'type', 'fill', 'stroke'] as const
function attrSig(el: Element): string {
  const parts: string[] = []
  for (const a of ATTR_KEYS) {
    const v = el.getAttribute(a)
    if (v) parts.push(`${a}=${v.trim().replace(/\s+/g, ' ').slice(0, 140)}`)
  }
  return parts.join('|')
}

interface NodeSig {
  text: string
  attrs: string
}

interface NodeChange {
  sel: string
  kind: DiffEntry['kind']
  before?: NodeSig
  after?: NodeSig
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html')
}

/** 文档内全部元素：选择器路径 → 直接文本 + 视觉属性签名 */
function collect(doc: Document): Map<string, NodeSig> {
  const out = new Map<string, NodeSig>()
  for (const el of doc.body.querySelectorAll('*')) {
    out.set(selPath(el), { text: directText(el), attrs: attrSig(el) })
  }
  return out
}

/**
 * 逐元素对比：B 中有文字或属性的元素对照 A（A 无此元素 = 新增，文字不同 = 修改，仅属性不同 = 样式）；
 * A 中有内容、B 中消失或变空的记为删除。旧版无文字无属性的元素新加了 style（手动编辑的典型情况）算「样式」。
 */
function compareNodes(a: Map<string, NodeSig>, b: Map<string, NodeSig>): NodeChange[] {
  const changes: NodeChange[] = []
  for (const [sel, after] of b) {
    if (!after.text && !after.attrs) continue
    const before = a.get(sel)
    if (!before) changes.push({ sel, kind: 'add', after })
    else if (before.text !== after.text) changes.push({ sel, kind: 'chg', before, after })
    else if (before.attrs !== after.attrs) changes.push({ sel, kind: 'attr', before, after })
  }
  for (const [sel, before] of a) {
    const after = b.get(sel)
    if ((before.text || before.attrs) && !(after?.text || after?.attrs)) changes.push({ sel, kind: 'del', before })
  }
  return changes
}

export function diffHtml(aHtml: string, bHtml: string): DiffResult {
  const res: DiffResult = { added: 0, changed: 0, attrChanged: 0, removed: 0, entries: [] }
  if (!aHtml || !bHtml || aHtml === bHtml) return res

  const docA = parse(aHtml)
  const docB = parse(bHtml)

  // 样式表整体对比：CSS 规则变化无法稳定映射回元素，计入「样式」统计
  const cssA = [...docA.head.querySelectorAll('style')].map((s) => s.textContent).join('\n').trim()
  const cssB = [...docB.head.querySelectorAll('style')].map((s) => s.textContent).join('\n').trim()
  if (cssA !== cssB) res.attrChanged++

  for (const c of compareNodes(collect(docA), collect(docB))) {
    if (c.kind === 'add') res.added++
    else if (c.kind === 'chg') res.changed++
    else if (c.kind === 'attr') res.attrChanged++
    else res.removed++
    if (res.entries.length < MAX_MARKS) res.entries.push({ sel: c.sel, kind: c.kind })
  }
  return res
}

/** 文档内全部 <style> 的非空行（逐行比较样式表增删） */
function cssLines(doc: Document): string[] {
  return [...doc.querySelectorAll('style')]
    .flatMap((s) => (s.textContent ?? '').split('\n'))
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * @description 把两版 HTML 的差异写成给 Agent 读的改动清单（设计稿写回代码用）：
 * 元素级的新增 / 文字 / 样式属性 / 删除，以及样式表逐行增删。
 * @param aHtml - 基线版本（捕获时的页面）
 * @param bHtml - 当前设计稿
 * @param limit - 最多列出的条目数，超出部分只给数量
 * @returns 每行一条改动；没有改动时为空字符串
 */
export function describeChanges(aHtml: string, bHtml: string, limit = 150): string {
  if (aHtml === bHtml) return ''
  const docA = parse(aHtml)
  const docB = parse(bHtml)
  const clip = (s: string) => (s.length > 160 ? s.slice(0, 160) + '…' : s)
  const lines: string[] = []
  for (const c of compareNodes(collect(docA), collect(docB))) {
    if (c.kind === 'add') lines.push(`- [新增] ${c.sel}${c.after!.text ? `：「${clip(c.after!.text)}」` : ''}`)
    else if (c.kind === 'chg') lines.push(`- [文字] ${c.sel}：「${clip(c.before!.text)}」→「${clip(c.after!.text)}」`)
    else if (c.kind === 'attr') lines.push(`- [样式/属性] ${c.sel}：${clip(c.before!.attrs) || '（无）'} → ${clip(c.after!.attrs)}`)
    else lines.push(`- [删除] ${c.sel}${c.before!.text ? `：「${clip(c.before!.text)}」` : ''}`)
  }
  const cssA = cssLines(docA)
  const cssB = cssLines(docB)
  const setA = new Set(cssA)
  const setB = new Set(cssB)
  for (const l of cssB) if (!setA.has(l)) lines.push(`- [CSS 新增/修改] ${clip(l)}`)
  for (const l of cssA) if (!setB.has(l)) lines.push(`- [CSS 删除] ${clip(l)}`)
  if (lines.length > limit) return [...lines.slice(0, limit), `- …另有 ${lines.length - limit} 处改动未列出`].join('\n')
  return lines.join('\n')
}

const DIFF_CSS = `
[data-dc-diff]{outline-offset:-2px!important;border-radius:4px!important}
[data-dc-diff="add"]{outline:2px dashed #1677ff!important;background:rgba(22,119,255,.08)!important;animation:dc-pulse-p .9s ease-out 1}
[data-dc-diff="chg"]{outline:2px solid #1677ff!important;background:rgba(22,119,255,.08)!important;animation:dc-pulse-p .9s ease-out 1}
[data-dc-diff="attr"]{outline:2px dotted #f0a020!important;background:rgba(240,160,32,.07)!important;animation:dc-pulse-a .9s ease-out 1}
[data-dc-diff="del"]{outline:2px solid #ff5459!important;background:rgba(255,84,89,.07)!important;animation:dc-pulse-d .9s ease-out 1}
@keyframes dc-pulse-p{0%{background-color:rgba(22,119,255,.3)}}
@keyframes dc-pulse-a{0%{background-color:rgba(240,160,32,.26)}}
@keyframes dc-pulse-d{0%{background-color:rgba(255,84,89,.28)}}
`.trim()

/** 把 diff 标记写进文档：给命中元素加 data-dc-diff 属性 + 内联样式表（iframe 无需脚本） */
export function markDiff(html: string, entries: DiffEntry[]): string {
  if (!html || !entries.length) return html
  const doc = parse(html)
  let marked = 0
  for (const { sel, kind } of entries) {
    try {
      doc.body.querySelectorAll(sel).forEach((el) => {
        el.setAttribute('data-dc-diff', kind)
        marked++
      })
    } catch {
      /* 非法选择器直接跳过 */
    }
  }
  if (!marked) return html
  const style = doc.createElement('style')
  style.textContent = DIFF_CSS
  doc.head.appendChild(style)
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}
