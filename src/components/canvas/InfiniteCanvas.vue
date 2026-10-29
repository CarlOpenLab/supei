<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message as antMessage } from 'antdv-next'
import { useCanvasStore, MAX_ZOOM, MIN_ZOOM } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Artboard } from '@/types'
import AppIcon from '@/components/ui/AppIcon.vue'
import ArtboardNode from './ArtboardNode.vue'

const canvas = useCanvasStore()
const ws = useWorkspaceStore()

const containerRef = ref<HTMLElement | null>(null)

const worldStyle = computed(() => ({
  transform: `translate(${canvas.viewport.x}px, ${canvas.viewport.y}px) scale(${canvas.viewport.zoom})`,
}))

const gridStyle = computed(() => ({
  backgroundSize: `${24 * canvas.viewport.zoom}px ${24 * canvas.viewport.zoom}px`,
  backgroundPosition: `${canvas.viewport.x}px ${canvas.viewport.y}px`,
}))

const zoomPercent = computed(() => `${Math.round(canvas.viewport.zoom * 100)}%`)

// —— 画板衍生连线：parent 右中 → child 左中 的三次贝塞尔 ——
const links = computed(() => {
  const out: Array<{ id: string; d: string; childId: string }> = []
  const byId = new Map(ws.artboards.map((b) => [b.id, b]))
  for (const b of ws.artboards) {
    if (!b.parent) continue
    const p = byId.get(b.parent)
    if (!p) continue
    const x1 = p.x + p.width
    const y1 = p.y + p.height / 2
    const x2 = b.x
    const y2 = b.y + b.height / 2
    const dx = Math.max(60, Math.abs(x2 - x1) / 2)
    out.push({
      id: `${p.id}->${b.id}`,
      childId: b.id,
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    })
  }
  return out
})

/** 把世界坐标矩形居中适配到画布的视口（聚焦 / 适配全部 / 对比排版共用） */
function fitRect(x: number, y: number, bw: number, bh: number, pad = 120) {
  const { w, h } = canvas.containerSize
  const zoom = Math.min(1, Math.max(MIN_ZOOM, Math.min((w - pad) / bw, (h - pad) / bh)))
  return {
    zoom,
    x: w / 2 - (x + bw / 2) * zoom,
    y: h / 2 - (y + bh / 2) * zoom,
  }
}

/** 点击连线：选中并聚焦对应画板 */
function focusBoard(id: string) {
  canvas.select(id)
  const b = ws.findArtboard(id)
  if (!b) return
  animateViewport(fitRect(b.x, b.y, b.width, b.height))
}

// —— 缩放（容器内坐标）——
// rAF 阻尼：滚轮只更新目标值，逐帧逼近，锚点（光标下的世界坐标）保持不动
const zoomDamp = { target: 0, ax: 0, ay: 0, raf: 0, active: false }
const viewAnim = { to: { zoom: 0, x: 0, y: 0 }, raf: 0, active: false }

function stopViewAnims() {
  zoomDamp.active = false
  viewAnim.active = false
  cancelAnimationFrame(zoomDamp.raf)
  cancelAnimationFrame(viewAnim.raf)
}

function startDampedZoom(targetZoom: number, ax: number, ay: number) {
  viewAnim.active = false
  cancelAnimationFrame(viewAnim.raf)
  zoomDamp.target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, targetZoom))
  zoomDamp.ax = ax
  zoomDamp.ay = ay
  if (!zoomDamp.active) {
    zoomDamp.active = true
    zoomDamp.raf = requestAnimationFrame(zoomFrame)
  }
}

function zoomFrame() {
  if (!zoomDamp.active) return
  const vp = canvas.viewport
  const nz = vp.zoom + (zoomDamp.target - vp.zoom) * 0.24
  const ratio = nz / vp.zoom
  canvas.setViewport({
    zoom: nz,
    x: zoomDamp.ax - (zoomDamp.ax - vp.x) * ratio,
    y: zoomDamp.ay - (zoomDamp.ay - vp.y) * ratio,
  })
  if (
    Math.abs(zoomDamp.target - canvas.viewport.zoom) > 0.0004 &&
    !panning.value
  ) {
    zoomDamp.raf = requestAnimationFrame(zoomFrame)
  } else {
    zoomDamp.active = false
  }
}

