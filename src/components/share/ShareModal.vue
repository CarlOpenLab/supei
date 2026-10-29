<script setup lang="ts">
/**
 * 局域网分享（仅桌面端）：把整项目预览页或单块画板发布到本机 HTTP 服务，
 * 同一局域网内用链接或扫码打开；分享存在本机，重启后仍可访问，可随时撤销。
 */
import { computed, ref, watch } from 'vue'
import { Modal, QRCode, Spin, message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { requireDesktopBridge } from '@/services/desktop'
import type { ShareInfo } from '@/services/mygo-client'
import AppIcon from '@/components/ui/AppIcon.vue'

const canvas = useCanvasStore()
const open = computed(() => canvas.sharePayload !== null)
const publishing = ref(false)
const current = ref<ShareInfo | null>(null)
const shares = ref<ShareInfo[]>([])

watch(
  () => canvas.sharePayload,
  async (payload) => {
    if (!payload) return
    current.value = null
    publishing.value = true
    try {
      const bridge = await requireDesktopBridge('局域网分享')
      current.value = await bridge.Share.publish(payload.title, payload.html)
      shares.value = await bridge.Share.list()
    } catch (err) {
      message.error(`分享失败：${(err as Error).message}`)
      canvas.sharePayload = null
    } finally {
      publishing.value = false
    }
  },
)

function close() {
  canvas.sharePayload = null
}

/**
 * @description 复制分享链接到剪贴板。
 * @param url - 分享链接
 */
async function copy(url: string) {
  await navigator.clipboard.writeText(url)
  message.success('链接已复制')
}

/**
 * @description 撤销一条分享：页面文件删除后链接返回 404。
 * @param id - 分享 id
 */
async function unpublish(id: string) {
  const bridge = await requireDesktopBridge('局域网分享')
  await bridge.Share.unpublish(id)
  shares.value = shares.value.filter((s) => s.id !== id)
  if (current.value?.id === id) current.value = null
  message.success('已撤销分享')
}

/**
 * @description 分享时间的简短展示。
 * @param ts - 毫秒时间戳
 * @returns 如「10.29 23:40」
 */
function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <Modal :open="open" title="局域网分享" width="560px" :footer="null" @cancel="close">
    <div class="share-body">
      <div v-if="publishing" class="share-loading">
        <Spin size="small" />
        <span>正在发布…</span>
      </div>

      <section v-else-if="current" class="share-current">
        <div class="share-qr">
          <QRCode :value="current.urls[0]" :size="148" color="#111111" bg-color="#ffffff" :bordered="false" />
        </div>
        <div class="share-links">
          <b>{{ current.title }}</b>
          <p>同一局域网内的手机或电脑扫码 / 打开链接即可查看：</p>
          <div v-for="u in current.urls" :key="u" class="share-url">
            <code>{{ u }}</code>
            <button title="复制链接" @click="copy(u)"><AppIcon name="copy" :size="12" /></button>
          </div>
          <p class="share-note">首次分享时 Windows 可能弹出防火墙提示，需要允许「专用网络」访问。</p>
        </div>
      </section>

      <section v-if="shares.length" class="share-list">
        <span class="share-list-title">已分享（{{ shares.length }}）</span>
        <div v-for="s in shares" :key="s.id" class="share-row" :class="{ cur: s.id === current?.id }">
          <span class="share-row-title">{{ s.title }}</span>
          <span class="share-row-time">{{ fmt(s.createdAt) }}</span>
          <button @click="copy(s.urls[0])">复制</button>
          <button class="danger" @click="unpublish(s.id)">撤销</button>
        </div>
      </section>
    </div>
  </Modal>
</template>

<style scoped>
.share-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding-top: 6px;
}
.share-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--ink-2);
  font-size: 13px;
}
.share-current {
  display: flex;
  gap: 18px;
}
.share-qr {
  flex: none;
  padding: 8px;
  border-radius: var(--radius-m);
  background: #fff;
  align-self: flex-start;
}
.share-links {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.share-links b {
  font-size: 14px;
  color: var(--ink);
}
.share-links p {
  margin: 0;
  font-size: 12px;
  color: var(--ink-2);
}
.share-url {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: var(--radius-s);
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
}
.share-url code {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-url button,
.share-row button {
  border: none;
  border-radius: 4px;
  padding: 3px 8px;
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  cursor: pointer;
}
.share-url button:hover,
.share-row button:hover {
  background: var(--hover);
  color: var(--ink);
}
.share-row button.danger:hover {
  color: var(--spark);
}
.share-links .share-note {
  color: var(--ink-3);
}
.share-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.share-list-title {
  margin-bottom: 4px;
  font-size: 11px;
  color: var(--ink-3);
}
.share-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: var(--radius-s);
  font-size: 12px;
}
.share-row.cur {
  background: var(--accent-soft);
}
.share-row-title {
  flex: 1;
  min-width: 0;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.share-row-time {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
}
</style>
