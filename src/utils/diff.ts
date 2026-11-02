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

export function diffHtml(aHtml: string, bHtml: string): DiffResult {
  const res: DiffResult = { added: 0, changed: 0, attrChanged: 0, removed: 0, entries: [] }
  if (!aHtml || !bHtml || aHtml === bHtml) return res

  const docA = new DOMParser().parseFromString(aHtml, 'text/html')
  const docB = new DOMParser().parseFromString(bHtml, 'text/html')

  // 样式表整体对比：CSS 规则变化无法稳定映射回元素，计入「样式」统计
  const cssA = [...docA.head.querySelectorAll('style')].map((s) => s.textContent).join('\n').trim()
  const cssB = [...docB.head.querySelectorAll('style')].map((s) => s.textContent).join('\n').trim()
  if (cssA !== cssB) res.attrChanged++

  const textA = new Map<string, string>()
  const attrA = new Map<string, string>()
  for (const el of docA.body.querySelectorAll('*')) {
    const key = selPath(el)
    const t = directText(el)
    if (t) textA.set(key, t)
    const s = attrSig(el)
    if (s) attrA.set(key, s)
  }

  const seen = new Set<string>()
  for (const el of docB.body.querySelectorAll('*')) {
    const key = selPath(el)
    const t = directText(el)
    const s = attrSig(el)
    if (!t && !s) continue
    seen.add(key)
    const tOld = textA.get(key)
    const sOld = attrA.get(key)
    if (tOld === undefined && sOld === undefined) {
      res.added++
      if (res.entries.length < MAX_MARKS) res.entries.push({ sel: key, kind: 'add' })
    } else if (tOld !== undefined && tOld !== t) {
      res.changed++
      if (res.entries.length < MAX_MARKS) res.entries.push({ sel: key, kind: 'chg' })
    } else if (sOld !== undefined && sOld !== s) {
      res.attrChanged++
      if (res.entries.length < MAX_MARKS) res.entries.push({ sel: key, kind: 'attr' })
    }
  }
  for (const key of new Set([...textA.keys(), ...attrA.keys()])) {
    if (!seen.has(key)) {
      res.removed++
      if (res.entries.length < MAX_MARKS) res.entries.push({ sel: key, kind: 'del' })
    }
  }
  return res
}

const DIFF_CSS = `
[data-dc-diff]{outline-offset:-2px!important;border-radius:4px!important}
[data-dc-diff="add"]{outline:2px dashed #b05cf2!important;background:rgba(176,92,242,.08)!important;animation:dc-pulse-p .9s ease-out 1}
[data-dc-diff="chg"]{outline:2px solid #b05cf2!important;background:rgba(176,92,242,.08)!important;animation:dc-pulse-p .9s ease-out 1}
[data-dc-diff="attr"]{outline:2px dotted #f0a020!important;background:rgba(240,160,32,.07)!important;animation:dc-pulse-a .9s ease-out 1}
[data-dc-diff="del"]{outline:2px solid #ff5459!important;background:rgba(255,84,89,.07)!important;animation:dc-pulse-d .9s ease-out 1}
@keyframes dc-pulse-p{0%{background-color:rgba(176,92,242,.3)}}
@keyframes dc-pulse-a{0%{background-color:rgba(240,160,32,.26)}}
@keyframes dc-pulse-d{0%{background-color:rgba(255,84,89,.28)}}
`.trim()

/** 把 diff 标记写进文档：给命中元素加 data-dc-diff 属性 + 内联样式表（iframe 无需脚本） */
export function markDiff(html: string, entries: DiffEntry[]): string {
  if (!html || !entries.length) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
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
