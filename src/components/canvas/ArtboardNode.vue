<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { message, Spin, Tooltip } from 'antdv-next'
import type { Artboard, ElementContext, WheelPayload } from '@/types'
import { useCanvasStore } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
import { sendElementFeedback } from '@/services/orchestrator'
import { getDesktopBridge } from '@/services/desktop'
import { HEADER_H } from './constants'
import PrototypeFrame from './PrototypeFrame.vue'
import ElementCommentBubble from './ElementCommentBubble.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import VersionCompareModal from './VersionCompareModal.vue'

const props = defineProps<{ artboard: Artboard }>()
const emit = defineEmits<{
  (e: 'wheel-at-world', payload: { wx: number; wy: number; deltaY: number }): void
  (e: 'key-at-host', payload: { key: string; ctrlKey: boolean; metaKey: boolean }): void
}>()

const canvas = useCanvasStore()
const ws = useWorkspaceStore()

const board = computed(() => props.artboard)
const selected = computed(() => canvas.selectedArtboardId === board.value.id)
const streamingEntry = computed(() =>
  canvas.generating.find((g) => g.artboardId === board.value.id),
)
const isStreaming = computed(() => streamingEntry.value !== undefined)

const PLACEHOLDER = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#15171b;color:#9a9da4;
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;letter-spacing:.5px}
</style></head><body><div>空画板 — 在左侧聊天中描述你想要的页面</div></body></html>`

const displayHtml = computed(() => {
  if (isStreaming.value) return streamingEntry.value?.html || PLACEHOLDER
  return ws.currentVersionOf(board.value)?.html ?? PLACEHOLDER
})

/** 骨架屏：生成已开始但流式内容尚未到达 */
const flash = ref(false)
watch(isStreaming, (now, was) => {
  if (was && !now) {
    flash.value = true
    setTimeout(() => (flash.value = false), 950)
  }
})

const showSkeleton = computed(
  () => isStreaming.value && !streamingEntry.value?.html,
)

// —— 版本导航 ——
const versionIdx = computed(() => {
  const list = board.value.versions
  const i = list.findIndex((v) => v.id === board.value.currentVersionId)
  return i >= 0 ? i + 1 : 0
})
const canPrev = computed(() => versionIdx.value > 1)
const canNext = computed(() => versionIdx.value > 0 && versionIdx.value < board.value.versions.length)

function stepVersion(dir: -1 | 1) {
  const list = board.value.versions
  const target = list[versionIdx.value - 1 + dir]
  if (target) ws.setCurrentVersion(board.value.id, target.id)
}

// —— 头栏标题内联编辑 ——
const editing = ref(false)
const titleDraft = ref('')
function startEdit() {
  titleDraft.value = board.value.title
  editing.value = true
}
function commitEdit() {
  const t = titleDraft.value.trim()
  if (t) board.value.title = t
  editing.value = false
  ws.persistArtboard(board.value.id)
}

// —— 画板拖拽（带对齐吸附与参考线）——
const dragging = ref(false)
let dragStart = { x: 0, y: 0, main: { x: 0, y: 0 }, others: [] as Array<{ id: string; x: number; y: number }> }

function snapAxis(
  pos: number,
  size: number,
  others: Array<{ p: number; size: number }>,
  threshold: number,
): { value: number; lines: number[] } {
  const lines: number[] = []
  let value = pos
  for (const o of others) {
    for (const target of [o.p, o.p + o.size / 2, o.p + o.size]) {
      for (const edge of [value, value + size / 2, value + size]) {
        const d = target - edge
        if (Math.abs(d) <= threshold) {
          value += d
          lines.push(target)
        }
      }
    }
  }
  return { value, lines }
}

function onHeaderPointerDown(e: PointerEvent) {
  if (e.button !== 0 || editing.value) return
  // Shift+头栏：把画板加入多选（不启动拖动）
  if (e.shiftKey) {
    canvas.toggleMulti(board.value.id)
    return
  }
  const group = canvas.multi.includes(board.value.id)
    ? canvas.multi
    : [board.value.id]
  dragStart = {
    x: e.clientX,
    y: e.clientY,
    main: { x: board.value.x, y: board.value.y },
    others: group
      .filter((id) => id !== board.value.id)
      .map((id) => {
        const b = ws.findArtboard(id)
        return { id, x: b?.x ?? 0, y: b?.y ?? 0 }
      }),
  }
  dragging.value = true
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function onHeaderPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const z = canvas.viewport.zoom
  const dx = (e.clientX - dragStart.x) / z
  const dy = (e.clientY - dragStart.y) / z
  const nx = dragStart.main.x + dx
  const ny = dragStart.main.y + dy
  // 多选拖动：整组平移，不吸附
  if (dragStart.others.length) {
    ws.moveArtboard(board.value.id, nx, ny)
    for (const o of dragStart.others) ws.moveArtboard(o.id, o.x + dx, o.y + dy)
    return
  }
  // 单选拖动：对齐吸附 + 参考线
  const threshold = 6 / z
  const others = ws.artboards
    .filter((b) => b.id !== board.value.id)
    .map((b) => ({ p: b.x, size: b.width }))
  const xSnap = snapAxis(nx, board.value.width, others, threshold)
  const othersY = ws.artboards
    .filter((b) => b.id !== board.value.id)
    .map((b) => ({ p: b.y, size: b.height }))
  const ySnap = snapAxis(ny, board.value.height, othersY, threshold)
  ws.moveArtboard(board.value.id, xSnap.value, ySnap.value)
  canvas.setGuides(xSnap.lines, ySnap.lines)
}
function onHeaderPointerUp() {
  if (!dragging.value) return
  dragging.value = false
  canvas.clearGuides()
  ws.persistArtboard(board.value.id)
  for (const o of dragStart.others) ws.persistArtboard(o.id)
}

// —— 元素点选与评论 ——
const pendingCtx = ref<ElementContext | null>(null)

function onNodePointerDown(e: PointerEvent) {
  if (e.shiftKey) {
    canvas.toggleMulti(board.value.id)
    if (!canvas.multi.includes(board.value.id)) canvas.select(board.value.id)
    return
  }
  canvas.clearMulti()
  canvas.select(board.value.id)
}

function onSelect(ctx: ElementContext) {
  if (!canvas.selectMode || isStreaming.value) return
  pendingCtx.value = ctx
}

async function onCommentSubmit(text: string) {
  const ctx = pendingCtx.value
  pendingCtx.value = null
  if (ctx) await sendElementFeedback(ctx, text)
}

watch(
  () => [isStreaming.value, canvas.selectMode, board.value.currentVersionId, canvas.escSignal] as const,
  () => {
    pendingCtx.value = null
  },
)

function onFrameWheel(payload: WheelPayload) {
  emit('wheel-at-world', {
    wx: board.value.x + payload.localX,
    wy: board.value.y + HEADER_H + payload.localY,
    deltaY: payload.deltaY,
  })
}

function onFrameKey(payload: { key: string; ctrlKey: boolean; metaKey: boolean }) {
  emit('key-at-host', payload)
}

function toggleSelectMode() {
  canvas.setSelectMode(!canvas.selectMode)
}

// —— 节点菜单 ——
const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const confirmDelete = ref(false)
const compareOpen = ref(false)

const compareVersionIds = computed(() => {
  const list = board.value.versions
  const cur = list.findIndex((v) => v.id === board.value.currentVersionId)
  if (cur <= 0) return null
  return { a: list[cur - 1].id, b: list[cur].id }
})

function closeOnOutside(e: PointerEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
    menuOpen.value = false
    confirmDelete.value = false
  }
}
watch(menuOpen, (open) => {
  if (open) document.addEventListener('pointerdown', closeOnOutside, true)
  else document.removeEventListener('pointerdown', closeOnOutside, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', closeOnOutside, true))

function currentHtml(): string {
  return ws.currentVersionOf(board.value)?.html ?? ''
}
function exportHtml() {
  const html = currentHtml()
  if (!html) return
  menuOpen.value = false
  getDesktopBridge().then(async (bridge) => {
    if (bridge) {
      // 桌面壳：原生保存对话框
      const path = await bridge.Storage.saveHTML(board.value.title, html)
      if (path) message.success(`已保存到 ${path}`)
      return
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${board.value.title}.html`
    a.click()
    URL.revokeObjectURL(a.href)
  })
}
async function copyCode() {
  const html = currentHtml()
  if (!html) return
  await navigator.clipboard.writeText(html)
  message.success('已复制 HTML 代码')
  menuOpen.value = false
}
async function duplicate() {
  await ws.duplicateArtboard(board.value.id)
  message.success('已创建副本，可在副本上尝试不同方案')
  menuOpen.value = false
}
async function doDelete() {
  await ws.removeArtboard(board.value.id)
  if (canvas.selectedArtboardId === board.value.id) canvas.select(null)
  menuOpen.value = false
}
</script>

