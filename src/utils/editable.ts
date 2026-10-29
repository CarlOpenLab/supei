import type { ElementEdit } from '@/types'

/**
 * 手动编辑的源码映射：渲染前给源 HTML 的元素打稳定编号（data-dc-id），
 * 保存时用同一编号规则在源 HTML 上落盘修改。两处必须共用 numberedElements，
 * DOMParser 解析同一份 HTML 的结果是确定的，因此编号一致。
 */

/**
 * @description 按文档顺序列出可编辑元素：body 自身（页面背景）+ body 内全部后代元素。
 * @param doc - DOMParser 解析出的文档
 * @returns 下标 i 的元素编号为 i + 1
 */
function numberedElements(doc: Document): Element[] {
  return [doc.body, ...doc.body.querySelectorAll('*')]
}

/**
 * @description 序列化整份文档，与 markDiff 保持一致的写法（补回 doctype）。
 * @param doc - 文档
 * @returns 完整 HTML 字符串
 */
function serialize(doc: Document): string {
  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
}

/**
 * @description 给源 HTML 的元素打上 data-dc-id 编号，供 iframe 内的检查器把选中元素映射回源码；
 * 运行时由脚本生成的元素没有编号，检查器据此提示「不可直接编辑」。
 * @param html - 版本的源 HTML
 * @returns 带编号的 HTML（仅用于渲染，不落盘）
 */
export function stampIds(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  numberedElements(doc).forEach((el, i) => el.setAttribute('data-dc-id', String(i + 1)))
  return serialize(doc)
}

/**
 * @description 把检查器里的待保存修改写回源 HTML：内联样式按属性覆盖，文字整体替换。
 * @param html - 修改所基于的版本源 HTML（必须与渲染编号时是同一份）
 * @param edits - dcId → 修改
 * @returns 应用修改后的新 HTML
 */
export function applyEdits(html: string, edits: Record<string, ElementEdit>): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const els = numberedElements(doc)
  for (const [id, edit] of Object.entries(edits)) {
    const el = els[Number(id) - 1] as HTMLElement | undefined
    if (!el) throw new Error(`找不到编号为 ${id} 的元素，版本可能已切换`)
    for (const [prop, value] of Object.entries(edit.styles)) {
      if (value) el.style.setProperty(prop, value)
      else el.style.removeProperty(prop)
    }
    if (el.getAttribute('style') === '') el.removeAttribute('style')
    if (edit.text !== undefined) el.textContent = edit.text
  }
  return serialize(doc)
}
