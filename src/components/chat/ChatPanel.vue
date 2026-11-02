<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Bubble, Sender } from '@antdv-next/x'
import { Select, message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { retryLast, sendPrompt, stopGeneration } from '@/services/orchestrator'
import { pluginRegistry } from '@/plugins/registry'
import type { PresetPluginData } from '@/plugins/types'
import type { ChatMessage, PlanStyle } from '@/types'
import AppIcon from '@/components/ui/AppIcon.vue'
import PlanCard from '@/components/chat/PlanCard.vue'
const canvas = useCanvasStore()
const ws = useWorkspaceStore()
const settings = useSettingsStore()
const input = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const targetBoard = computed(() => ws.findArtboard(canvas.selectedArtboardId))
const placeholder = computed(() => {
  const b = targetBoard.value
  if (!b) return '描述你想要的页面或组件，AI 将创建画板并生成'
  if (b.kind === 'live') {
    return b.live?.type === 'repo'
      ? `描述要改的地方，本机 Agent 会直接修改「${b.title}」的代码`
      : '网页实时画板没有源码：先在头栏「捕获」为设计稿再迭代'
  }
  if (!b.versions.length) return `将在「${b.title}」上生成页面或组件，描述你的需求`
  return b.artifactMode === 'component'
    ? `向「${b.title}」描述组件改动，新画板会并排出现`
    : `向「${b.title}」描述改动，新画板会并排出现`
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
  if (!settings.active) {
    message.warning('还没有选择模型：在下方选择，或到「设置 → 模型设置」配置')
    return
  }
  input.value = ''
  sendPrompt(t, 1)
}
// 新消息或流式更新时滚到底部
function scrollChatToBottom() {
  nextTick(() => {
    requestAnimationFrame(() => {
      const el = scrollRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  })
}
watch(
  () =>
    ws.messages.length +
    canvas.generating.length +
    (canvas.generating.reduce((n, g) => n + g.html.length, 0) > 0 ? 1 : 0) +
    (canvas.agentRun ? (ws.messages.find((m) => m.id === canvas.agentRun!.messageId)?.content.length ?? 0) : 0),
  scrollChatToBottom,
)
function fmtSelector(ctx: { tag: string; classes: string[]; text?: string }): string {
  const cls = ctx.classes.length ? '.' + ctx.classes.join('.') : ''
  return `<${ctx.tag}${cls}>${ctx.text ? ' ' + ctx.text : ''}`
}
const generatingText = computed(() => {
  const mode = targetBoard.value?.artifactMode
  if (mode === 'component') return '正在生成组件…'
  if (mode === 'page') return '正在生成原型…'
  return '正在生成…'
})
/** 空态预设：先取消选中，确保总是在新画板上生成，而不是迭代当前页面 */
function usePreset(prompt: string) {
  canvas.select(null)
  sendPrompt(prompt, 1)
}
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
// —— 确认卡状态（按消息 id 隔离）：卡片只负责当前答案，提交后仍可回看 ——
const answers = reactive<Record<string, Record<string, string>>>({})
const pickedStyles = reactive<Record<string, PlanStyle>>({})

function onPlanAnswers(msgId: string, value: Record<string, string>) {
  if (Object.keys(value).length) answers[msgId] = value
  else delete answers[msgId]
}

function onPlanStyle(msgId: string, value: PlanStyle | null) {
  if (value) pickedStyles[msgId] = value
  else delete pickedStyles[msgId]
}

/** 这次确认是否已经产出结果：新画板有版本，或迭代卡之后多出了子画板 */
function planHasOutcome(msg: ChatMessage): boolean {
  const plan = msg.plan
  if (!plan || plan.info || !msg.artboardId) return false
  const board = ws.findArtboard(msg.artboardId)
  if (!board) return false
  if (plan.iteration) {
    return ws.artboards.some((b) => b.parent === board.id && b.createdAt >= msg.createdAt)
  }
  return board.versions.length > 0
}

/** 只有最近一张尚未产出结果的确认卡会贴到输入框上方 */
const activePlanMsg = computed<ChatMessage | null>(() => {
  for (let i = ws.messages.length - 1; i >= 0; i--) {
    const msg = ws.messages[i]
    if (msg.plan && !msg.plan.info && !planHasOutcome(msg)) return msg
  }
  return null
})
const activePlanAnswers = computed(() => {
  const msg = activePlanMsg.value
  return msg ? answers[msg.id] : undefined
})
const activePlanStyle = computed(() => {
  const msg = activePlanMsg.value
  return msg ? pickedStyles[msg.id] : undefined
})
function onActivePlanAnswers(value: Record<string, string>) {
  const msg = activePlanMsg.value
  if (msg) onPlanAnswers(msg.id, value)
}
function onActivePlanStyle(value: PlanStyle | null) {
  const msg = activePlanMsg.value
  if (msg) onPlanStyle(msg.id, value)
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
        <p class="lead">从一句话开始一个页面或组件</p>
        <p class="sub">生成后点击元素即可定向反馈，AI 只改你指的地方</p>
        <button
          v-for="p in PRESETS"
          :key="p.title"
          class="preset"
          @click="usePreset(p.prompt)"
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
        <!-- AI 消息：确认卡 / 信息卡；当前待确认的那张停靠在输入框上方 -->
        <div v-else-if="msg.plan && msg.id !== activePlanMsg?.id" class="chat-item assistant">
          <PlanCard
            :msg="msg"
            :completed="planHasOutcome(msg)"
            :answers="answers[msg.id]"
            :style="pickedStyles[msg.id]"
            @update:answers="(v) => onPlanAnswers(msg.id, v)"
            @update:style="(s) => onPlanStyle(msg.id, s)"
          />
        </div>
        <!-- AI 消息：普通文本 -->
        <div v-else-if="!msg.plan" class="chat-item assistant">
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
      <!-- 待确认的计划直接停在输入框上方，确认后回到对话流里收起 -->
      <div v-if="activePlanMsg" class="plan-dock">
        <PlanCard
          :key="activePlanMsg.id"
          :msg="activePlanMsg"
          active
          :answers="activePlanAnswers"
          :style="activePlanStyle"
          @update:answers="onActivePlanAnswers"
          @update:style="onActivePlanStyle"
        />
      </div>
      <!-- v0 式 composer：控件全部收进输入框卡片 -->
      <Sender
        v-model:value="input"
        :loading="canvas.busy"
        :placeholder="placeholder"
        :auto-size="{ minRows: 1, maxRows: 6 }"
        class="composer"
        :class="canvas.busy ? 'is-loading' : ''"
        @submit="onSubmit"
        @cancel="stopGeneration"
      >
        <template #footer>
          <div class="composer-footer">
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
      <!-- 模型选择独立成行：不与输入框内控件互相挤压 -->
      <div class="under-sender">
        <Select
          :value="settings.activeId || undefined"
          size="small"
          class="model-select"
          :options="modelOptions"
          :placeholder="settings.providers.length ? '选择模型' : '点击配置模型'"
          placement="topLeft"
          popup-class-name="composer-dropdown"
          @change="(v: any) => onModelChange(v)"
        />
      </div>
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
  /* 分步卡切换会改变内容高度；关掉滚动锚定，交给底部跟随逻辑 */
  overflow-anchor: none;
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
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
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
  background: rgba(22, 119, 255, 0.16);
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
  background: rgba(255, 84, 89, 0.07);
  box-shadow: inset 0 0 0 1px rgba(255, 84, 89, 0.28);
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
/* —— wonder 式 composer：一块浮起的输入卡片，控件皆为静默 pill —— */
.composer {
  background: var(--bg-elevated) !important;
  border: none !important;
  border-radius: 14px !important;
  padding: 4px !important;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.07),
    0 10px 32px rgba(0, 0, 0, 0.45);
  transition: box-shadow var(--dur) var(--ease);
}
.composer:focus-within {
  box-shadow:
    inset 0 0 0 1px rgba(22, 119, 255, 0.45),
    0 0 0 4px rgba(22, 119, 255, 0.1),
    0 10px 32px rgba(0, 0, 0, 0.45);
}
.composer :deep(.antd-sender-content) {
  gap: 4px;
}
.composer :deep(.ant-input) {
  padding: 8px 10px !important;
  font-size: 13.5px;
  color: var(--ink);
  background: transparent !important;
}
.composer :deep(.ant-input::placeholder) {
  color: var(--ink-3);
}
/* 发送 / 停止按钮：紫色高光圆钮 */
.composer :deep(.antd-sender-actions-list .ant-btn) {
  width: 30px;
  height: 30px;
  border: none !important;
  color: var(--ink-3) !important;
  background: transparent !important;
  box-shadow: none !important;
  transition: filter var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.composer :deep(.antd-sender-actions-list .ant-btn:not(:disabled)) {
  background: var(--btn-primary-bg) !important;
  box-shadow: var(--btn-primary-shadow) !important;
  color: #fff !important;
}
.composer :deep(.antd-sender-actions-list .ant-btn:not(:disabled):hover) {
  filter: brightness(1.1);
}
.composer.is-loading :deep(.antd-sender-actions-list .ant-btn:not(:disabled)) {
  background: var(--bg-raised) !important;
  box-shadow: var(--btn-quiet-shadow) !important;
  color: var(--ink-2) !important;
}
.header-note {
  font-size: 10.5px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.composer :deep(.antd-sender-footer) {
  padding: 0 !important;
  border-top: none !important;
}
.composer-footer {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px 8px;
}
.under-sender {
  display: flex;
  align-items: center;
  margin-top: 6px;
}
.model-select {
  /* 固定宽度：切换模型时选中文案长短不一，自适应宽度会导致整行跳动 */
  flex: none;
  width: 240px;
}
.model-select :deep(.ant-select-selector) {
  border: none !important;
  background: transparent !important;
  box-shadow: var(--btn-quiet-shadow);
  border-radius: 999px !important;
  padding: 2px 9px !important;
  font-size: 12px;
  color: var(--ink-2) !important;
  transition: background var(--dur-fast) var(--ease);
}
.model-select :deep(.ant-select-selector:hover) {
  background: var(--bg-raised) !important;
  color: var(--ink);
}
/* 打开/聚焦时压掉 antd 默认的蓝色光环，避免视觉闪动 */
.model-select :deep(.ant-select-focused .ant-select-selector),
.model-select :deep(.ant-select-open .ant-select-selector) {
  border: none !important;
  box-shadow: var(--btn-quiet-shadow) !important;
  background: var(--bg-raised) !important;
}
.model-select :deep(.ant-select-arrow) {
  color: var(--ink-3);
  font-size: 10px;
  inset-inline-end: 9px;
}
.flex1 {
  flex: 1;
}
.think-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  box-shadow: var(--btn-quiet-shadow);
  background: transparent;
  color: var(--ink-2);
  font-size: 12px;
  padding: 3.5px 11px;
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.think-chip:hover {
  color: var(--ink);
  background: var(--bg-raised);
}
.think-chip.on {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
.style-select {
  display: none;
}
/* —— 待确认的计划直接停在输入框上方 —— */
.plan-dock {
  margin-bottom: 6px;
  animation: plan-dock-in var(--dur) var(--ease);
}
@keyframes plan-dock-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