/** 视口整体平滑过渡（适配全部 / 重置 / 按钮缩放） */
function animateViewport(to: { zoom: number; x: number; y: number }) {
  zoomDamp.active = false
  cancelAnimationFrame(zoomDamp.raf)
  viewAnim.to = to
  if (!viewAnim.active) {
    viewAnim.active = true
    viewAnim.raf = requestAnimationFrame(viewFrame)
  }
}

function viewFrame() {
  if (!viewAnim.active) return
  const vp = canvas.viewport
  const nz = vp.zoom + (viewAnim.to.zoom - vp.zoom) * 0.22
  const nx = vp.x + (viewAnim.to.x - vp.x) * 0.22
  const ny = vp.y + (viewAnim.to.y - vp.y) * 0.22
  canvas.setViewport({ zoom: nz, x: nx, y: ny })
  const done =
    Math.abs(viewAnim.to.zoom - canvas.viewport.zoom) < 0.0004 &&
    Math.abs(viewAnim.to.x - canvas.viewport.x) < 0.4 &&
    Math.abs(viewAnim.to.y - canvas.viewport.y) < 0.4
  if (!done) {
    viewAnim.raf = requestAnimationFrame(viewFrame)
  } else {
    canvas.setViewport(viewAnim.to)
    viewAnim.active = false
  }
}

/** 以画布中心为锚的阻尼缩放（工具栏 ± 按钮） */
function zoomAnimated(factor: number) {
  const { w, h } = canvas.containerSize
  const cx = w / 2
  const cy = h / 2
  const tz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, canvas.viewport.zoom * factor))
  const ratio = tz / canvas.viewport.zoom
  animateViewport({
    zoom: tz,
    x: cx - (cx - canvas.viewport.x) * ratio,
    y: cy - (cy - canvas.viewport.y) * ratio,
  })
}

function onWheel(e: WheelEvent) {
  const rect = containerRef.value!.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    startDampedZoom(canvas.viewport.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), cx, cy)
  } else {
    stopViewAnims()
    canvas.panBy(-e.deltaX, -e.deltaY)
  }
}

function onWheelAtWorld(payload: { wx: number; wy: number; deltaY: number }) {
  const cx = payload.wx * canvas.viewport.zoom + canvas.viewport.x
  const cy = payload.wy * canvas.viewport.zoom + canvas.viewport.y
  startDampedZoom(canvas.viewport.zoom * (payload.deltaY < 0 ? 1.1 : 1 / 1.1), cx, cy)
}

// —— 方案对比：把同源方案画板对齐排版 + 压暗其余 + 角标 ——
const compareIds = ref<string[]>([])
const compareActive = computed(() => compareIds.value.length >= 2)
const compareIdSet = computed(() => new Set(compareIds.value))

/** 同源方案分组（parent + 其子画板）：优先取选中画板所在组；computed 缓存，避免每帧每画板重算 */
const compareGroup = computed<Artboard[] | null>(() => {
  const byParent = new Map<string, Artboard[]>()
  for (const b of ws.artboards) {
    if (!b.parent) continue
    const arr = byParent.get(b.parent) ?? []
    arr.push(b)
    byParent.set(b.parent, arr)
  }
  const groups: Artboard[][] = []
  for (const [pid, arr] of byParent) {
    const p = ws.findArtboard(pid)
    const full = p ? [p, ...arr] : arr
    if (full.length >= 2) groups.push(full)
  }
  if (!groups.length) return null
  const sel = ws.findArtboard(canvas.selectedArtboardId)
  if (sel) {
    const hit = groups.find((g) => g.some((b) => b.id === sel.id))
    if (hit) return hit
  }
  return groups[0]
})

