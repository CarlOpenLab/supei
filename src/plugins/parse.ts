/**
 * 插件包解析（纯函数，无 ui/registry 依赖，可被 node 单测直接加载）：
 * - 新 manifest JSON（{format, plugins: [...]}）
 * - 旧风格包 JSON（{name, prompt} 或数组）
 * - markdown 风格包（frontmatter name + 正文即指令）
 */
import type { PluginKind } from './types'

export interface ImportedPluginEntry {
  kind: PluginKind
  name: string
  description?: string
  data: unknown
}

const PLUGIN_KINDS: readonly string[] = ['style', 'preset', 'template', 'icon']

function asPluginKind(v: unknown): PluginKind | undefined {
  return PLUGIN_KINDS.includes(String(v)) ? (v as PluginKind) : undefined
}

export function parsePluginFile(text: string, filename: string): ImportedPluginEntry[] {
  const isJson =
    filename.endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')
  if (isJson) {
    const data = JSON.parse(text)
    const arr = Array.isArray(data) ? data : [data]
    return arr.flatMap((item: Record<string, unknown>) => {
      // v2 manifest
      if (Array.isArray(item.plugins)) {
        const kindDefault = asPluginKind(item.kind)
        return (item.plugins as Record<string, unknown>[]).map((p) =>
          normalizeEntry(kindDefault ?? p.kind, p),
        )
      }
      // 旧风格包：{name, prompt}
      return [normalizeEntry('style', item)]
    })
  }
  // markdown 风格包（frontmatter + 正文 → style 插件）
  const fm = text.trim().match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let label = ''
  let body = text.trim()
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^name\s*:\s*(.+)$/)
      if (m) label = m[1].trim().replace(/^["']|["']$/g, '')
    }
    body = fm[2]
  }
  if (!label) {
    const h1 = body.match(/^#\s+(.+)$/m)
    label = h1 ? h1[1].trim() : filename.replace(/\.[^.]+$/, '')
  }
  return [{ kind: 'style', name: label, data: { prompt: body.trim() } }]
}

function normalizeEntry(kind: unknown, p: Record<string, unknown>): ImportedPluginEntry {
  const k = asPluginKind(kind) ?? 'style'
  const name = String(p.name ?? p.label ?? '').trim()
  if (k === 'style') return { kind: k, name, data: { prompt: String(p.prompt ?? p.directive ?? '').trim() } }
  if (k === 'preset') return { kind: k, name, data: { icon: String(p.icon ?? 'sparkle'), prompt: String(p.prompt ?? '').trim() } }
  if (k === 'template')
    return {
      kind: k,
      name,
      data: { width: finiteOr(Number(p.width), 1280), height: finiteOr(Number(p.height), 800) },
    }
  if (k === 'icon') {
    const data = (p.data ?? p.icons ?? {}) as Record<string, string>
    return { kind: k, name, data }
  }
  return { kind: 'style', name, data: { prompt: '' } }
}

/** 非有限数（解析失败如 Number('abc')）回退默认值，避免 NaN 溜进尺寸。 */
function finiteOr(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback
}
