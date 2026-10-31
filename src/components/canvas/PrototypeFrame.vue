<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ElementContext, ElementEdit, FrameTool, InspectMeta, WheelPayload } from '@/types'
import { injectBridge } from '@/utils/html'
import { stampIds } from '@/utils/editable'

const props = defineProps<{
  /** HTML 原型（srcdoc 渲染）；与 src 二选一 */
  html?: string
  /** 实时页面地址（经注入代理，已含 bridge）；与 html 二选一 */
  src?: string
  tool: FrameTool
  streaming: boolean
  /** 待保存的手动修改（dcId → 修改），每次变化与 iframe 重载后整体重放 */
  edits?: Record<string, ElementEdit>
  /** 本画板是否持有检查选中；变为 false 时清掉 iframe 内的选中框 */
  inspecting?: boolean
}>()

const emit = defineEmits<{
  (e: 'select', ctx: ElementContext): void
  (e: 'inspect', meta: InspectMeta, refresh: boolean): void
  (e: 'text-edit', payload: { dcId: string; text: string }): void
  (e: 'frame-wheel', payload: WheelPayload): void
  (e: 'frame-key', payload: { key: string; ctrlKey: boolean; metaKey: boolean }): void
  /** 实时页面内的路由变化（SPA 导航），用于同步地址栏 */
  (e: 'location', path: string): void
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const appliedDoc = ref('')
const loaded = ref(false)
const suspended = ref(false) // 画板滚出视口时暂停渲染，省内存
const reloadKey = ref(0)
let savedScroll = { x: 0, y: 0 }
let observer: IntersectionObserver | null = null

// 流式中间态不打编号（不完整、也不可编辑）；定稿后打编号供检查器映射回源码
const fullDoc = computed(() =>
  props.html === undefined ? '' : injectBridge(props.streaming ? props.html : stampIds(props.html)),
)

// —— 流式期间节流刷新 srcdoc（首帧立即应用，之后每 350ms 至多一次）——
const MIN_INTERVAL = 350
let lastApplied = 0
let trailingTimer: number | null = null

function applyDoc(doc: string) {
  const win = iframeRef.value?.contentWindow
  if (win) {
    try {
      savedScroll = { x: win.scrollX, y: win.scrollY }
    } catch {
      /* 忽略 */
    }
  }
  loaded.value = false
  appliedDoc.value = doc
  lastApplied = Date.now()
}

watch(
  fullDoc,
  (doc) => {
    if (props.src !== undefined || suspended.value) return
    if (!appliedDoc.value || Date.now() - lastApplied >= MIN_INTERVAL) {
      applyDoc(doc)
      return
    }
    if (trailingTimer === null) {
      trailingTimer = window.setTimeout(() => {
        trailingTimer = null
        applyDoc(fullDoc.value)
      }, MIN_INTERVAL - (Date.now() - lastApplied))
    }
  },
  { immediate: true },
)

function postToFrame(msg: Record<string, unknown>) {
  const win = iframeRef.value?.contentWindow
  if (!win) return
  win.postMessage({ channel: 'design-canvas', ...msg }, '*')
}

function postEnabledState() {
  postToFrame({ type: 'dc:set-enabled', value: !!props.tool && !props.streaming, mode: props.tool ?? 'comment' })
}

/**
 * @description 把全部待保存修改下发给 bridge 重放（bridge 先还原再应用，幂等）；
 * 响应式代理不能 postMessage，先转成普通对象。
 */
function postEdits() {
  postToFrame({ type: 'dc:apply-all', edits: JSON.parse(JSON.stringify(props.edits ?? {})) })
}

// —— 捕获：请求 bridge 序列化当前页面，按请求 id 配对响应 ——
const pendingSnapshots = new Map<string, (r: { html: string; title: string; error: string }) => void>()
let snapshotSeq = 0

/**
 * @description 请求 iframe 内的 bridge 把当前页面序列化为自包含的静态 HTML（捕获为设计稿）。
 * @returns 序列化后的 HTML 与页面标题；页面未就绪、无响应（10 秒）或序列化出错时 reject
 */
function snapshot(): Promise<{ html: string; title: string }> {
  if (!loaded.value) return Promise.reject(new Error('页面尚未加载完成'))
  const id = String(++snapshotSeq)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingSnapshots.delete(id)
      reject(new Error('页面没有响应捕获请求'))
    }, 10000)
    pendingSnapshots.set(id, (r) => {
      window.clearTimeout(timer)
      if (r.error) reject(new Error(`页面序列化失败：${r.error}`))
      else resolve({ html: r.html, title: r.title })
    })
    postToFrame({ type: 'dc:snapshot', id })
  })
}

