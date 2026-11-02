<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Bubble } from '@antdv-next/x'
import { Select, message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { replan, retryLast, sendPrompt, startFromPlan, stopGeneration } from '@/services/orchestrator'
import { pluginRegistry } from '@/plugins/registry'
import type { PresetPluginData } from '@/plugins/types'
import type { ChatAttachment, ChatMessage, PlanStyle } from '@/types'
import AppIcon from '@/components/ui/AppIcon.vue'

const canvas = useCanvasStore()
const ws = useWorkspaceStore()
const settings = useSettingsStore()

const input = ref('')
const scrollRef = ref<HTMLElement | null>(null)

/** 输入框里待发送的参考图 / 资料 */
interface ComposerAttachment {
  id: number
  file: File
  /** 图片缩略图（data URL）；非图片或读取失败时为空 */
  preview?: string
  /** 文本类文件的内容，发送时并入提示词 */
  text?: string
}

const MAX_ATTACHMENTS = 6
const FILE_ACCEPT =
  'image/*,.pdf,.md,.markdown,.txt,.csv,.json,.html,.htm,.css,.js,.ts,.vue,.tsx,.jsx,.yml,.yaml'
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'css', 'js', 'ts', 'vue', 'tsx', 'jsx', 'yml', 'yaml',
])
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i

const fileInput = ref<HTMLInputElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const previewCloseRef = ref<HTMLButtonElement | null>(null)
const attachments = ref<ComposerAttachment[]>([])
/** 正在预览的图片附件（Studio composer 式点击查看） */
const previewing = ref<ComposerAttachment | null>(null)
const dragging = ref(false)
let attachmentSeq = 0
let dragDepth = 0

/** 输入框最大高度（约 6 行），超出后内部滚动 */
const MAX_INPUT_HEIGHT = 144

const targetBoard = computed(() => ws.findArtboard(canvas.selectedArtboardId))

const placeholder = computed(() => {
  const b = targetBoard.value
  if (!b) return '描述你想要的页面…'
  if (b.kind === 'live') {
    return b.live?.type === 'repo' ? '描述要改的地方…' : '先捕获为设计稿…'
  }
  // 胶囊输入区较窄，不放画板标题，避免 placeholder 被截断
  return b.versions.length ? '描述要改的地方…' : '描述你想生成的页面…'
})

const canSend = computed(() => input.value.trim().length > 0 && !canvas.busy)

/** 先置 auto 取内容实际高度，再封顶 */
function autosize() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
}

onMounted(() => {
  autosize()
  window.addEventListener('keydown', onPreviewKeydown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onPreviewKeydown)
})
watch(input, () => nextTick(autosize))

watch(previewing, (item) => {
  if (item) nextTick(() => previewCloseRef.value?.focus())
  else nextTick(() => textareaRef.value?.focus())
})

const PRESETS = pluginRegistry
  .listByKind('preset')
  .map((p) => ({ icon: (p.data as PresetPluginData).icon, title: p.name, prompt: (p.data as PresetPluginData).prompt }))

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

function extLabel(name: string): string {
  return (fileExt(name) || 'file').slice(0, 4).toUpperCase()
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/') || IMAGE_EXT_RE.test(file.name)
}

function attachmentKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 图片压成小缩略图再入会话，避免把原图塞进 IndexedDB */
async function makePreview(file: File): Promise<string | undefined> {
  if (!isImageFile(file)) return
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height, 1))
    const canvasEl = document.createElement('canvas')
    canvasEl.width = Math.max(1, Math.round(bitmap.width * scale))
    canvasEl.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvasEl.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return
    }
    ctx.drawImage(bitmap, 0, 0, canvasEl.width, canvasEl.height)
    bitmap.close()
    return canvasEl.toDataURL('image/jpeg', 0.72)
  } catch {
    return
  }
}

/** 文本类资料作为生成上下文；PDF / 图片等二进制文件只作展示 */
async function readAttachmentText(file: File): Promise<string | undefined> {
  if (!TEXT_EXTENSIONS.has(fileExt(file.name)) || file.size > 400_000) return
  try {
    const raw = await file.text()
    if (!raw.trim()) return
    return raw.length > 16_000 ? `${raw.slice(0, 16_000)}\n…（内容已截断）` : raw
  } catch {
    return
  }
}

