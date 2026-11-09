import { insertIntoHead, SANDBOX_CSP_META } from './htmlExtract'
import { BRIDGE_SCRIPT } from '../bridge/bridge'

export { extractHtml, looksLikeCompleteHtml } from './htmlExtract'

/**
 * 将 CSP meta + bridge 脚本注入文档：
 * - CSP meta（尽早出现，作为沙箱渲染的硬约束：禁一切外呼通道）
 * - 保证 <meta charset>，避免 srcdoc 中文乱码
 * - bridge 注入到 <head> 开头，尽早注册事件监听
 */
export function injectBridge(html: string): string {
  const chunk = [
    /<meta[^>]+charset/i.test(html) ? '' : '<meta charset="utf-8">',
    SANDBOX_CSP_META,
    `<script>${BRIDGE_SCRIPT}</script>`,
  ]
    .filter(Boolean)
    .join('\n')
  return insertIntoHead(html, chunk)
}
