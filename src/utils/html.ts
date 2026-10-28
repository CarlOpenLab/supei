import { BRIDGE_SCRIPT } from '@/bridge/bridge'

/**
 * 从模型原始输出中提取完整 HTML 文档。
 * 需要在流式过程中反复调用，因此必须容忍不完整的文本：
 * - 剥离开头的 ``` / ```html 围栏
 * - 从 <!DOCTYPE 或 <html 起截取（丢弃模型夹带的说明文字）
 * - 剥离结尾未闭合/已闭合的围栏
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
  return s
    .replace(/```[\s\S]*?$/, (m) => (m.includes('</html>') ? '' : ''))
    .replace(/```\s*$/g, '')
    .trim()
}

export function looksLikeCompleteHtml(html: string): boolean {
  return /<\/html\s*>/i.test(html)
}

/**
 * 将 bridge 脚本注入文档：
 * - 保证 <meta charset>，避免 srcdoc 中文乱码
 * - bridge 注入到 <head> 开头，尽早注册事件监听
 */
export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SCRIPT}</script>`
  let out = html
  if (!/<meta[^>]+charset/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m) => `${m}\n<meta charset="utf-8">`)
  }
  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, (m) => `${m}\n${script}`)
  } else if (/<html[^>]*>/i.test(out)) {
    out = out.replace(/<html([^>]*)>/i, (m) => `${m}${script}`)
  } else {
    out = script + out
  }
  return out
}