/** 把附件正文拼进提示词；图片只列文件名，避免假装模型已读图 */
function composePrompt(text: string, items: ComposerAttachment[]): string {
  const blocks: string[] = []
  const images = items.filter((item) => isImageFile(item.file)).map((item) => item.file.name)
  if (images.length) blocks.push(`【参考图片】${images.join('、')}`)
  let budget = 40_000
  for (const item of items) {
    if (!item.text || budget <= 0) continue
    const chunk = item.text.slice(0, budget)
    budget -= chunk.length
    blocks.push(`【附件：${item.file.name}】\n${chunk}${chunk.length < item.text.length ? '\n…（内容已截断）' : ''}`)
  }
  return blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text
}

async function addFiles(list: File[]) {
  if (!list.length) return
  const room = MAX_ATTACHMENTS - attachments.value.length
  if (room <= 0) {
    message.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
    return
  }
  if (list.length > room) message.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件，已忽略多余文件`)
  const existing = new Set(attachments.value.map((item) => attachmentKey(item.file)))
  const accepted: File[] = []
  for (const file of list.slice(0, room)) {
    const key = attachmentKey(file)
    if (existing.has(key)) continue
    existing.add(key)
    accepted.push(file)
  }
  if (!accepted.length) return
  const items = await Promise.all(
    accepted.map(async (file) => ({
      id: ++attachmentSeq,
      file,
      preview: await makePreview(file),
      text: await readAttachmentText(file),
    })),
  )
  attachments.value.push(...items)
  nextTick(() => textareaRef.value?.focus())
}

function pickFiles() {
  if (attachments.value.length >= MAX_ATTACHMENTS) {
    message.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`)
    return
  }
  fileInput.value?.click()
}

function onFilePick(event: Event) {
  const el = event.target as HTMLInputElement
  void addFiles(Array.from(el.files ?? []))
  el.value = ''
}

function removeAttachment(id: number) {
  attachments.value = attachments.value.filter((item) => item.id !== id)
  if (previewing.value?.id === id) previewing.value = null
}

function clearAttachments() {
  attachments.value = []
  previewing.value = null
}

function openPreview(item: ComposerAttachment) {
  if (!item.preview) return
  previewing.value = item
}

function closePreview() {
  previewing.value = null
}

function onPreviewKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePreview()
}

function hasDraggedFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(event: DragEvent) {
  if (!hasDraggedFiles(event)) return
  event.preventDefault()
  dragDepth++
  dragging.value = true
}

