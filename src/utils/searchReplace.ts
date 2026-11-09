/**
 * Aider 风格 SEARCH/REPLACE 增量协议的解析与应用（纯函数，无 DOM 依赖，可被 node 单测直接加载）。
 * 协议：模型输出一个或多个 `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` 修改块；
 * 应用时先精确匹配，失败后按「行 trim」宽松匹配，任一块失败即抛错（调用方回退全量重生成）。
 */

export interface SearchReplaceBlock {
  search: string
  replace: string
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
