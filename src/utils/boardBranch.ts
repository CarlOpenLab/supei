/** 画板在画布上的矩形（世界坐标） */
export interface BoardRect {
  x: number
  y: number
  width: number
  height: number
}

/** 碰撞留白：与已有画板至少隔开这么多像素 */
const GAP = 48
/** 分支标题里来自提示词的最大字数 */
const HINT_MAX = 18

/**
 * @description 从期望位置起找一块不与已有画板重叠的空位：撞上就移到那块画板下方继续找。
 * @param x - 期望 x（保持不变）
 * @param y - 期望 y
 * @param w - 新画板宽
 * @param h - 新画板高
 * @param boards - 已有画板矩形
 * @param gap - 碰撞留白
 * @returns 可放置的坐标
 */
export function findFreeSpot(
  x: number,
  y: number,
  w: number,
  h: number,
  boards: readonly BoardRect[],
  gap = GAP,
): { x: number; y: number } {
  let top = y
  for (;;) {
    const hit = boards.find(
      (b) => x < b.x + b.width + gap && x + w + gap > b.x && top < b.y + b.height + gap && top + h + gap > b.y,
    )
    if (!hit) return { x, y: top }
    top = hit.y + hit.height + gap
  }
}

/**
 * @description 平铺位置：新画板放在源画板右侧；右侧被占用时向下绕开。
 * @param source - 源画板矩形
 * @param boards - 画布上已有画板
 * @param gap - 横向间距
 * @returns 新画板坐标
 */
export function branchPosition(
  source: BoardRect,
  boards: readonly BoardRect[],
  gap = 60,
): { x: number; y: number } {
  return findFreeSpot(source.x + source.width + gap, source.y, source.width, source.height, boards)
}

/** 去掉「 · 改版」「 · 改版 2」后缀，作为分支命名的根标题 */
function rootTitle(title: string): string {
  return title.replace(/\s*·\s*改版(?:\s*\d+)?$/, '').trim() || title
}

/** 重名时追加 2、3… */
function uniqueTitle(base: string, existing: readonly string[]): string {
  if (!existing.includes(base)) return base
  let n = 2
  while (existing.includes(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/**
 * @description 新画板标题：优先用提示词首行（截断），没有提示时用「源标题 · 改版」；重名自动编号。
 * @param sourceTitle - 源画板标题
 * @param existing - 画布上已有标题
 * @param hint - 本次迭代的用户提示词
 * @returns 唯一的新标题
 */
export function branchTitle(
  sourceTitle: string,
  existing: readonly string[],
  hint?: string,
): string {
  const line = hint
    ?.split('\n')
    .map((s) => s.trim())
    .find(Boolean)
  const candidate = line
    ? line.replace(/\s+/g, ' ').slice(0, HINT_MAX)
    : `${rootTitle(sourceTitle)} · 改版`
  return uniqueTitle(candidate, existing)
}

/**
 * @description 手动保存产生的分支标题：「源标题 · 手动修改」，重名自动编号。
 * @param sourceTitle - 源画板标题
 * @param existing - 画布上已有标题
 * @returns 唯一的新标题
 */
export function manualBranchTitle(
  sourceTitle: string,
  existing: readonly string[],
): string {
  return uniqueTitle(`${rootTitle(sourceTitle)} · 手动修改`, existing)
}

/** 画板父链上用于寻找捕获来源的最小信息 */
export interface BoardLineage {
  id: string
  parent?: string
  capture?: unknown
}

/**
 * @description 沿父链找到最上层带 capture 的画板：写回代码时用它作为改动基线。
 * @param board - 当前画板
 * @param lookup - 按 id 取画板
 * @returns 捕获来源画板；整条链都没有时返回 undefined
 */
export function captureRootOf<T extends BoardLineage>(
  board: T,
  lookup: (id: string) => T | undefined,
): T | undefined {
  let current: T | undefined = board
  let found: T | undefined = current.capture ? current : undefined
  const seen = new Set<string>()
  while (current?.parent && !seen.has(current.id)) {
    seen.add(current.id)
    const parent = lookup(current.parent)
    if (!parent) break
    current = parent
    if (parent.capture) found = parent
  }
  return found
}