function onDragOver(event: DragEvent) {
  if (!hasDraggedFiles(event)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave() {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(event: DragEvent) {
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  void addFiles(Array.from(event.dataTransfer?.files ?? []))
}

function onSubmit(text: string) {
  const t = text.trim()
  if (!t) return
  if (!settings.active) {
    message.warning('还没有选择模型：在下方选择，或到「设置 → 模型设置」配置')
    return
  }
  if (canvas.busy) return
  const picked = attachments.value.slice()
  const prompt = composePrompt(t, picked)
  const sent: ChatAttachment[] = picked.map((item) => ({
    name: item.file.name,
    kind: isImageFile(item.file) ? 'image' : 'file',
    size: item.file.size,
    preview: item.preview,
  }))
  input.value = ''
  attachments.value = []
  previewing.value = null
  sendPrompt(prompt, 1, { displayText: t, attachments: sent })
  nextTick(() => {
    autosize()
    textareaRef.value?.focus()
  })
}

function submitInput() {
  if (!canSend.value) return
  onSubmit(input.value)
}

function onComposerKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  submitInput()
}

function onComposerPaste(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (!files.length) return
  event.preventDefault()
  void addFiles(files)
}

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

// 新消息或流式更新时滚到底部
watch(
  () =>
    ws.messages.length +
    canvas.generating.length +
    (canvas.generating.reduce((n, g) => n + g.html.length, 0) > 0 ? 1 : 0) +
    (canvas.agentRun ? (ws.messages.find((m) => m.id === canvas.agentRun!.messageId)?.content.length ?? 0) : 0),
  scrollToBottom,
)

// 附件条变高 / 变矮时保持最新消息可见
watch(() => attachments.value.length, scrollToBottom)

function fmtSelector(ctx: { tag: string; classes: string[]; text?: string }): string {
  const cls = ctx.classes.length ? '.' + ctx.classes.join('.') : ''
  return `<${ctx.tag}${cls}>${ctx.text ? ' ' + ctx.text : ''}`
}

const generatingText = computed(() => '正在生成原型…')

// 风格下拉：内置 + 自定义分组

// 模型选择：来自设置里的服务商列表；只展示模型名，太长时省略号截断
const modelOptions = computed(() =>
  settings.providers.map((p) => ({
    label: p.model || p.name,
    value: p.id,
  })),
)

function onModelChange(id: string) {
  settings.activeId = id
  settings.save()
}

// —— 规划托盘的本地点选状态（按消息 id 隔离）——
const answers = reactive<Record<string, Record<string, string>>>({})
const pickedStyles = reactive<Record<string, PlanStyle>>({})

function pickAnswer(msgId: string, qid: string, opt: string) {
  answers[msgId] = { ...(answers[msgId] ?? {}), [qid]: opt }
}
function pickStyle(msgId: string, s: PlanStyle) {
  if (pickedStyles[msgId]?.name === s.name) {
    delete pickedStyles[msgId] // 再次点击 = 取消选定
  } else {
    pickedStyles[msgId] = s
  }
}
function findOriginalMessage(msg: ChatMessage): ChatMessage | null {
  const idx = ws.messages.findIndex((m) => m.id === msg.id)
  for (let i = idx - 1; i >= 0; i--) {
    if (ws.messages[i].role === 'user') return ws.messages[i]
  }
  return null
}

function findOriginalPrompt(msg: ChatMessage): string {
  const origin = findOriginalMessage(msg)
  return origin?.promptText || origin?.content || ''
}

const replanning = reactive(new Set<string>())

async function onReplan(msg: ChatMessage) {
  if (!msg.plan || !msg.artboardId || replanning.has(msg.id)) return
  replanning.add(msg.id)
  try {
    await replan(msg.artboardId, msg.id, findOriginalPrompt(msg))
  } finally {
    replanning.delete(msg.id)
  }
}

function startPlan(msg: ChatMessage) {
  if (!msg.plan || !msg.artboardId) return
  const origin = findOriginalMessage(msg)
  const original = origin?.promptText || origin?.content || ''
  startFromPlan({
    boardId: msg.artboardId,
    originalPrompt: original,
    answers: { ...(answers[msg.id] ?? {}) },
    style: pickedStyles[msg.id] ?? null,
    items: msg.plan.items ?? [],
    displayPrompt: origin?.content,
    attachments: origin?.attachments ?? undefined,
  })
}

// AI 消息不做「泡泡」：透明内容 + 纯文本排版（v0 / wonder 式阅读体验）
const bubbleStyles = {
  content: {
    background: 'transparent',
    color: 'var(--ink)',
    border: 'none',
    padding: '2px 0',
    fontSize: '13.5px',
    lineHeight: '1.7',
  },
}
</script>

<template>
  <aside class="chat-panel">
    <header class="chat-header">
      <span class="chat-title">设计对话</span>
      <span class="target-chip" :class="{ active: targetBoard }">
        {{ targetBoard ? targetBoard.title : '新画板' }}
      </span>
    </header>

    <div ref="scrollRef" class="chat-scroll">
      <div v-if="!ws.messages.length" class="chat-empty">
        <p class="lead">从一句话开始一个原型</p>
        <p class="sub">生成后点击页面元素即可定向反馈，AI 只改你指的地方</p>
        <button
          v-for="p in PRESETS"
          :key="p.title"
          class="preset"
          @click="sendPrompt(p.prompt, 1)"
        >
          <AppIcon :name="p.icon" :size="14" class="preset-icon" />
          <span class="preset-title">{{ p.title }}</span>
          <AppIcon name="arrow-right" :size="12" class="preset-arrow" />
        </button>
      </div>

      <template v-for="msg in ws.messages" :key="msg.id">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="chat-item user">
          <span class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
          <div class="user-bubble">
            <div v-if="msg.elementContext" class="ctx-chip">
              <code>{{ fmtSelector(msg.elementContext) }}</code>
              <span>针对该元素</span>
            </div>
            <div v-if="msg.attachments?.length" class="msg-attachments">
              <template v-for="(file, i) in msg.attachments" :key="`${msg.id}-${i}`">
                <img
                  v-if="file.kind === 'image' && file.preview"
                  :src="file.preview"
                  :alt="file.name"
                  :title="`${file.name} · ${fmtSize(file.size)}`"
                  class="msg-attach-img"
                />
                <span v-else class="msg-attach-file" :title="`${file.name} · ${fmtSize(file.size)}`">
                  <span class="msg-attach-ext">{{ extLabel(file.name) }}</span>
                  <span class="msg-attach-name">{{ file.name }}</span>
                </span>
              </template>
            </div>
            <p>{{ msg.content }}</p>
          </div>
        </div>
        <!-- AI 消息：规划托盘（对齐 bolt.diy ToolApprovalTray 范式） -->
        <div v-else-if="msg.plan" class="chat-item assistant">
          <section class="plan-tray">
            <p class="plan-tray-title">{{ msg.content }}</p>
            <ul class="plan-list">
              <li v-for="(item, i) in msg.plan.items ?? []" :key="'i' + i" class="plan-row">
                <span class="plan-style-body">
                  <b>{{ i + 1 }}. {{ item }}</b>
                </span>
              </li>
              <li v-for="q in msg.plan.questions" :key="q.id" class="plan-row column">
                <p class="plan-row-label">{{ q.q }}</p>
                <div class="plan-opts">
                  <button
                    v-for="opt in q.options"
                    :key="opt"
                    class="plan-opt"
                    :class="{ picked: answers[msg.id]?.[q.id] === opt }"
                    @click="pickAnswer(msg.id, q.id, opt)"
                  >
                    {{ opt }}
                  </button>
                </div>
              </li>
              <li v-for="s in msg.plan.styles" :key="s.name" class="plan-row">
                <span class="plan-style-body">
                  <b>{{ s.name }}</b>
                  <small>{{ s.desc }}</small>
                </span>
                <button
                  v-if="!msg.plan.info"
                  class="tray-btn solid"
                  :class="{ done: pickedStyles[msg.id]?.name === s.name }"
                  @click="pickStyle(msg.id, s)"
                >
                  {{ pickedStyles[msg.id]?.name === s.name ? '已选定' : '选定' }}
                </button>
              </li>
            </ul>
            <div class="plan-tray-footer">
              <button
                class="tray-btn"
                :disabled="replanning.has(msg.id) || canvas.busy"
                @click="onReplan(msg)"
              >
                <AppIcon name="refresh" :size="11" />
                {{ replanning.has(msg.id) ? '规划中…' : '换一批' }}
              </button>
              <span class="flex1" />
              <span v-if="pickedStyles[msg.id]" class="plan-picked-note">
                已选「{{ pickedStyles[msg.id].name }}」
              </span>
              <button
                class="tray-btn solid"
                :disabled="canvas.busy || replanning.has(msg.id)"
                @click="startPlan(msg)"
              >
                <AppIcon name="sparkle" :size="12" />
                {{ msg.plan.iteration ? '按拆解执行' : '开始生成' }}
              </button>
            </div>
          </section>
        </div>
        <!-- AI 消息：普通文本 -->
        <div v-else class="chat-item assistant">
          <div class="assistant-col">
            <Bubble
              :content="msg.content"
              placement="start"
              variant="filled"
              :styles="bubbleStyles"
              :class="['bubble', msg.status]"
            />
            <div class="assistant-meta">
              <button
                v-if="msg.status === 'error'"
                class="retry-btn"
                :disabled="canvas.busy"
                @click="retryLast()"
              >
                <AppIcon name="refresh" :size="11" /> 重试
              </button>
              <span v-else class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
            </div>
          </div>
        </div>
      </template>

      <div v-if="canvas.generating.length > 0" class="chat-item assistant">
        <Bubble :content="generatingText" loading placement="start" variant="filled" :styles="bubbleStyles" class="bubble" />
      </div>
    </div>

    <footer class="chat-footer">
      <!-- 工作区输入卡：附件缩略图在上方托盘，模型 / 思考在卡片下方 -->
      <div
        class="composer-shell"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop="onDrop"
      >
        <!-- 附件托盘：与输入卡上沿相接，对齐 UIRef sender-studio 的技能栏 -->
        <div v-if="attachments.length" class="attach-tray" role="group" aria-label="已添加的参考图与资料">
          <div class="attach-tray-row">
            <div
              v-for="item in attachments"
              :key="item.id"
              class="tray-tile"
              :title="`${item.file.name} · ${fmtSize(item.file.size)}`"
            >
              <button
                v-if="item.preview"
                type="button"
                class="tray-preview"
                :aria-label="`预览 ${item.file.name}`"
                @click="openPreview(item)"
              >
                <img :src="item.preview" :alt="item.file.name" />
              </button>
              <span v-else class="tray-file">{{ extLabel(item.file.name) }}</span>
              <button
                type="button"
                class="tray-x"
                :aria-label="`移除 ${item.file.name}`"
                @click="removeAttachment(item.id)"
              >
                <AppIcon name="close" :size="9" />
              </button>
            </div>
          </div>
          <button type="button" class="tray-clear" title="清空附件" aria-label="清空附件" @click="clearAttachments">
            <AppIcon name="trash" :size="13" />
          </button>
        </div>
        <div class="composer-card" :class="{ 'is-loading': canvas.busy }">
          <textarea
            ref="textareaRef"
            v-model="input"
            rows="1"
            class="composer-input"
            :placeholder="placeholder"
            aria-label="输入设计需求"
            @keydown="onComposerKeydown"
            @paste="onComposerPaste"
          ></textarea>
          <div class="composer-tools">
            <button
              type="button"
              class="tool-icon"
              title="添加图片或资料（也可拖入或粘贴）"
              aria-label="添加图片或资料"
              @click="pickFiles"
            >
              <AppIcon name="plus" :size="17" />
            </button>
            <span class="tools-spacer" />
            <button
              type="button"
              class="send-btn"
              :class="{ stop: canvas.busy }"
              :disabled="!canvas.busy && !canSend"
              :aria-label="canvas.busy ? '停止生成' : '发送'"
              :aria-busy="canvas.busy"
              @click="canvas.busy ? stopGeneration() : submitInput()"
            >
              <span v-if="canvas.busy" class="stop-square" aria-hidden="true" />
              <AppIcon v-else name="arrow-up" :size="16" />
            </button>
          </div>
        </div>
        <!-- 模型与思考：收在 sender 卡片下方 -->
        <div class="composer-under">
          <div class="model-slot">
            <Select
              :value="settings.activeId || undefined"
              size="small"
              class="model-select"
              :options="modelOptions"
              :placeholder="settings.providers.length ? '选择模型' : '配置模型'"
              placement="topLeft"
              :popup-match-select-width="false"
              popup-class-name="composer-dropdown"
              @change="(v: any) => onModelChange(v)"
            />
          </div>
          <button
            type="button"
            class="think-pill"
            :class="{ on: canvas.deepThink }"
            :aria-pressed="canvas.deepThink"
            title="深度思考：透传 reasoning_effort=high，仅部分模型支持"
            @click="canvas.toggleDeepThink()"
          >
            <AppIcon name="sparkle" :size="12" />
            <span>思考</span>
          </button>
        </div>
        <div v-if="dragging" class="drop-overlay" aria-hidden="true">
          <AppIcon name="image" :size="18" />
          <b>松开即可添加图片或资料</b>
          <span>也支持在输入框里直接粘贴截图</span>
        </div>
      </div>
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="FILE_ACCEPT"
        class="attach-input"
        tabindex="-1"
        aria-hidden="true"
        @change="onFilePick"
      />
      <Teleport to="body">
        <div
          v-if="previewing"
          class="attach-preview"
          role="dialog"
          aria-modal="true"
          :aria-label="previewing.file.name"
          @click.self="closePreview"
        >
          <div class="attach-preview-panel">
            <button
              ref="previewCloseRef"
              type="button"
              class="attach-preview-close"
              aria-label="关闭预览"
              @click="closePreview"
            >
              <AppIcon name="close" :size="15" />
            </button>
            <img :src="previewing.preview" :alt="previewing.file.name" />
            <div class="attach-preview-name">{{ previewing.file.name }}</div>
          </div>
        </div>
      </Teleport>
    </footer>
  </aside>
</template>

<style scoped>
.chat-panel {
  width: 344px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  color: var(--ink);
  min-height: 0;
}
.chat-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.chat-title {
  font-family: var(--display);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.target-chip {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--ink-3);
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target-chip.active {
  color: var(--accent);
  border-color: rgba(22, 119, 255, 0.5);
}
.chat-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.chat-item {
  animation: enter var(--dur) var(--ease);
}
.chat-item.user {
  display: flex;
  justify-content: flex-end;
  align-items: flex-end;
  gap: 8px;
}
.msg-time {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-3);
}
.user-bubble {
  max-width: 88%;
  background: var(--bg-elevated);
  box-shadow: var(--hairline-inset);
  color: var(--ink);
  border-radius: 14px 4px 14px 14px;
  padding: 9px 13px;
}
.user-bubble p {
  margin: 0;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.ctx-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.ctx-chip code {
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 4px;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-chip span {
  font-size: 11px;
  color: var(--ink-2);
}
.assistant-col {
  max-width: 94%;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.bubble {
  max-width: 100%;
  font-size: 13.5px;
}
/* Agent 改代码的进度是逐行的工具调用，保留换行 */
.bubble :deep([class*='bubble-content']) {
  white-space: pre-wrap;
  word-break: break-word;
}
/* 错误态：透明泡泡下的红色静默卡 */
.bubble.error {
  background: var(--danger-soft);
  box-shadow: inset 0 0 0 1px var(--danger-ring);
  border-radius: 10px;
  padding: 8px 12px;
}
.bubble.error :deep([class*='bubble-content']) {
  background: transparent !important;
}
.retry-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-2);
  font-size: 11.5px;
  padding: 3px 9px;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.retry-btn:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.retry-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 6px;
}
.chat-empty .lead {
  font-family: var(--display);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
  margin: 0 0 4px;
  text-align: center;
}
.chat-empty .sub {
  font-size: 12.5px;
  color: var(--ink-3);
  margin: 0 0 20px;
  text-align: center;
  line-height: 1.7;
}
.preset {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  padding: 10px 4px;
  cursor: pointer;
  color: var(--ink);
  font-family: var(--sans);
  transition: color var(--dur-fast) var(--ease), padding-left var(--dur-fast) var(--ease);
}
.preset:hover {
  color: var(--ink);
  padding-left: 9px;
}
.preset-icon {
  color: var(--ink-3);
  flex: none;
}
.preset:hover .preset-icon {
  color: var(--accent);
}
.preset-title {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
}
.preset-arrow {
  color: var(--line-strong);
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.preset:hover .preset-arrow {
  opacity: 1;
}
.chat-footer {
  padding: 12px 14px 14px;
}
.composer-shell {
  --composer-radius: 24px;
  position: relative;
}
.attach-input {
  display: none;
}
/* —— 附件托盘：与输入卡上沿相接的玻璃层（对齐 sender-studio 技能栏） —— */
.attach-tray {
  position: relative;
  z-index: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  /* 左右内缩 = 卡片圆角半径，托盘边线正好落在圆角切点上，避免两侧楔形缺口 */
  width: calc(100% - var(--composer-radius) * 2);
  margin: 0 auto -1px;
  padding: 4px 6px 4px 8px;
  border: 1px solid var(--tray-border);
  border-radius: 16px 16px 0 0;
  background: var(--tray-bg);
  box-shadow: var(--tray-shadow);
  backdrop-filter: blur(20px) saturate(1.3);
  animation: enter var(--dur) var(--ease);
}
.attach-tray-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  padding: 0 1px;
  scrollbar-width: none;
}
.attach-tray-row::-webkit-scrollbar {
  display: none;
}
.tray-tile {
  position: relative;
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
}
.tray-preview {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 8px;
  overflow: hidden;
  background: transparent;
  cursor: zoom-in;
}
.tray-preview img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tray-file {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--accent);
}
.tray-x {
  position: absolute;
  top: 1px;
  right: 1px;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: var(--scrim-btn-bg);
  color: var(--ink-2);
  opacity: 0;
  transform: scale(0.8);
  cursor: pointer;
  backdrop-filter: blur(2px);
  transition:
    opacity var(--dur-fast) var(--ease),
    transform var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.tray-tile:hover .tray-x,
.tray-tile:focus-within .tray-x {
  opacity: 1;
  transform: none;
}
.tray-x:hover {
  color: var(--ink);
  background: var(--scrim-btn-bg-hover);
}
.tray-clear {
  flex: none;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.tray-clear:hover {
  color: var(--ink);
  background: var(--bg-raised);
}
.tray-preview:focus-visible,
.tray-x:focus-visible,
.tray-clear:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
/* —— 图片附件预览：点击 chip 打开，Esc / 点击遮罩关闭 —— */
.attach-preview {
  position: fixed;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  padding: 24px;
  background: var(--preview-scrim);
  backdrop-filter: blur(6px);
}
.attach-preview-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  max-width: min(560px, 86vw);
  max-height: 82vh;
  padding: 44px 18px 18px;
  background: var(--bg-panel);
  border-radius: 18px;
  box-shadow: var(--shadow-modal);
}
.attach-preview-panel img {
  display: block;
  max-width: 100%;
  max-height: 60vh;
  border-radius: 10px;
  object-fit: contain;
}
.attach-preview-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--ink-3);
}
.attach-preview-close {
  position: absolute;
  top: 10px;
  right: 10px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--scrim-border);
  border-radius: 50%;
  background: var(--scrim-btn-bg);
  color: var(--ink-2);
  cursor: pointer;
  backdrop-filter: blur(4px);
}
.attach-preview-close:hover {
  color: var(--ink);
  background: var(--scrim-btn-bg-hover);
}
.attach-preview-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.tool-icon:focus-visible,
.think-pill:focus-visible,
.send-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.msg-attach-ext {
  flex: none;
  font-family: var(--mono);
  font-size: 8.5px;
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0.04em;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 5px 4px;
}
.drop-overlay {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1.5px dashed rgba(22, 119, 255, 0.65);
  border-radius: 24px;
  background: var(--drop-bg);
  color: var(--accent);
  pointer-events: none;
  backdrop-filter: blur(3px);
}
.drop-overlay b {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.drop-overlay span {
  font-size: 10.5px;
  color: var(--ink-3);
}
/* —— 用户气泡里的参考图 / 资料 —— */
.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 7px;
}
.msg-attach-img {
  display: block;
  width: 58px;
  height: 58px;
  object-fit: cover;
  border-radius: 7px;
  box-shadow: var(--hairline-inset);
}
.msg-attach-file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 190px;
  height: 24px;
  padding: 0 7px 0 3px;
  border-radius: 6px;
  background: var(--hover);
  font-size: 11px;
  color: var(--ink-2);
}
.msg-attach-ext {
  padding: 3px 4px;
  font-size: 8px;
}
.msg-attach-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* —— 工作区输入卡：textarea 在上、工具行在下（对齐 sender-studio） —— */
.composer-card {
  position: relative;
  z-index: 1;
  background: var(--bg-elevated);
  border: 1px solid var(--line-strong);
  border-radius: var(--composer-radius);
  box-shadow: var(--composer-shadow);
  transition:
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.composer-card:focus-within {
  border-color: rgba(22, 119, 255, 0.5);
  box-shadow: var(--composer-shadow-focus);
}
.composer-input {
  display: block;
  width: 100%;
  min-height: 56px;
  max-height: 144px;
  padding: 15px 16px 4px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 13.5px;
  line-height: 20px;
  resize: none;
  overflow-y: auto;
  scrollbar-width: none;
}
.composer-input::-webkit-scrollbar {
  display: none;
}
.composer-input::placeholder {
  color: var(--ink-3);
}
.composer-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 8px;
}
.tool-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--ink-2);
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.tool-icon:hover {
  color: var(--ink);
  background: var(--bg-raised);
}
.tools-spacer {
  flex: 1;
  min-width: 4px;
}
/* —— sender 下方：模型选择 + 深度思考 —— */
.composer-under {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 0 2px;
}
.model-slot {
  flex: none;
  width: 176px;
  max-width: 58%;
  min-width: 0;
}
/* antdv-next 的 Select 根节点即选择框；根节点不带 scoped 属性，统一走 :deep */
.model-slot :deep(.model-select.ant-select) {
  width: 100%;
  min-width: 0;
  height: 30px;
  padding: 0 18px 0 10px;
  border: none !important;
  border-radius: 999px !important;
  background: transparent !important;
  box-shadow: var(--btn-quiet-shadow) !important;
  font-size: 12px;
  color: var(--ink-2);
  transition: background var(--dur-fast) var(--ease);
}
.model-slot :deep(.model-select.ant-select:hover),
.model-slot :deep(.model-select.ant-select-focused),
.model-slot :deep(.model-select.ant-select-open) {
  background: var(--bg-raised) !important;
  box-shadow: var(--btn-quiet-shadow) !important;
}
.model-slot :deep(.ant-select-content) {
  min-width: 0;
  height: 28px;
  overflow: hidden;
  line-height: 28px;
}
.model-slot :deep(.ant-select-placeholder),
.model-slot :deep(.ant-select-content-value),
.model-slot :deep(.ant-select-content-has-value) {
  overflow: hidden;
  color: var(--ink-2);
  font-size: 12px;
  font-weight: 500;
  line-height: 28px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-slot :deep(.ant-select-placeholder) {
  color: var(--ink-3);
  font-weight: 400;
}
.model-slot :deep(.ant-select-input) {
  padding: 0;
  font-size: 12px;
}
.model-slot :deep(.ant-select-suffix) {
  color: var(--ink-3);
  font-size: 10px;
}
.think-pill {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 999px;
  background: transparent;
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
  font-family: var(--sans);
  font-size: 11.5px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease);
}
.think-pill:hover {
  color: var(--ink);
  background: var(--bg-raised);
}
.think-pill.on {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
.send-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
  cursor: pointer;
  transition:
    filter var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease),
    opacity var(--dur-fast) var(--ease);
}
.send-btn:not(:disabled):not(.stop):hover {
  filter: brightness(1.1);
}
.send-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.send-btn.stop {
  background: var(--bg-raised);
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
}
.stop-square {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: currentColor;
}
.flex1 {
  flex: 1;
}
.style-select {
  display: none;
}

