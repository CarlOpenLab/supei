<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { message as antMessage } from 'antdv-next'
import { useCanvasStore, MAX_ZOOM, MIN_ZOOM } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
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
  const out: Array<{ id: string; d: string }> = []
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
      d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`,
    })
  }
  return out
})

// —— 缩放（容器内坐标）——
function onWheel(e: WheelEvent) {
  const rect = containerRef.value!.getBoundingClientRect()
  const cx = e.clientX - rect.left
  const cy = e.clientY - rect.top
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault()
    canvas.zoomAt(cx, cy, e.deltaY < 0 ? 1.1 : 1 / 1.1)
  } else {
    canvas.panBy(-e.deltaX, -e.deltaY)
  }
}

function onWheelAtWorld(payload: { wx: number; wy: number; deltaY: number }) {
  const cx = payload.wx * canvas.viewport.zoom + canvas.viewport.x
  const cy = payload.wy * canvas.viewport.zoom + canvas.viewport.y
  canvas.zoomAt(cx, cy, payload.deltaY < 0 ? 1.1 : 1 / 1.1)
}

// —— 全局快捷键（window 事件 + iframe 内 bridge 转发共用）——
function hostInEditable(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable
}

function handleHotkey(key: string, mods: { ctrl: boolean; meta: boolean }) {
  const selected = ws.findArtboard(canvas.selectedArtboardId)

  if (key === 'd' && (mods.ctrl || mods.meta)) {
    if (selected) {
      ws.duplicateArtboard(selected.id)
      antMessage.success('已创建副本，可在副本上尝试不同方案')
    }
    return
  }
  if (key === 'Escape') {
    canvas.select(null)
    canvas.fireEsc()
    return
  }
  if (key === '0') {
    canvas.resetZoom()
    return
  }
  if (key === '1' || key === '!') {
    fitAll()
    return
  }
  if ((key === 'Delete' || key === 'Backspace') && selected) {
    if (canvas.generating.some((g) => g.artboardId === selected.id)) return
    if (window.confirm(`删除画板「${selected.title}」？此操作不可撤销。`)) {
      ws.removeArtboard(selected.id)
      canvas.select(null)
    }
  }
}

function onWindowKeydown(e: KeyboardEvent) {
  if (hostInEditable()) return
  if (e.repeat) return
  const interesting =
    e.key === 'Escape' ||
    e.key === 'Delete' ||
    e.key === 'Backspace' ||
    e.key === '0' ||
    e.key === '1' ||
    e.key === '!' ||
    ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D'))
  if (!interesting) return
  if (e.key !== 'Escape') e.preventDefault()
  handleHotkey(e.key, { ctrl: e.ctrlKey, meta: e.metaKey })
}

function onFrameKey(payload: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  handleHotkey(payload.key, { ctrl: payload.ctrlKey, meta: payload.metaKey })
}

// —— 平移（拖拽空白区域）——
const panning = ref(false)
let panLast = { x: 0, y: 0 }
let panMoved = false

function onPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement
  const onBackground = target === containerRef.value || target.classList.contains('ic-world')
  if (!onBackground || (e.button !== 0 && e.button !== 1)) return
  panning.value = true
  panMoved = false
  panLast = { x: e.clientX, y: e.clientY }
  containerRef.value!.setPointerCapture(e.pointerId)
}
function onPointerMove(e: PointerEvent) {
  if (!panning.value) return
  const dx = e.clientX - panLast.x
  const dy = e.clientY - panLast.y
  if (Math.abs(dx) + Math.abs(dy) > 2) panMoved = true
  canvas.panBy(dx, dy)
  panLast = { x: e.clientX, y: e.clientY }
}
function onPointerUp() {
  if (!panning.value) return
  panning.value = false
  if (!panMoved) canvas.select(null)
}

// —— 适配全部 ——
function fitAll() {
  const boards = ws.artboards
  if (!boards.length || !containerRef.value) {
    canvas.setViewport({ x: 0, y: 0, zoom: 1 })
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
  canvas.setViewport({
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
})
</script>

<template>
  <div
    ref="containerRef"
    class="ic-root"
    :style="gridStyle"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="ic-world" :style="worldStyle">
      <ArtboardNode
        v-for="b in ws.artboards"
        :key="b.id"
        :artboard="b"
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
      />
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

    <div class="ic-controls">
      <button title="缩小" @click="canvas.zoomStep(-1)">−</button>
      <button class="pct" title="重置缩放（快捷键 0）" @click="canvas.resetZoom()">{{ zoomPercent }}</button>
      <button title="放大" @click="canvas.zoomStep(1)">＋</button>
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
  stroke: rgba(255, 107, 71, 0.35);
  stroke-width: 1.5;
}
.ic-guides {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 20;
}
.guide {
  position: absolute;
  background: rgba(255, 107, 71, 0.7);
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
.ic-controls {
  position: absolute;
  right: 16px;
  bottom: 16px;
  display: flex;
  align-items: center;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-float);
  padding: 4px;
  gap: 2px;
}
.ic-controls button {
  border: none;
  background: transparent;
  min-width: 30px;
  height: 28px;
  border-radius: var(--radius-s);
  font-size: 15px;
  color: var(--ink-2);
  cursor: pointer;
  font-family: var(--mono);
}
.ic-controls button:hover {
  background: var(--active);
  color: var(--ink);
}
.ic-controls .pct {
  font-size: 12px;
  min-width: 48px;
}
.ic-controls .divider {
  width: 1px;
  height: 18px;
  background: var(--line);
  margin: 0 4px;
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
  color: rgba(255, 255, 255, 0.2);
  margin-bottom: 6px;
}
.ic-empty p {
  font-size: 15px;
  color: var(--ink-2);
  margin: 0;
}
.ic-empty .sub {
  font-size: 13px;
  color: var(--ink-3);
}
</style>
