<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch, watchEffect } from 'vue'
import { message, Spin, Tooltip } from 'antdv-next'
import type { Artboard, ElementContext, FrameTool, InspectMeta, WheelPayload } from '@/types'
import { useCanvasStore } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
import { useLiveStore } from '@/stores/live'
import {
  captureLiveBoard,
  commitManualEdits,
  sendElementFeedback,
  sendLiveFeedback,
  writeBackToCode,
} from '@/services/orchestrator'
import { desktopAvailable, getDesktopBridge } from '@/services/desktop'
import { getThumb } from '@/utils/thumb'
import { HEADER_H } from './constants'
import PrototypeFrame from './PrototypeFrame.vue'
import ElementCommentBubble from './ElementCommentBubble.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import VersionCompareModal from './VersionCompareModal.vue'

const props = defineProps<{ artboard: Artboard; dimmed?: boolean; badge?: string }>()
const emit = defineEmits<{
  (e: 'wheel-at-world', payload: { wx: number; wy: number; deltaY: number }): void
  (e: 'key-at-host', payload: { key: string; ctrlKey: boolean; metaKey: boolean }): void
}>()

const canvas = useCanvasStore()
const ws = useWorkspaceStore()
const liveStore = useLiveStore()

const board = computed(() => props.artboard)

// —— 实时画板（本地仓库 dev server / 网页，经桌面端注入代理）——
const isLive = computed(() => board.value.kind === 'live')
const session = computed(() => liveStore.sessions[board.value.id])
const liveSrc = computed(() => {
  const s = session.value
  return s?.status === 'ready' && s.proxyOrigin ? s.proxyOrigin + s.navRoute : undefined
})
const frameRef = ref<InstanceType<typeof PrototypeFrame> | null>(null)
const routeDraft = ref(board.value.live?.route ?? '/')
watch(
  () => board.value.live?.route,
  (r) => {
    if (r !== undefined) routeDraft.value = r
  },
)
const logsOpen = ref(false)
const capturing = ref(false)
const agentWorking = computed(() => canvas.agentRun?.boardId === board.value.id)

/**
 * @description 地址栏回车：规范成以 / 开头的路由后跳转。
 */
function submitRoute() {
  const raw = routeDraft.value.trim() || '/'
  void liveStore.navigate(board.value, raw.startsWith('/') ? raw : `/${raw}`)
}

/**
 * @description 页面内 SPA 导航时同步地址栏与记住的路由（不重载 iframe）。
 * @param path - 页面上报的 path + query + hash
 */
function onLiveLocation(path: string) {
  void liveStore.syncRoute(board.value, path)
}

/**
 * @description 把实时页面当前状态捕获成可编辑的设计稿画板。
 */
async function captureNow() {
  const s = session.value
  if (!frameRef.value || !s?.proxyOrigin || !s.targetOrigin || capturing.value) return
  menuOpen.value = false
  capturing.value = true
  try {
    const snap = await frameRef.value.snapshot()
    await captureLiveBoard(board.value, snap, { proxyOrigin: s.proxyOrigin, targetOrigin: s.targetOrigin })
    message.success('已捕获为设计稿，可继续让 AI 迭代或手动编辑')
  } catch (err) {
    message.error(`捕获失败：${(err as Error).message}`)
  } finally {
    capturing.value = false
  }
}

async function writeBack() {
  menuOpen.value = false
  try {
    await writeBackToCode(board.value.id)
  } catch (err) {
    message.warning((err as Error).message)
  }
}

onBeforeUnmount(() => {
  if (isLive.value) liveStore.stop(board.value.id)
})
const selected = computed(() => canvas.selectedArtboardId === board.value.id)
const multiPicked = computed(() => canvas.multi.includes(board.value.id))

/** 版本 hover 提示：各版本生成时间（格式与时间线一致，函数声明提升可前向引用） */
const versionListTitle = computed(() =>
  board.value.versions
    .map((v, i) => `v${i + 1} · ${fmtVersionTime(v.createdAt)}`)
    .join('\n'),
)
const streamingEntry = computed(() =>
  canvas.generating.find((g) => g.artboardId === board.value.id),
)
const isStreaming = computed(() => streamingEntry.value !== undefined)

