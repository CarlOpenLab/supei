/**
 * 设计稿 HTML 的纯文本处理（无 DOM 依赖，可被 node 单测直接加载）：
 * - extractHtml：从模型原始输出提取完整 HTML 文档（容忍不完整流式文本）
 * - looksLikeCompleteHtml：是否包含 </html>
 * - insertIntoHead / withBoardCSP：把 CSP meta 注入 <head> 开头，作为沙箱内渲染的硬约束
 */

/**
 * 从模型原始输出中提取完整 HTML 文档。
 * 需要在流式过程中反复调用，因此必须容忍不完整的文本：
 * - 剥离开头的 ``` / ```html 围栏
 * - 从 <!DOCTYPE 或 <html 起截取（丢弃模型夹带的说明文字）
 * - 定稿后截掉 </html> 之后的尾料；流式未完成时只剥「当前结尾」的围栏，
 *   不碰正文中部（页面可能自带代码块展示）
 */
export function extractHtml(raw: string): string {
  let s = raw.trim()
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n')
    s = nl >= 0 ? s.slice(nl + 1) : ''
  }
  const doctype = s.search(/<!doctype html>/i)
  const htmlTag = s.search(/<html[\s>]/i)
  const start = doctype >= 0 ? doctype : htmlTag >= 0 ? htmlTag : 0
  if (start > 0) s = s.slice(start)
  const close = /<\/html\s*>/i.exec(s)
  if (close) {
    s = s.slice(0, close.index + close[0].length)
  } else {
    s = s.replace(/```\s*$/g, '')
  }
  return s.trim()
}

export function looksLikeCompleteHtml(html: string): boolean {
  return /<\/html\s*>/i.test(html)
}

/**
 * 沙箱内渲染（srcdoc iframe / 导出 viewer / 局域网分享）使用的 CSP：
 * - 允许内联脚本与样式（设计稿就是自包含文档）、Google Fonts（模型规范里唯一允许的外部资源）
 * - http/https 图片与媒体放行（捕获的设计稿带绝对地址的远程资源）
 * - 关死所有数据外呼通道：fetch / XHR / WebSocket / 声音源 / beacon 一律不允许
 * - 顶层导航由 iframe sandbox 兜底；form/base/object 一并禁掉
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; " +
  'font-src https: data:; img-src http: https: data: blob:; media-src http: https: data: blob:; ' +
  "connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"

export const SANDBOX_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`

/**
 * 把一段内容插到 <head> 开头（meta CSP 越早出现对本文档越有效）。
 * 没有 <head> 时退回 <html> 开头；连 <html> 都没有（片段）时前置到文档开头。
 */
export function insertIntoHead(html: string, chunk: string): string {
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head) {
    const at = head.index + head[0].length
    return html.slice(0, at) + '\n' + chunk + html.slice(at)
  }
  const open = /<html(?:\s[^>]*)?>/i.exec(html)
  if (open) {
    const at = open.index + open[0].length
    return html.slice(0, at) + '\n' + chunk + html.slice(at)
  }
  return chunk + '\n' + html
}

/** 给一块设计稿 HTML 注入 CSP meta（导出 viewer / 分享画板用）。 */
export function withBoardCSP(html: string): string {
  return insertIntoHead(html, SANDBOX_CSP_META)
}