/* —— 规划托盘（对齐 bolt.diy ToolApprovalTray 范式：托盘卡 + divide-y 列表 + 右侧操作）—— */
.plan-tray {
  width: 100%;
  max-width: 94%;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}
.plan-tray-title {
  margin: 0;
  padding: 10px 12px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.plan-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.plan-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-top: 1px solid var(--line);
}
.plan-row.column {
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
}
.plan-row-label {
  margin: 0;
  font-size: 12.5px;
  color: var(--ink);
}
.plan-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.plan-opt {
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
  font-family: var(--sans);
}
.plan-opt:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}
.plan-opt.picked {
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  border-color: transparent;
  color: #fff;
}
.plan-style-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.plan-style-body b {
  font-size: 12.5px;
  color: var(--ink);
}
.plan-style-body small {
  font-size: 11.5px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tray-btn {
  flex: none;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  padding: 4px 12px;
  border-radius: var(--radius-s);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.tray-btn:hover:not(:disabled) {
  color: var(--ink);
  border-color: var(--ink-3);
}
.tray-btn.solid {
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  border-color: transparent;
  color: #fff;
}
.tray-btn.solid:hover:not(:disabled) {
  filter: brightness(1.1);
  border-color: transparent;
  color: #fff;
}
.tray-btn.solid.done {
  background: transparent;
  color: var(--accent);
}
.tray-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.plan-tray-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-top: 1px solid var(--line);
}
.plan-picked-note {
  font-size: 11.5px;
  color: var(--accent);
}
</style>