/** @description 重新加载实时页面（跨源 iframe 不能调 location.reload，换 key 重建）。 */
function reload() {
  loaded.value = false
  reloadKey.value++
}

defineExpose({ snapshot, reload })

function onFrameLoad() {
  loaded.value = true
  try {
    iframeRef.value?.contentWindow?.scrollTo(savedScroll.x, savedScroll.y)
  } catch {
    /* 忽略 */
  }
  postEnabledState()
  if (props.edits && Object.keys(props.edits).length) postEdits()
}

/**
 * @description 用系统浏览器（桌面端）或新标签（Web）打开外链；iframe 内永远不跳转，
 * 避免点击原型里的 <a> 把整个网页加载进画板（套娃）。
 */
async function openExternal(href: string) {
  try {
    const { getDesktopBridge } = await import('@/services/desktop')
    const bridge = await getDesktopBridge()
    if (bridge) {
      await bridge.Sys.openURL(href)
      return
    }
  } catch {
    /* 桥接不可用时走浏览器兜底 */
  }
  window.open(href, '_blank', 'noopener')
}

function onMessage(ev: MessageEvent) {
  if (ev.source !== iframeRef.value?.contentWindow) return
  const data = ev.data as
    | {
        channel: string
        type: string
        /** dc:select 为 ElementContext，dc:inspect 为 InspectMeta */
        meta?: unknown
        refresh?: boolean
        dcId?: string
        text?: string
        deltaX?: number
        deltaY?: number
        localX?: number
        localY?: number
        key?: string
        ctrlKey?: boolean
        metaKey?: boolean
        id?: string
        html?: string
        title?: string
        error?: string
        path?: string
        href?: string
      }
    | undefined
  if (!data || data.channel !== 'design-canvas') return
  switch (data.type) {
    case 'dc:ready':
      postEnabledState()
      break
    case 'dc:select':
      if (data.meta) emit('select', data.meta as ElementContext)
      break
    case 'dc:inspect':
      if (data.meta) emit('inspect', data.meta as InspectMeta, !!data.refresh)
      break
    case 'dc:text':
      if (data.dcId && data.text !== undefined) emit('text-edit', { dcId: data.dcId, text: data.text })
      break
    case 'dc:wheel':
      emit('frame-wheel', {
        deltaX: data.deltaX ?? 0,
        deltaY: data.deltaY ?? 0,
        localX: data.localX ?? 0,
        localY: data.localY ?? 0,
      })
      break
    case 'dc:key':
      emit('frame-key', {
        key: data.key ?? '',
        ctrlKey: !!data.ctrlKey,
        metaKey: !!data.metaKey,
      })
      break
    case 'dc:snapshot-result': {
      const done = data.id ? pendingSnapshots.get(data.id) : undefined
      if (!done) break
      pendingSnapshots.delete(data.id!)
      done({ html: data.html ?? '', title: data.title ?? '', error: data.error ?? '' })
      break
    }
    case 'dc:location':
      if (props.src !== undefined && data.path) emit('location', data.path)
      break
    case 'dc:open-link':
      if (data.href) void openExternal(data.href)
      break
  }
}

watch(
  () => [props.tool, props.streaming] as const,
  () => {
    if (loaded.value) postEnabledState()
  },
)

watch(
  () => props.edits,
  () => {
    if (loaded.value) postEdits()
  },
  { deep: true },
)

watch(
  () => props.inspecting,
  (on) => {
    if (!on && loaded.value) postToFrame({ type: 'dc:clear-selection' })
  },
)

onMounted(() => {
  window.addEventListener('message', onMessage)
  // 实时页面不暂停：卸载会丢掉页面运行状态（登录态、表单、滚动）
  if (props.src !== undefined) return
  // 不可见画板暂停 srcdoc 渲染（多画板内存优化），恢复可见时重新应用
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries[0]?.isIntersecting ?? true
      suspended.value = !visible
      if (visible) applyDoc(fullDoc.value)
    },
    { rootMargin: '200px' },
  )
  if (iframeRef.value) observer.observe(iframeRef.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('message', onMessage)
  if (trailingTimer !== null) window.clearTimeout(trailingTimer)
})
</script>

<template>
  <iframe
    v-if="src !== undefined"
    ref="iframeRef"
    :key="reloadKey"
    class="prototype-frame"
    :src="src"
    sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"
    @load="onFrameLoad"
  ></iframe>
  <iframe
    v-else
    ref="iframeRef"
    class="prototype-frame"
    :srcdoc="appliedDoc"
    sandbox="allow-same-origin allow-scripts"
    @load="onFrameLoad"
  ></iframe>
</template>

<style scoped>
.prototype-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
</style>
