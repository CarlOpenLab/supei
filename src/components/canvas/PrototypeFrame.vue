<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ElementContext, WheelPayload } from '@/types'
import { injectBridge } from '@/utils/html'

const props = defineProps<{
  html: string
  selectMode: boolean
  streaming: boolean
}>()

const emit = defineEmits<{
  (e: 'select', ctx: ElementContext): void
  (e: 'hover', ctx: ElementContext | null): void
  (e: 'frame-wheel', payload: WheelPayload): void
  (e: 'frame-key', payload: { key: string; ctrlKey: boolean; metaKey: boolean }): void
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
const appliedDoc = ref('')
const loaded = ref(false)
const suspended = ref(false) // 画板滚出视口时暂停渲染，省内存
let savedScroll = { x: 0, y: 0 }
let observer: IntersectionObserver | null = null

const fullDoc = computed(() => injectBridge(props.html))

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
    if (suspended.value) return
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
  postToFrame({ type: 'dc:set-enabled', value: props.selectMode && !props.streaming })
}

function onFrameLoad() {
  loaded.value = true
  try {
    iframeRef.value?.contentWindow?.scrollTo(savedScroll.x, savedScroll.y)
  } catch {
    /* 忽略 */
  }
  postEnabledState()
}

function onMessage(ev: MessageEvent) {
  if (ev.source !== iframeRef.value?.contentWindow) return
  const data = ev.data as
    | {
        channel: string
        type: string
        meta?: ElementContext | null
        deltaX?: number
        deltaY?: number
        localX?: number
        localY?: number
        key?: string
        ctrlKey?: boolean
        metaKey?: boolean
      }
    | undefined
  if (!data || data.channel !== 'design-canvas') return
  switch (data.type) {
    case 'dc:ready':
      postEnabledState()
      break
    case 'dc:select':
      if (data.meta) emit('select', data.meta)
      break
    case 'dc:hover':
      emit('hover', data.meta ?? null)
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
  }
}

watch(
  () => [props.selectMode, props.streaming] as const,
  () => {
    if (loaded.value) postEnabledState()
  },
)

onMounted(() => {
  window.addEventListener('message', onMessage)
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