/** 对比模式下各画板角标：按创建顺序编号 方案 A/B/C… */
const compareBadges = computed(() => {
  const map = new Map<string, string>()
  if (!compareActive.value || !compareGroup.value) return map
  const ordered = [...compareGroup.value].sort((a, b) => a.createdAt - b.createdAt)
  ordered.forEach((b, i) => map.set(b.id, `方案 ${String.fromCharCode(65 + i)}`))
  return map
})

function toggleCompare() {
  if (compareActive.value) {
    compareIds.value = []
    return
  }
  const g = compareGroup.value
  if (!g) return
  compareIds.value = g.map((b) => b.id)
  // 对齐排版：同一行，横向等距，按创建顺序（方案 A/B/C）
  const ordered = [...g].sort((a, b) => a.createdAt - b.createdAt)
  const minY = Math.min(...ordered.map((b) => b.y))
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1]
    const b = ordered[i]
    const nx = prev.x + prev.width + 60
    if (b.x !== nx || b.y !== minY) ws.moveArtboard(b.id, nx, minY)
  }
  const minX = ordered[0].x
  const maxX = Math.max(...ordered.map((b) => b.x + b.width))
  const bh = Math.max(...ordered.map((b) => b.height))
  animateViewport(fitRect(minX, minY, maxX - minX, bh, 100))
}

// —— 全局快捷键（window 事件 + iframe 内 bridge 转发共用）——
function hostInEditable(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

async function handleHotkey(key: string, mods: { ctrl: boolean; meta: boolean; shift?: boolean }) {
  const selected = ws.findArtboard(canvas.selectedArtboardId)

  // 方向键微移选中画板（多选整体移动，Shift = 10px 步进）
  const ARROW_DELTAS: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }
  if (ARROW_DELTAS[key]) {
    const ids = canvas.multi.length ? canvas.multi : selected ? [selected.id] : []
    if (!ids.length) return
    const [dx, dy] = ARROW_DELTAS[key]
    const step = mods.shift ? 10 : 1
    for (const id of ids) {
      const b = ws.findArtboard(id)
      if (b) ws.moveArtboard(id, b.x + dx * step, b.y + dy * step)
    }
    return
  }

  if (key === 'd' && (mods.ctrl || mods.meta)) {
    if (selected) {
      ws.duplicateArtboard(selected.id)
      antMessage.success('已创建副本，可在副本上尝试不同方案')
    }
    return
  }
  // Ctrl+A 全选画板（进入多选态）
  if (key === 'a' && (mods.ctrl || mods.meta)) {
    if (ws.artboards.length) {
      canvas.setMulti(ws.artboards.map((b) => b.id))
      canvas.select(ws.artboards[0].id)
    }
    return
  }
  // Ctrl+C 复制 / Ctrl+V 粘贴（含全部版本，可重复粘贴）
  if (key === 'c' && (mods.ctrl || mods.meta)) {
    if (selected) canvas.clipboard = JSON.parse(JSON.stringify(selected))
    return
  }
  if (key === 'v' && (mods.ctrl || mods.meta)) {
    if (canvas.clipboard) {
      const copy = await ws.pasteArtboard(canvas.clipboard)
      const src = canvas.clipboard
      canvas.clipboard = { ...JSON.parse(JSON.stringify(src)), x: src.x + 48, y: src.y + 48 }
      canvas.select(copy.id)
      antMessage.success(`已粘贴「${copy.title}」`)
    }
    return
  }
  if (key === 'Escape') {
    if (compareActive.value) {
      compareIds.value = []
      return
    }
    canvas.select(null)
    canvas.clearMulti()
    canvas.fireEsc()
    return
  }
  if (key === '0') {
    animateViewport({ zoom: 1, x: 0, y: 0 })
    return
  }
  if (key === '1' || key === '!') {
    fitAll()
    return
  }
  if (key === 'Delete' || key === 'Backspace') {
    // 多选批量删除优先
    if (canvas.multi.length > 1) {
      const busy = canvas.multi.filter((id) => canvas.generating.some((g) => g.artboardId === id))
      if (busy.length) return
      if (window.confirm(`删除选中的 ${canvas.multi.length} 块画板？此操作不可撤销。`)) {
        const ids = [...canvas.multi]
        canvas.select(null)
        for (const id of ids) await ws.removeArtboard(id)
        canvas.clearMulti()
        antMessage.success(`已删除 ${ids.length} 块画板`)
      }
      return
    }
    if (selected) {
      if (canvas.generating.some((g) => g.artboardId === selected.id)) return
      if (window.confirm(`删除画板「${selected.title}」？此操作不可撤销。`)) {
        ws.removeArtboard(selected.id)
        canvas.select(null)
      }
    }
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  if (hostInEditable()) return
  if (e.repeat && !e.key.startsWith('Arrow')) return
  const interesting =
    e.key === 'Escape' ||
    e.key === 'Delete' ||
    e.key === 'Backspace' ||
    e.key === '0' ||
    e.key === '1' ||
    e.key === '!' ||
    e.key.startsWith('Arrow') ||
    ((e.ctrlKey || e.metaKey) &&
      ['d', 'D', 'a', 'A', 'c', 'C', 'v', 'V'].includes(e.key))
  if (!interesting) return
  if (e.key !== 'Escape') e.preventDefault()
  handleHotkey(e.key, { ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey })
}

function onFrameKey(payload: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  handleHotkey(payload.key, { ctrl: payload.ctrlKey, meta: payload.metaKey })
}

// —— 平移（中键 / Space + 拖拽空白区域）与框选（左键拖拽空白区域）——
const panning = ref(false)
let panLast = { x: 0, y: 0 }
let panMoved = false
const spaceHeld = ref(false)
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
let marqueeShift = false
// 框选手势期间缓存容器原点，避免 pointermove 高频读 getBoundingClientRect
let marqueeOrigin = { left: 0, top: 0 }

const marqueeStyle = computed(() => {
  if (!marquee.value) return {}
  const m = marquee.value
  return {
    left: `${Math.min(m.x0, m.x1)}px`,
    top: `${Math.min(m.y0, m.y1)}px`,
    width: `${Math.abs(m.x1 - m.x0)}px`,
    height: `${Math.abs(m.y1 - m.y0)}px`,
  }
})

onMounted(() => window.addEventListener('keydown', onSpaceKey, true))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onSpaceKey, true)
  window.removeEventListener('keyup', onSpaceUp, true)
})
function onSpaceKey(e: KeyboardEvent) {
  if (e.code !== 'Space' || hostInEditable()) return
  e.preventDefault()
  spaceHeld.value = true
  window.addEventListener('keyup', onSpaceUp, true)
}
function onSpaceUp(e: KeyboardEvent) {
  if (e.code !== 'Space') return
  spaceHeld.value = false
  window.removeEventListener('keyup', onSpaceUp, true)
}

function onPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement
  const onBackground = target === containerRef.value || target.classList.contains('ic-world')
  if (!onBackground || (e.button !== 0 && e.button !== 1)) return
  stopViewAnims()
  if (e.button === 1 || spaceHeld.value) {
    panning.value = true
    panMoved = false
    panLast = { x: e.clientX, y: e.clientY }
    containerRef.value!.setPointerCapture(e.pointerId)
  } else {
    const rect = containerRef.value!.getBoundingClientRect()
    marqueeOrigin = { left: rect.left, top: rect.top }
    marquee.value = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top }
    marqueeShift = e.shiftKey
    containerRef.value!.setPointerCapture(e.pointerId)
  }
}
function onPointerMove(e: PointerEvent) {
  if (panning.value) {
    const dx = e.clientX - panLast.x
    const dy = e.clientY - panLast.y
    if (Math.abs(dx) + Math.abs(dy) > 2) panMoved = true
    canvas.panBy(dx, dy)
    panLast = { x: e.clientX, y: e.clientY }
    return
  }
  if (marquee.value) {
    marquee.value = { ...marquee.value, x1: e.clientX - marqueeOrigin.left, y1: e.clientY - marqueeOrigin.top }
  }
}
function onPointerUp() {
  if (panning.value) {
    panning.value = false
    if (!panMoved) canvas.select(null)
    return
  }
  if (marquee.value) {
    const m = marquee.value
    const vp = canvas.viewport
    // 极小位移视为普通点击：清选（Shift 保留多选），不弹框
    const isClick = Math.abs(m.x1 - m.x0) + Math.abs(m.y1 - m.y0) < 4
    const wx0 = (Math.min(m.x0, m.x1) - vp.x) / vp.zoom
    const wy0 = (Math.min(m.y0, m.y1) - vp.y) / vp.zoom
    const wx1 = (Math.max(m.x0, m.x1) - vp.x) / vp.zoom
    const wy1 = (Math.max(m.y0, m.y1) - vp.y) / vp.zoom
    let hits = ws.artboards
      .filter((b) => b.x < wx1 && b.x + b.width > wx0 && b.y < wy1 && b.y + b.height > wy0)
      .map((b) => b.id)
    // 对比模式下压暗的画板不可选
    if (compareActive.value) hits = hits.filter((id) => compareIds.value.includes(id))
    const base = marqueeShift ? canvas.multi.filter((id) => !hits.includes(id)) : []
    const merged = [...new Set([...base, ...hits])]
    if (!isClick && merged.length) {
      canvas.setMulti(merged)
      canvas.select(merged[0])
    } else if (!marqueeShift) {
      canvas.select(null)
      canvas.clearMulti()
    }
    marquee.value = null
  }
}