const PLACEHOLDER = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#161616;color:#9a9da4;
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;letter-spacing:.5px}
</style></head><body><div>空画板 — 在左侧聊天中描述你想要的页面</div></body></html>`

const displayHtml = computed(() => {
  if (isStreaming.value) return streamingEntry.value?.html || PLACEHOLDER
  return ws.currentVersionOf(board.value)?.html ?? PLACEHOLDER
})

// —— 缩略图 LOD：缩放较小时以静态快照替代活 iframe ——
const LOD_ZOOM = 0.42
const lowZoom = computed(() => canvas.viewport.zoom < LOD_ZOOM)
const thumbUrl = ref<string | null>(null)
const thumbTried = ref('')
const canThumb = computed(() => !isStreaming.value && !!board.value.currentVersionId)
// 版本一变（切换 / AI 生成 / 保存手动修改）：缩略图失效，旧版本上的手动修改与检查选中都失效
watch(
  () => board.value.currentVersionId,
  () => {
    thumbUrl.value = null
    canvas.clearEdits(board.value.id)
    if (canvas.inspect?.artboardId === board.value.id) canvas.clearInspect()
  },
)
watchEffect(() => {
  if (!lowZoom.value || !canThumb.value) return
  const html = displayHtml.value
  const key = (board.value.currentVersionId ?? '') + ':' + html.length
  if (thumbTried.value === key) return
  thumbTried.value = key
  getThumb(key, html, board.value.width, board.value.height).then((u) => {
    if (key === (board.value.currentVersionId ?? '') + ':' + displayHtml.value.length) {
      thumbUrl.value = u
    }
  })
})
const useThumb = computed(() => lowZoom.value && !!thumbUrl.value)

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

// —— 手动编辑：待保存修改 ——
const pendingEdits = computed(() => canvas.editCount(board.value.id))

/**
 * @description 切换版本前确认丢弃未保存的手动修改（修改按元素编号绑定在当前版本上，换版本即失效）。
 * @returns 可以继续切换时为 true
 */
function confirmLeaveEdits(): boolean {
  if (!pendingEdits.value) return true
  return window.confirm(`有 ${pendingEdits.value} 个元素的手动修改尚未保存，切换版本会丢弃它们。继续？`)
}

async function saveEdits() {
  try {
    const v = await commitManualEdits(board.value.id)
    if (v) message.success('手动修改已保存为新版本')
  } catch (err) {
    message.error((err as Error).message)
  }
}

function discardEdits() {
  canvas.clearEdits(board.value.id)
}

function stepVersion(dir: -1 | 1) {
  const list = board.value.versions
  const target = list[versionIdx.value - 1 + dir]
  if (target && confirmLeaveEdits()) ws.setCurrentVersion(board.value.id, target.id)
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
  // 多选拖动：整组平移；组包围盒吸附对齐其它画板（按住 Shift 自由拖动）
  if (dragStart.others.length) {
    if (e.shiftKey) {
      ws.moveArtboard(board.value.id, nx, ny)
      for (const o of dragStart.others) ws.moveArtboard(o.id, o.x + dx, o.y + dy)
      canvas.setGuides([], [])
      return
    }
    const members = [
      { id: board.value.id, x: nx, y: ny, w: board.value.width, h: board.value.height },
      ...dragStart.others.map((o) => {
        const b = ws.findArtboard(o.id)
        return { id: o.id, x: o.x + dx, y: o.y + dy, w: b?.width ?? 0, h: b?.height ?? 0 }
      }),
    ]
    const ids = members.map((m) => m.id)
    const minX = Math.min(...members.map((m) => m.x))
    const minY = Math.min(...members.map((m) => m.y))
    const bw = Math.max(...members.map((m) => m.x + m.w)) - minX
    const bh = Math.max(...members.map((m) => m.y + m.h)) - minY
    const exX = ws.artboards.filter((b) => !ids.includes(b.id)).map((b) => ({ p: b.x, size: b.width }))
    const exY = ws.artboards.filter((b) => !ids.includes(b.id)).map((b) => ({ p: b.y, size: b.height }))
    const threshold = 6 / z
    const sx = snapAxis(minX, bw, exX, threshold)
    const sy = snapAxis(minY, bh, exY, threshold)
    const ddx = sx.value - minX
    const ddy = sy.value - minY
    for (const m of members) ws.moveArtboard(m.id, m.x + ddx, m.y + ddy)
    canvas.setGuides(sx.lines, sy.lines)
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
  if (canvas.tool !== 'comment' || isStreaming.value) return
  pendingCtx.value = ctx
}

/**
 * @description 编辑模式下 iframe 内选中元素：同时选中所在画板（iframe 内点击不会冒泡到宿主）。
 * @param meta - bridge 上报的元素信息
 * @param refresh - 是否为应用修改后的刷新上报
 */
function onInspect(meta: InspectMeta, refresh: boolean) {
  if (canvas.tool !== 'edit' || isStreaming.value) return
  if (!refresh) canvas.select(board.value.id)
  canvas.setInspect(board.value.id, meta, refresh)
}

/**
 * @description 双击就地改字完成后记为一处待保存修改。
 * @param payload - 元素编号与新文字
 */
function onTextEdit(payload: { dcId: string; text: string }) {
  canvas.setEdit(board.value.id, payload.dcId, { text: payload.text })
}

async function onCommentSubmit(text: string) {
  const ctx = pendingCtx.value
  pendingCtx.value = null
  if (!ctx) return
  // 实时画板的反馈交给本机 Agent 改源码；HTML 原型交给 AI 改设计
  if (isLive.value) await sendLiveFeedback(board.value, ctx, text)
  else await sendElementFeedback(ctx, text)
}

watch(
  () => [isStreaming.value, canvas.tool, board.value.currentVersionId, canvas.escSignal] as const,
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

/**
 * @description 切换画板内工具；再次点击当前工具则关闭点选。
 * @param t - 要切换到的工具
 */
function toggleTool(t: Exclude<FrameTool, null>) {
  canvas.setTool(canvas.tool === t ? null : t)
}

// —— 节点菜单 ——
const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)
const menuPos = ref({ x: 0, y: 0 })
const confirmDelete = ref(false)
const compareOpen = ref(false)

/** 统一菜单：dots 按钮与右键共用，屏幕坐标定位 + 边缘翻转 */
function openMenuAt(cx: number, cy: number) {
  const W = 160
  const H = 210
  menuPos.value = {
    x: Math.min(cx, window.innerWidth - W - 8),
    y: Math.min(cy, window.innerHeight - H - 8),
  }
  confirmDelete.value = false
  menuOpen.value = true
  // 键盘导航起点：聚焦第一项（↑↓ 循环，Enter 确认，Esc 关闭）
  void nextTick(() => {
    const first = menuRef.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])')[0]
    first?.focus()
  })
}

function onMenuKeydown(e: KeyboardEvent) {
  const items = [...(menuRef.value?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
  if (!items.length) return
  const idx = items.indexOf(document.activeElement as HTMLButtonElement)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    items[(idx + 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    items[(idx - 1 + items.length) % items.length]?.focus()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    menuOpen.value = false
  }
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  openMenuAt(e.clientX, e.clientY)
}

// —— 版本历史时间线 ——
const timelineOpen = ref(false)
const timelineRef = ref<HTMLElement | null>(null)
const timelinePos = ref({ x: 0, y: 0 })
/** 各版本快照缩略图（与 LOD 共用缓存，同 key 命中即秒出） */
const versionThumbs = ref<Array<string | null>>([])
watch(timelineOpen, (open) => {
  if (!open) return
  const list = board.value.versions
  versionThumbs.value = list.map(() => null)
  list.forEach((v, i) => {
    getThumb(v.id + ':' + v.html.length, v.html, board.value.width, board.value.height).then(
      (u) => {
        versionThumbs.value[i] = u
      },
    )
  })
})
function toggleTimeline(e: MouseEvent) {
  if (timelineOpen.value) {
    timelineOpen.value = false
    return
  }
  if (!board.value.versions.length) return
  const W = 238
  const H = Math.min(56 + board.value.versions.length * 40, 340)
  timelinePos.value = {
    x: Math.min(e.clientX, window.innerWidth - W - 8),
    y: Math.min(e.clientY + 10, window.innerHeight - H - 8),
  }
  timelineOpen.value = true
}
function pickVersion(v: { id: string }) {
  if (v.id !== board.value.currentVersionId && !confirmLeaveEdits()) return
  ws.setCurrentVersion(board.value.id, v.id)
  timelineOpen.value = false
}
function fmtVersionTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return hm
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${hm}`
}

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
  if (timelineRef.value && !timelineRef.value.contains(e.target as Node)) {
    timelineOpen.value = false
  }
}
watch([menuOpen, timelineOpen], ([m, t]) => {
  if (m || t) document.addEventListener('pointerdown', closeOnOutside, true)
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
/** 单块画板发布到局域网（桌面端） */
function shareBoard() {
  const html = currentHtml()
  if (!html) return
  menuOpen.value = false
  canvas.sharePayload = { title: board.value.title, html }
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
    :class="{ selected, multi: multiPicked, streaming: isStreaming, flash, dragging, dim: dimmed }"
    :style="{ left: `${board.x}px`, top: `${board.y}px`, width: `${board.width}px`, height: `${board.height}px` }"
    @pointerdown.stop="onNodePointerDown"
    @contextmenu="onContextMenu"
  >
    <span v-if="badge" class="ab-badge">{{ badge }}</span>
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

      <template v-if="isLive">
        <span
          class="live-dot"
          :class="session?.status ?? 'stopped'"
          :title="{ starting: '启动中', ready: '运行中', error: '出错', stopped: '未运行' }[session?.status ?? 'stopped']"
        />
        <input
          v-model="routeDraft"
          class="live-route"
          spellcheck="false"
          :title="board.live?.url"
          @pointerdown.stop
          @keydown.enter.prevent="submitRoute"
          @keydown.stop
        />
      </template>
      <span
        v-else
        class="ab-versions"
        :title="versionListTitle"
        @pointerdown.stop
        @click.stop="toggleTimeline($event)"
      >
        <button class="nav" :disabled="!canPrev" title="上一版" @click.stop="stepVersion(-1)">‹</button>
        <b>{{ versionIdx || '–' }}</b>
        <i>/ {{ board.versions.length }}</i>
        <button class="nav" :disabled="!canNext" title="下一版" @click.stop="stepVersion(1)">›</button>
      </span>

      <span class="flex1" />
      <template v-if="isLive">
        <span v-if="agentWorking" class="live-agent">Agent 改代码中…</span>
        <button
          v-if="session?.status === 'ready'"
          class="live-capture"
          :disabled="capturing"
          title="把当前页面捕获为可编辑的设计稿"
          @pointerdown.stop
          @click.stop="captureNow"
        >
          {{ capturing ? '捕获中…' : '捕获' }}
        </button>
        <button
          v-if="session?.status === 'ready'"
          class="tool"
          title="刷新页面"
          @pointerdown.stop
          @click.stop="frameRef?.reload()"
        >
          <AppIcon name="refresh" :size="13" />
        </button>
        <button
          class="tool"
          :class="{ on: logsOpen }"
          title="运行日志"
          @pointerdown.stop
          @click.stop="logsOpen = !logsOpen"
        >
          <AppIcon name="code" :size="14" />
        </button>
      </template>
      <span v-if="pendingEdits" class="ab-edits" @pointerdown.stop>
        {{ pendingEdits }} 处修改
        <button class="ab-edits-btn" title="放弃未保存的手动修改" @click.stop="discardEdits">放弃</button>
        <button class="ab-edits-btn primary" title="保存为新版本" @click.stop="saveEdits">保存</button>
      </span>
      <Spin v-if="isStreaming" size="small" />
    </header>

    <div v-if="isLive" class="ab-body" :style="{ height: `${board.height - HEADER_H}px` }">
      <PrototypeFrame
        v-if="liveSrc"
        ref="frameRef"
        :src="liveSrc"
        :tool="canvas.tool"
        :streaming="false"
        :inspecting="canvas.inspect?.artboardId === board.id"
        @select="onSelect"
        @inspect="onInspect"
        @location="onLiveLocation"
        @frame-wheel="onFrameWheel"
        @frame-key="onFrameKey"
      />
      <div v-else class="live-idle">
        <template v-if="session?.status === 'starting'">
          <Spin size="small" />
          <p>{{ board.live?.type === 'repo' ? `正在启动 ${board.live?.packageManager} run ${board.live?.script}…` : '正在连接网页…' }}</p>
          <code v-if="session.logs.length">{{ session.logs[session.logs.length - 1] }}</code>
        </template>
        <template v-else>
          <p v-if="session?.status === 'error'" class="live-error">{{ session.error }}</p>
          <p v-else>{{ board.live?.type === 'repo' ? board.live?.repoDir : board.live?.url }}</p>
          <button class="live-start" @pointerdown.stop @click.stop="liveStore.start(board.id)">
            {{ session?.status === 'error' ? '重新启动' : board.live?.type === 'repo' ? '启动预览' : '打开网页' }}
          </button>
        </template>
      </div>
      <div v-if="logsOpen" class="live-logs" @pointerdown.stop @wheel.stop>
        <div class="live-logs-head">
          <span>{{ board.live?.type === 'repo' ? `${board.live?.packageManager} run ${board.live?.script}` : board.live?.url }}</span>
          <button
            v-if="session?.status === 'starting' || session?.status === 'ready'"
            class="live-stop"
            @click.stop="liveStore.stop(board.id)"
          >
            停止
          </button>
          <button class="live-stop" @click.stop="logsOpen = false">×</button>
        </div>
        <pre>{{ session?.logs.join('\n') || '暂无日志' }}</pre>
      </div>
      <div v-if="agentWorking" class="stream-bar" />
    </div>
    <div v-else class="ab-body" :style="{ height: `${board.height - HEADER_H}px` }">
      <img v-if="useThumb" class="ab-thumb" :src="thumbUrl!" alt="" />
      <PrototypeFrame
        :html="displayHtml"
        :tool="canvas.tool"
        :streaming="isStreaming"
        :edits="canvas.edits[board.id]"
        :inspecting="canvas.inspect?.artboardId === board.id"
        :class="{ 'lod-hidden': useThumb }"
        @select="onSelect"
        @inspect="onInspect"
        @text-edit="onTextEdit"
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

    <!-- 底部居中悬浮工具条：点选反馈 / 手动编辑 / 画板菜单 -->
    <div class="ab-toolbar" @pointerdown.stop @wheel.stop>
      <Tooltip :title="canvas.tool === 'comment' ? '点选反馈已开启：点击页面元素，让 AI 定向修改' : '点选反馈：点击页面元素让 AI 定向修改'">
        <button class="tool" :class="{ on: canvas.tool === 'comment' }" @click.stop="toggleTool('comment')">
          <AppIcon name="cursor" :size="14" />
        </button>
      </Tooltip>
      <Tooltip :title="canvas.tool === 'edit' ? '手动编辑已开启：点选元素在右侧调整，双击改字，Alt 悬停测距' : '手动编辑：像设计工具一样直接调整元素'">
        <button class="tool" :class="{ on: canvas.tool === 'edit' }" @click.stop="toggleTool('edit')">
          <AppIcon name="pencil" :size="13" />
        </button>
      </Tooltip>
      <span class="ab-toolbar-sep" />
      <button class="tool" title="画板菜单（右键画板同样打开）" @click.stop="openMenuAt($event.clientX, $event.clientY)">
        <AppIcon name="dots" :size="14" />
      </button>
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
      :style="{ left: `${menuPos.x}px`, top: `${menuPos.y}px` }"
      @pointerdown.stop
      @keydown="onMenuKeydown"
      @contextmenu.prevent
    >
      <template v-if="isLive">
        <button v-if="session?.status === 'ready'" :disabled="capturing" @click="captureNow">捕获为设计稿</button>
        <button v-if="session?.status === 'starting' || session?.status === 'ready'" @click="liveStore.stop(board.id); menuOpen = false">
          停止{{ board.live?.type === 'repo' ? ' dev server' : '' }}
        </button>
        <button v-else @click="liveStore.start(board.id); menuOpen = false">启动</button>
      </template>
      <button v-if="board.capture?.repoDir" :disabled="canvas.busy" @click="writeBack">写回代码</button>
      <button v-if="compareVersionIds" @click="compareOpen = true">对比上一版</button>
      <button v-if="board.versions.length" @click="exportHtml">导出 .html</button>
      <button v-if="board.versions.length" @click="copyCode">复制代码</button>
      <button v-if="board.versions.length && desktopAvailable" @click="shareBoard">分享此画板</button>
      <button v-if="!isLive" @click="duplicate">创建副本</button>
      <div class="menu-divider" />
      <template v-if="!confirmDelete">
        <button class="danger" @click="confirmDelete = true">删除画板…</button>
      </template>
      <template v-else>
        <button class="danger solid" @click="doDelete">确认删除</button>
        <button @click="confirmDelete = false">取消</button>
      </template>
    </div>

    <div
      v-if="timelineOpen"
      ref="timelineRef"
      class="ab-timeline"
      :style="{ left: `${timelinePos.x}px`, top: `${timelinePos.y}px` }"
      @pointerdown.stop
      @contextmenu.prevent
    >
      <p class="tl-head">版本历史</p>
      <button
        v-for="(v, i) in board.versions"
        :key="v.id"
        class="tl-row"
        :class="{ cur: v.id === board.currentVersionId }"
        @click="pickVersion(v)"
      >
        <img v-if="versionThumbs[i]" class="tl-thumb" :src="versionThumbs[i]!" alt="" />
        <span class="tl-ver" :class="{ on: v.id === board.currentVersionId }">v{{ i + 1 }}</span>
        <span class="tl-time">{{ fmtVersionTime(v.createdAt) }}</span>
        <span v-if="v.id === board.currentVersionId" class="tl-cur">当前</span>
      </button>
      <button v-if="compareVersionIds" class="tl-cmp" @click="compareOpen = true; timelineOpen = false">
        <AppIcon name="copy" :size="11" />
        对比上一版
      </button>
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
  animation: enter var(--dur) var(--ease) backwards;
  animation-delay: var(--enter-delay, 0ms);
  transition:
    transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}
.artboard:hover:not(.dragging) {
  transform: translateY(-2px);
  box-shadow:
    0 0 0 1px var(--line-strong),
    0 18px 44px rgba(0, 0, 0, 0.55);
}
.artboard.dragging {
  transition: none;
}
/* 对比模式：非本组画板压暗禁点 */
.artboard.dim {
  opacity: 0.25;
  filter: saturate(0.3);
  pointer-events: none;
}
/* 方案徽章（对比模式） */
.ab-badge {
  position: absolute;
  top: -12px;
  right: 10px;
  z-index: 5;
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
  letter-spacing: 0.06em;
  pointer-events: none;
}
/* LOD 缩略图：盖住 iframe，iframe 保持挂载但不可见（省合成） */
.ab-thumb {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top left;
  background: #fff;
  z-index: 2;
  pointer-events: none;
  border-radius: 0 0 var(--radius-m) var(--radius-m);
}
.ab-body :deep(.lod-hidden) {
  visibility: hidden;
}
.artboard.selected {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.artboard.multi {
  outline: 2px dashed var(--accent);
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
  /* 实心填充：工具选中态一眼可辨（对齐设计工具的激活样式） */
  background: var(--accent);
  color: #fff;
}
/* —— 底部居中悬浮工具条 —— */
.ab-toolbar {
  position: absolute;
  left: 50%;
  bottom: 10px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 5px;
  border-radius: 10px;
  background: var(--bg-elevated);
  box-shadow: var(--shadow-card);
  z-index: 6;
}
.ab-toolbar-sep {
  flex: none;
  width: 1px;
  height: 14px;
  margin: 0 3px;
  background: var(--line-strong);
}
/* —— 实时画板 —— */
.live-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ink-3);
}
.live-dot.ready {
  background: #3ecf8e;
  box-shadow: 0 0 0 3px rgba(62, 207, 142, 0.18);
}
.live-dot.starting {
  background: #f0a020;
  animation: live-pulse 1s ease-in-out infinite;
}
.live-dot.error {
  background: var(--spark);
}
@keyframes live-pulse {
  50% {
    opacity: 0.35;
  }
}
.live-route {
  flex: 1 1 auto;
  min-width: 80px;
  max-width: 320px;
  height: 24px;
  padding: 0 8px;
  border: none;
  outline: none;
  border-radius: var(--radius-s);
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 11px;
  cursor: text;
}
.live-route:focus {
  color: var(--ink);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.live-agent {
  font-size: 11px;
  color: var(--accent);
  white-space: nowrap;
}
.live-capture {
  height: 24px;
  padding: 0 10px;
  border: none;
  border-radius: 999px;
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
  font-size: 11px;
  font-family: var(--sans);
  cursor: pointer;
  white-space: nowrap;
}
.live-capture:disabled {
  opacity: 0.6;
  cursor: default;
}
.live-idle {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  background: var(--bg-elevated);
  color: var(--ink-2);
  font-size: 13px;
  text-align: center;
}
.live-idle p {
  margin: 0;
  max-width: 80%;
  word-break: break-all;
}
.live-idle code {
  max-width: 80%;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.live-error {
  color: var(--spark);
  white-space: pre-wrap;
}
.live-start {
  height: 32px;
  padding: 0 18px;
  border: none;
  border-radius: var(--radius-m);
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
  font-size: 13px;
  font-family: var(--sans);
  cursor: pointer;
}
.live-logs {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 42%;
  display: flex;
  flex-direction: column;
  background: rgba(10, 10, 10, 0.94);
  border-top: 1px solid var(--line-strong);
  z-index: 3;
}
.live-logs-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  color: var(--ink-3);
  font-family: var(--mono);
  font-size: 11px;
}
.live-logs-head span {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-stop {
  border: none;
  border-radius: 4px;
  padding: 2px 8px;
  background: var(--bg-raised);
  color: var(--ink-2);
  font-size: 11px;
  cursor: pointer;
}
.live-logs pre {
  flex: 1;
  margin: 0;
  padding: 8px 10px;
  overflow: auto;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
/* 未保存的手动修改 */
.ab-edits {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 3px 2px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  white-space: nowrap;
  cursor: default;
}
.ab-edits-btn {
  border: none;
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--sans);
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
}
.ab-edits-btn:hover {
  color: var(--ink);
  background: var(--hover);
}
.ab-edits-btn.primary {
  background: var(--accent);
  color: #fff;
}
.ab-edits-btn.primary:hover {
  background: var(--accent-deep);
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
  min-width: 148px;
  background: rgba(22, 22, 22, 0.94);
  backdrop-filter: blur(10px);
  border: none;
  border-radius: 10px;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.09),
    0 16px 48px rgba(0, 0, 0, 0.55);
  padding: 4px;
  display: flex;
  flex-direction: column;
  animation: enter var(--dur-fast) var(--ease);
}
.ab-menu button {
  border: none;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--ink);
  padding: 7px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.ab-menu button:hover,
.ab-menu button:focus {
  background: var(--bg-raised);
  outline: none;
}
.ab-menu button.danger {
  color: #ff5459;
}
.ab-menu button.danger.solid {
  background: rgba(255, 84, 89, 0.14);
  color: #ff5459;
}
.ab-menu button.danger.solid:hover {
  background: rgba(255, 84, 89, 0.22);
}
.menu-divider {
  height: 1px;
  background: var(--line);
  margin: 4px 6px;
}

/* —— 版本历史时间线 —— */
.ab-timeline {
  position: fixed;
  z-index: 1000;
  width: 238px;
  background: rgba(22, 22, 22, 0.94);
  backdrop-filter: blur(10px);
  border: none;
  border-radius: 10px;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.09),
    0 16px 48px rgba(0, 0, 0, 0.55);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  animation: enter var(--dur-fast) var(--ease);
}
.tl-head {
  margin: 0 0 4px;
  padding: 0 6px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink-3);
}
.tl-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: none;
  background: transparent;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-family: var(--sans);
  transition: background var(--dur-fast) var(--ease);
}
.tl-row:hover {
  background: var(--bg-raised);
}
.tl-thumb {
  width: 46px;
  height: 30px;
  object-fit: cover;
  object-position: top left;
  border-radius: 4px;
  background: #fff;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.1);
  flex: none;
}
.tl-ver {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  padding: 1px 7px;
  border-radius: 999px;
  box-shadow: var(--btn-quiet-shadow);
}
.tl-ver.on {
  color: #fff;
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
}
.tl-time {
  flex: 1;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
}
.tl-cur {
  font-size: 10.5px;
  color: var(--accent);
}
.tl-cmp {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  border: none;
  background: transparent;
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: 8px;
  cursor: pointer;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.tl-cmp:hover {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
</style>