<template>
  <div
    class="artboard"
    :class="{ selected, streaming: isStreaming, flash }"
    :style="{ left: `${board.x}px`, top: `${board.y}px`, width: `${board.width}px`, height: `${board.height}px` }"
    @pointerdown.stop="onNodePointerDown"
  >
    <header
      class="ab-header"
      :class="{ dragging }"
      @pointerdown="onHeaderPointerDown"
      @pointermove="onHeaderPointerMove"
      @pointerup="onHeaderPointerUp"
      @pointercancel="onHeaderPointerUp"
    >
      <input
        v-if="editing"
        v-model="titleDraft"
        class="ab-title-input"
        size="14"
        @keydown.enter.prevent="commitEdit"
        @blur="commitEdit"
        @pointerdown.stop
        @dblclick.stop
      />
      <span v-else class="ab-title" :title="board.title" @dblclick.stop="startEdit">{{ board.title }}</span>

      <span class="ab-versions" @pointerdown.stop>
        <button class="nav" :disabled="!canPrev" title="上一版" @click="stepVersion(-1)">‹</button>
        <b>{{ versionIdx || '–' }}</b>
        <i>/ {{ board.versions.length }}</i>
        <button class="nav" :disabled="!canNext" title="下一版" @click="stepVersion(1)">›</button>
      </span>

      <span class="flex1" />
      <Spin v-if="isStreaming" size="small" />
      <Tooltip :title="canvas.selectMode ? '点选模式已开启：点击页面元素定向反馈' : '开启点选模式'">
        <button class="tool" :class="{ on: canvas.selectMode }" @pointerdown.stop @click.stop="toggleSelectMode">
          <AppIcon name="cursor" :size="14" />
        </button>
      </Tooltip>
      <button class="tool" @pointerdown.stop @click.stop="menuOpen = !menuOpen">
        <AppIcon name="dots" :size="14" />
      </button>
    </header>

    <div class="ab-body" :style="{ height: `${board.height - HEADER_H}px` }">
      <PrototypeFrame
        :html="displayHtml"
        :select-mode="canvas.selectMode"
        :streaming="isStreaming"
        @select="onSelect"
        @frame-wheel="onFrameWheel"
        @frame-key="onFrameKey"
      />
      <div v-if="showSkeleton" class="stream-skeleton">
        <div class="sk sk-title" />
        <div class="sk sk-line w55" />
        <div class="sk sk-line w80" />
        <div class="sk sk-block" />
        <div class="sk sk-line w70" />
        <div class="sk sk-line w45" />
      </div>
      <div v-if="isStreaming" class="stream-bar" />
    </div>

    <ElementCommentBubble
      v-if="pendingCtx"
      :ctx="pendingCtx"
      :artboard-width="board.width"
      @submit="onCommentSubmit"
      @cancel="pendingCtx = null"
    />
  </div>

  <VersionCompareModal
    v-if="compareVersionIds"
    :open="compareOpen"
    :board="board"
    :version-a="compareVersionIds.a"
    :version-b="compareVersionIds.b"
    @update:open="compareOpen = $event"
  />

  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuRef"
      class="ab-menu"
      :style="{
        left: `${board.x * canvas.viewport.zoom + canvas.viewport.x + board.width * canvas.viewport.zoom - 12}px`,
        top: `${board.y * canvas.viewport.zoom + canvas.viewport.y + HEADER_H + 6}px`,
      }"
      @pointerdown.stop
    >
      <button v-if="compareVersionIds" @click="compareOpen = true">对比上一版</button>
      <button v-if="board.versions.length" @click="exportHtml">导出 .html</button>
      <button v-if="board.versions.length" @click="copyCode">复制代码</button>
      <button @click="duplicate">创建副本</button>
      <div class="menu-divider" />
      <template v-if="!confirmDelete">
        <button class="danger" @click="confirmDelete = true">删除画板…</button>
      </template>
      <template v-else>
        <button class="danger solid" @click="doDelete">确认删除</button>
        <button @click="confirmDelete = false">取消</button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.artboard {
  position: absolute;
  background: #fff;
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  overflow: visible;
  outline: 1px solid rgba(20, 18, 14, 0.08);
  animation: enter var(--dur) var(--ease);
}
.artboard.selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.ab-header {
  height: 40px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line);
  border-radius: var(--radius-m) var(--radius-m) 0 0;
  background: var(--bg-elevated);
  cursor: grab;
  user-select: none;
}
.ab-header.dragging {
  cursor: grabbing;
}
.ab-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--ink);
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ab-title-input {
  font-size: 13px;
  width: 150px;
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  padding: 2px 6px;
  outline: none;
  background: var(--bg-raised);
  color: var(--ink);
}
.ab-versions {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-2);
  font-family: var(--mono);
}
.ab-versions b {
  color: var(--accent);
  font-weight: 600;
}
.ab-versions i {
  font-style: normal;
  color: var(--ink-2);
  opacity: 0.7;
}
button.nav {
  border: none;
  background: transparent;
  font-size: 16px;
  line-height: 1;
  color: var(--ink-2);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  font-family: var(--mono);
}
button.nav:hover:not(:disabled) {
  background: var(--hover);
  color: var(--ink);
}
button.nav:disabled {
  color: rgba(27, 27, 30, 0.2);
  cursor: default;
}
.flex1 {
  flex: 1;
}
button.tool {
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  border-radius: var(--radius-s);
  font-size: 15px;
  line-height: 1;
  color: var(--ink-2);
  cursor: pointer;
}
button.tool:hover {
  background: var(--hover);
  color: var(--ink);
}
button.tool.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.artboard.flash {
  animation: flash-ring 0.9s var(--ease);
}
@keyframes flash-ring {
  0% {
    box-shadow: 0 0 0 3px var(--accent), var(--shadow-card);
  }
  100% {
    box-shadow: 0 0 0 0 transparent, var(--shadow-card);
  }
}
.ab-body {
  position: relative;
  border-radius: 0 0 var(--radius-m) var(--radius-m);
  overflow: hidden;
}
.stream-skeleton {
  position: absolute;
  inset: 0;
  background: #fbfbfc;
  padding: 48px 56px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  z-index: 2;
}
.sk {
  border-radius: 6px;
  background: linear-gradient(100deg, #ececef 40%, #f4f4f6 50%, #ececef 60%);
  background-size: 200% 100%;
  animation: sk-pulse 1.4s var(--ease) infinite;
}
@keyframes sk-pulse {
  from {
    background-position: 180% 0;
  }
  to {
    background-position: -80% 0;
  }
}
.sk-title {
  height: 44px;
  width: 46%;
  margin-bottom: 14px;
}
.sk-line {
  height: 13px;
}
.sk-block {
  height: 160px;
  border-radius: 10px;
  margin: 8px 0;
}
.w45 { width: 45%; }
.w55 { width: 55%; }
.w70 { width: 70%; }
.w80 { width: 80%; }
.stream-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  background-size: 40% 100%;
  background-repeat: no-repeat;
  animation: slide 1.2s linear infinite;
}
@keyframes slide {
  from {
    background-position: -40% 0;
  }
  to {
    background-position: 140% 0;
  }
}
</style>

<style>
.ab-menu {
  position: fixed;
  z-index: 1000;
  min-width: 140px;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-float);
  padding: 4px;
  display: flex;
  flex-direction: column;
}
.ab-menu button {
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--ink);
  padding: 7px 10px;
  border-radius: var(--radius-s);
  cursor: pointer;
}
.ab-menu button:hover {
  background: var(--bg-raised);
}
.ab-menu button.danger {
  color: var(--accent);
}
.ab-menu button.danger.solid {
  background: var(--accent-deep);
  color: #fff;
}
.ab-menu button.danger.solid:hover {
  background: var(--accent);
}
.menu-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 6px;
}
</style>