// —— 适配全部 ——
function fitAll() {
  const boards = ws.artboards
  if (!boards.length || !containerRef.value) {
    animateViewport({ zoom: 1, x: 0, y: 0 })
    return
  }
  const minX = Math.min(...boards.map((b) => b.x))
  const minY = Math.min(...boards.map((b) => b.y))
  const maxX = Math.max(...boards.map((b) => b.x + b.width))
  const maxY = Math.max(...boards.map((b) => b.y + b.height))
  const bw = maxX - minX
  const bh = maxY - minY
  const { w, h } = canvas.containerSize
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - 120) / bw, (h - 120) / bh, 1)))
  animateViewport({
    zoom,
    x: w / 2 - ((minX + maxX) / 2) * zoom,
    y: h / 2 - ((minY + maxY) / 2) * zoom,
  })
}

// 画板首次出现（打开项目 / 新建第一块画板）且容器尺寸就绪时，自动适配一次
watch(
  [() => ws.artboards.length, () => canvas.containerSize.w] as const,
  ([count, w], [prevCount, prevW]) => {
    if (count > 0 && w > 0 && (prevCount === 0 || prevW === 0)) fitAll()
  },
  { immediate: true, flush: 'post' },
)

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  resizeObserver = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect
    if (r) canvas.setContainerSize(r.width, r.height)
  })
  if (containerRef.value) resizeObserver.observe(containerRef.value)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  resizeObserver?.disconnect()
  stopViewAnims()
})
</script>

