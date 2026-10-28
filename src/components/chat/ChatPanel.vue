<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Bubble, Sender } from '@antdv-next/x'
import { Select } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { replan, retryLast, sendPrompt, startFromPlan, stopGeneration } from '@/services/orchestrator'
import { pluginRegistry } from '@/plugins/registry'
import type { PresetPluginData } from '@/plugins/types'
import type { ChatMessage, PlanStyle } from '@/types'
import AppIcon from '@/components/ui/AppIcon.vue'

const canvas = useCanvasStore()
const ws = useWorkspaceStore()
const settings = useSettingsStore()

const input = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const variantCount = ref(1)

const targetBoard = computed(() => ws.findArtboard(canvas.selectedArtboardId))

const placeholder = computed(() => {
  const b = targetBoard.value
  if (!b) return '描述你想要的页面，AI 将创建画板并生成原型'
  return b.versions.length
    ? `向「${b.title}」描述改动，Enter 发送`
    : `将在「${b.title}」上生成原型，描述你想要的页面`
})

const PRESETS = pluginRegistry
  .listByKind('preset')
  .map((p) => ({ icon: (p.data as PresetPluginData).icon, title: p.name, prompt: (p.data as PresetPluginData).prompt }))

function fmtTime(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function onSubmit(text: string) {
  const t = text.trim()
  if (!t) return
  input.value = ''
  sendPrompt(t, variantCount.value)
}

// 新消息或流式更新时滚到底部
watch(
  () =>
    ws.messages.length +
    canvas.generating.length +
    (canvas.generating.reduce((n, g) => n + g.html.length, 0) > 0 ? 1 : 0),
  () => {
    nextTick(() => {
      const el = scrollRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  },
)

function fmtSelector(ctx: { tag: string; classes: string[]; text?: string }): string {
  const cls = ctx.classes.length ? '.' + ctx.classes.join('.') : ''
  return `<${ctx.tag}${cls}>${ctx.text ? ' ' + ctx.text : ''}`
}

const generatingText = computed(() => {
  const n = canvas.generating.length
  if (n > 1) return `正在并行生成 ${n} 个方案…`
  return '正在生成原型…'
})

// 是否处于「新建」场景：可选拆分多方案
const isNewScene = computed(() => !targetBoard.value || targetBoard.value.versions.length === 0)

// 风格下拉：内置 + 自定义分组

// 模型选择：来自设置里的服务商列表
const modelOptions = computed(() =>
  settings.providers.map((p) => ({
    label: p.id === 'demo' ? p.name : `${p.name} · ${p.model}`,
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
function findOriginalPrompt(msg: ChatMessage): string {
  const idx = ws.messages.findIndex((m) => m.id === msg.id)
  for (let i = idx - 1; i >= 0; i--) {
    if (ws.messages[i].role === 'user') return ws.messages[i].content
  }
  return ''
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
  const original = findOriginalPrompt(msg)
  startFromPlan({
    boardId: msg.artboardId,
    originalPrompt: original,
    answers: { ...(answers[msg.id] ?? {}) },
    style: pickedStyles[msg.id] ?? null,
    items: msg.plan.items ?? [],
  })
}

// 深色侧栏下的 AI 气泡内容样式
const bubbleStyles = {
  content: {
    background: 'var(--bg-raised)',
    color: 'var(--ink)',
    border: '1px solid var(--line)',
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
          @click="sendPrompt(p.prompt, variantCount)"
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
                :disabled="replanning.has(msg.id) || canvas.generating.length > 0"
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
                :disabled="canvas.generating.length > 0 || replanning.has(msg.id)"
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
                :disabled="canvas.generating.length > 0"
                @click="retryLast()"
              >
                <AppIcon name="refresh" :size="11" /> 重试
              </button>
              <span v-else class="msg-time">{{ fmtTime(msg.createdAt) }}</span>
            </div>
          </div>
        </div>
      </template>

      <div v-if="canvas.generating" class="chat-item assistant">
        <Bubble :content="generatingText" loading placement="start" variant="filled" :styles="bubbleStyles" class="bubble" />
      </div>
    </div>

    <footer class="chat-footer">
      <!-- v0 式 composer：控件全部收进输入框卡片 -->
      <Sender
        v-model:value="input"
        :loading="canvas.generating.length > 0"
        :placeholder="placeholder"
        :auto-size="{ minRows: 1, maxRows: 6 }"
        class="composer"
        @submit="onSubmit"
        @cancel="stopGeneration"
      >
        <template #header>
          <div v-if="isNewScene" class="composer-header">
            <span class="variant-label">并行方案</span>
            <button
              v-for="n in [1, 2, 3]"
              :key="n"
              class="count-chip"
              :class="{ picked: variantCount === n }"
              @click="variantCount = n"
            >
              {{ n }} 个
            </button>
            <span class="flex1" />
          </div>
        </template>
        <template #footer>
          <div class="composer-footer">
            <Select
              :value="settings.activeId"
              size="small"
              class="model-select"
              :options="modelOptions"
              popup-class-name="composer-dropdown"
              @change="(v: any) => onModelChange(v)"
            />
            <button
              class="think-chip"
              :class="{ on: canvas.deepThink }"
              title="深度思考：透传 reasoning_effort=high，仅部分模型支持"
              @click="canvas.toggleDeepThink()"
            >
              <AppIcon name="sparkle" :size="12" />
              思考
            </button>
            <span class="flex1" />
            <span class="header-note">AI 规划风格</span>
          </div>
        </template>
      </Sender>
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
  font-family: var(--serif);
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
  border-color: rgba(255, 107, 71, 0.5);
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
/* Bubble 组件自带的打字起始装饰点：内容完整渲染时是冗余噪音 */
.chat-item :deep(.antd-bubble-start) {
  display: none;
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
  background: var(--bg-raised);
  border: 1px solid var(--line);
  color: var(--ink);
  border-radius: 12px 4px 12px 12px;
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
  background: var(--accent-deep);
  color: #fff;
  font-size: 11px;
  padding: 1px 6px;
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
  font-size: 13px;
}
.bubble.error {
  border-left: 3px solid var(--accent) !important;
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
  font-family: var(--serif);
  font-size: 17px;
  font-weight: 600;
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
  padding: 10px 12px 12px;
}
/* —— v0 式 composer：控件收进输入框卡片 —— */
.composer {
  border-radius: var(--radius-l);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
}
.composer :deep(.antd-sender-header) {
  padding: 9px 12px 0 !important;
  border-bottom: none !important;
}
.composer-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line);
}
.count-chip {
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--ink-2);
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 999px;
  cursor: pointer;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.count-chip:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}
.count-chip.picked {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.header-note {
  font-size: 10.5px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer :deep(.antd-sender-footer) {
  padding: 0 8px 6px !important;
  border-top: none !important;
}
.composer-footer {
  display: flex;
  align-items: center;
  gap: 4px;
}
.model-select {
  min-width: 0;
  flex: 0 1 auto;
  max-width: 170px;
}
.model-select :deep(.ant-select-selector) {
  border: none !important;
  background: transparent !important;
  padding-left: 6px !important;
  font-size: 12px;
  color: var(--ink-2);
}
.model-select :deep(.ant-select-arrow) {
  color: var(--ink-3);
}
.variant-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  color: var(--ink-3);
  white-space: nowrap;
}
.flex1 {
  flex: 1;
}
.model-select {
  min-width: 128px;
}
.think-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-3);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.think-chip:hover {
  color: var(--ink);
  border-color: var(--ink-3);
}
.think-chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
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
  background: var(--accent);
  border-color: var(--accent);
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
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.tray-btn.solid:hover:not(:disabled) {
  background: var(--accent-deep);
  border-color: var(--accent-deep);
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