<template>
  <div
    ref="containerRef"
    class="ic-root"
    :class="{ 'space-pan': spaceHeld }"
    :style="gridStyle"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="ic-world" :style="worldStyle">
      <ArtboardNode
        v-for="(b, i) in ws.artboards"
        :key="b.id"
        :artboard="b"
        :style="{ '--enter-delay': `${Math.min(i, 10) * 50}ms` }"
        :dimmed="compareActive && !compareIds.includes(b.id)"
        :badge="compareBadges.get(b.id)"
        @wheel-at-world="onWheelAtWorld"
        @key-at-host="onFrameKey"
      />
    </div>

    <svg class="ic-links" aria-hidden="true">
      <path
        v-for="l in links"
        :key="l.id"
        :d="l.d"
        class="link"
        @click="focusBoard(l.childId)"
      >
        <title>点击聚焦衍生画板</title>
      </path>
    </svg>

    <div class="ic-guides" aria-hidden="true">
      <div
        v-for="(x, i) in canvas.guides.v"
        :key="'v' + i"
        class="guide guide-v"
        :style="{ left: `${x * canvas.viewport.zoom + canvas.viewport.x}px` }"
      />
      <div
        v-for="(y, i) in canvas.guides.h"
        :key="'h' + i"
        class="guide guide-h"
        :style="{ top: `${y * canvas.viewport.zoom + canvas.viewport.y}px` }"
      />
    </div>

    <div v-if="marquee" class="ic-marquee" :style="marqueeStyle" aria-hidden="true" />

    <div class="ic-controls">
      <button
        v-if="compareGroup"
        class="cmp"
        :class="{ on: compareActive }"
        :title="compareActive ? '退出方案对比（Esc）' : '方案对比：对齐排版同源方案'"
        @click="toggleCompare"
      >
        <AppIcon name="copy" :size="13" />
        {{ compareActive ? '退出对比' : '方案对比' }}
      </button>
      <span v-if="compareGroup" class="divider" />
      <button title="缩小" @click="zoomAnimated(1 / 1.2)">−</button>
      <button class="pct" title="重置缩放（快捷键 0）" @click="animateViewport({ zoom: 1, x: 0, y: 0 })">{{ zoomPercent }}</button>
      <button title="放大" @click="zoomAnimated(1.2)">＋</button>
      <span class="divider" />
      <button title="适配全部画板（快捷键 1）" @click="fitAll">⛶</button>
    </div>

    <div v-if="!ws.artboards.length" class="ic-empty">
      <div class="empty-icon"><AppIcon name="frame" :size="40" /></div>
      <p>画布还是空的</p>
      <p class="sub">在左侧聊天里描述你想要的页面，AI 会在这里生成原型画板</p>
    </div>
  </div>
</template>

<style scoped>
.ic-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: var(--bg-canvas);
  background-image: radial-gradient(circle, var(--canvas-dot) 1px, transparent 1px);
  cursor: default;
  touch-action: none;
}
.ic-world {
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
}
.ic-links {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.ic-links .link {
  fill: none;
  stroke: rgba(176, 92, 242, 0.35);
  stroke-width: 1.5;
  pointer-events: stroke;
  cursor: pointer;
}
.ic-links .link:hover {
  stroke: var(--accent);
  stroke-width: 2.5;
}
.ic-guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 20;
}
.guide {
  position: absolute;
  background: rgba(176, 92, 242, 0.7);
}
.guide-v {
  top: 0;
  bottom: 0;
  width: 1px;
}
.guide-h {
  left: 0;
  right: 0;
  height: 1px;
}
.ic-marquee {
  position: absolute;
  z-index: 25;
  border: 1px solid rgba(176, 92, 242, 0.8);
  background: rgba(176, 92, 242, 0.08);
  border-radius: 2px;
  pointer-events: none;
}
.ic-root.space-pan {
  cursor: grab;
}
.ic-root.space-pan:active {
  cursor: grabbing;
}
.ic-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  background: rgba(22, 22, 22, 0.88);
  backdrop-filter: blur(10px);
  border: none;
  border-radius: 10px;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.08),
    0 10px 32px rgba(0, 0, 0, 0.45);
  padding: 4px;
  gap: 2px;
}
.ic-controls button {
  border: none;
  background: transparent;
  min-width: 30px;
  height: 28px;
  border-radius: 7px;
  font-size: 15px;
  color: var(--ink-2);
  cursor: pointer;
  font-family: var(--mono);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.ic-controls button:hover {
  background: var(--active);
  color: var(--ink);
}
.ic-controls .pct {
  font-size: 12px;
  min-width: 48px;
  letter-spacing: 0.02em;
}
.ic-controls .divider {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 4px;
}
.ic-controls .cmp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--sans);
  font-size: 12px;
  padding: 0 10px;
  height: 28px;
}
.ic-controls .cmp.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.ic-empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
}
.empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 16px;
  color: var(--ink-3);
  box-shadow: var(--btn-quiet-shadow);
  background: rgba(255, 255, 255, 0.03);
  margin-bottom: 10px;
}
.ic-empty p {
  font-family: var(--display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-2);
  margin: 0;
}
.ic-empty .sub {
  font-family: var(--sans);
  font-size: 13px;
  font-weight: 400;
  color: var(--ink-3);
}
</style>
