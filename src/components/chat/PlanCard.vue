<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useCanvasStore } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
import { replan, startFromPlan } from '@/services/orchestrator'
import type { ChatMessage, PlanQuestion, PlanStyle } from '@/types'
import {
  ARTIFACT_MODE_QUESTION_ID,
  COMPONENT_OPTION,
  PAGE_OPTION,
  inferArtifactMode,
  isArtifactModeQuestion,
} from '@/utils/artifactMode'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = withDefaults(
  defineProps<{
    msg: ChatMessage
    active?: boolean
    completed?: boolean
    answers?: Record<string, string>
    style?: PlanStyle | null
  }>(),
  {
    active: false,
    completed: false,
    answers: () => ({}),
    style: null,
  },
)

const emit = defineEmits<{
  (e: 'update:answers', value: Record<string, string>): void
  (e: 'update:style', value: PlanStyle | null): void
}>()

const ws = useWorkspaceStore()
const canvas = useCanvasStore()

const localAnswers = reactive<Record<string, string>>({ ...props.answers })
const drafts = reactive<Record<string, string>>({})
const pillPicks = reactive<Record<string, string>>({})
const pickedStyle = ref<PlanStyle | null>(props.style ?? null)
const styleDraft = ref('')
const starting = ref(false)
const replanning = ref(false)
const expanded = ref(false)

const plan = computed(() => props.msg.plan ?? null)
const isInfo = computed(() => !!plan.value?.info)
const isIteration = computed(() => !!plan.value?.iteration)
const interactive = computed(() => props.active && !isInfo.value)
const questions = computed<PlanQuestion[]>(() => plan.value?.questions ?? [])
const styles = computed<PlanStyle[]>(() => plan.value?.styles ?? [])
const items = computed<string[]>(() => plan.value?.items ?? [])

type PlanStep = { kind: 'question'; q: PlanQuestion } | { kind: 'style' }
const stepIndex = ref(0)
/** 一次只看一页：每道问题一页，有风格方案时风格单独一页 */
const steps = computed<PlanStep[]>(() => {
  if (isInfo.value) return []
  const list = questions.value.map((q): PlanStep => ({ kind: 'question', q }))
  if (!isIteration.value && styles.value.length) list.push({ kind: 'style' })
  return list
})
const stepCount = computed(() => steps.value.length)
const currentStep = computed<PlanStep | null>(() => {
  if (!steps.value.length) return null
  return steps.value[Math.min(stepIndex.value, steps.value.length - 1)]
})
const currentQuestion = computed<PlanQuestion | null>(() =>
  currentStep.value?.kind === 'question' ? currentStep.value.q : null,
)
const isStyleStep = computed(() => currentStep.value?.kind === 'style')
const isLastStep = computed(() => stepCount.value <= 1 || stepIndex.value >= stepCount.value - 1)

function syncAnswers() {
  emit('update:answers', { ...localAnswers })
}

function syncStyle() {
  emit('update:style', effectiveStyle.value)
}

function resetLocal() {
  for (const key of Object.keys(localAnswers)) delete localAnswers[key]
  for (const key of Object.keys(drafts)) delete drafts[key]
  for (const key of Object.keys(pillPicks)) delete pillPicks[key]
  pickedStyle.value = null
  styleDraft.value = ''
  expanded.value = false
  stepIndex.value = 0
  syncAnswers()
  syncStyle()
}

watch(
  () => props.msg.plan,
  () => resetLocal(),
)

/** 有效答案：显式作答优先；类型问题未作答时展示规划判断的预选项 */
function answerFor(q: PlanQuestion): string | undefined {
  const explicit = localAnswers[q.id]?.trim()
  if (explicit) return explicit
  const payload = plan.value
  if (payload && isArtifactModeQuestion(q)) {
    if (payload.artifactMode === 'component') return COMPONENT_OPTION
    if (payload.artifactMode === 'page') return PAGE_OPTION
  }
  return undefined
}

function draftOf(q: PlanQuestion): string {
  return drafts[q.id] ?? ''
}

/** 输入框里是自定义内容（不等于任何预设选项）时高亮 */
function isCustomAnswer(q: PlanQuestion): boolean {
  const draft = drafts[q.id]?.trim()
  return !!draft && !q.options.includes(draft)
}

function pickAnswer(q: PlanQuestion, opt: string) {
  localAnswers[q.id] = opt
  pillPicks[q.id] = opt
  if (drafts[q.id]) delete drafts[q.id]
  syncAnswers()
}

function onCustomAnswerInput(q: PlanQuestion, e: Event) {
  const text = (e.target as HTMLInputElement).value
  drafts[q.id] = text
  const trimmed = text.trim()
  if (trimmed) {
    localAnswers[q.id] = trimmed
  } else if (pillPicks[q.id]) {
    localAnswers[q.id] = pillPicks[q.id]
  } else {
    delete localAnswers[q.id]
  }
  syncAnswers()
}

function customPlaceholder(q: PlanQuestion): string {
  return isArtifactModeQuestion(q)
    ? '或描述你的需求，例如「一个搜索框」'
    : '或输入其他答案'
}

const modeQuestion = computed(() => questions.value.find(isArtifactModeQuestion))

/** ambiguous 且用户未作答时阻塞「开始生成」 */
const modeBlocked = computed(() => {
  const payload = plan.value
  if (!payload || isInfo.value || isIteration.value) return false
  if (payload.artifactMode === 'page' || payload.artifactMode === 'component') return false
  return !!modeQuestion.value && !localAnswers[modeQuestion.value.id]?.trim()
})

/** 类型问题的提示：已可确定时说明将按什么生成 */
const modeHint = computed(() => {
  const payload = plan.value
  if (!payload) return ''
  const explicit = localAnswers[ARTIFACT_MODE_QUESTION_ID]?.trim()
  const answer =
    explicit ??
    (payload.artifactMode === 'component'
      ? COMPONENT_OPTION
      : payload.artifactMode === 'page'
        ? PAGE_OPTION
        : '')
  if (!answer) return '请选择产物类型后开始'
  const mode =
    inferArtifactMode(answer) ??
    (payload.artifactMode === 'page' || payload.artifactMode === 'component'
      ? payload.artifactMode
      : undefined) ??
    'page'
  return `将按「${mode === 'component' ? COMPONENT_OPTION : PAGE_OPTION}」生成`
})

const answeredCount = computed(() => questions.value.filter((q) => !!answerFor(q)).length)
const allAnswered = computed(() => questions.value.every((q) => !!answerFor(q)))

/** 自定义风格优先于预设风格；两处都为空时交给 AI 自己决定 */
const effectiveStyle = computed<PlanStyle | null>(() => {
  const custom = styleDraft.value.trim()
  if (custom) {
    return {
      name: custom,
      desc: '自定义风格',
      directive: `【设计风格：${custom}】\n- 以用户描述为准，保持页面整体一致。`,
    }
  }
  return pickedStyle.value
})

/** 分页控制：一次只前进/后退一页 */
function goStep(i: number) {
  if (!interactive.value || !stepCount.value) return
  stepIndex.value = Math.max(0, Math.min(stepCount.value - 1, i))
}

function prevStep() {
  goStep(stepIndex.value - 1)
}

function nextStep() {
  goStep(stepIndex.value + 1)
}

const canSubmit = computed(
  () =>
    interactive.value &&
    !modeBlocked.value &&
    allAnswered.value &&
    !canvas.busy &&
    !starting.value &&
    !replanning.value,
)

const title = computed(() => {
  if (isInfo.value) return plan.value?.title ?? props.msg.content
  return isIteration.value ? '执行项确认' : '生成前确认'
})

const description = computed(() => {
  if (isInfo.value) return ''
  if (!interactive.value && isIteration.value) return '已按执行项生成新画板。'
  return plan.value?.title ?? props.msg.content
})

const statusTone = computed(() => {
  if (starting.value || replanning.value) return 'busy'
  if (isInfo.value) return 'info'
  if (interactive.value) return 'ask'
  return props.completed ? 'done' : 'info'
})

const statusIcon = computed(() => {
  if (starting.value || replanning.value) return 'refresh'
  if (isInfo.value) return 'sparkle'
  if (interactive.value) return 'help'
  return props.completed ? 'check' : 'help'
})

const statusSpin = computed(() => starting.value || replanning.value)

const bodyOpen = computed(() => isInfo.value || interactive.value || expanded.value)

const hasDetails = computed(
  () => (isIteration.value && items.value.length > 0) || (!isIteration.value && (questions.value.length > 0 || styles.value.length > 0)),
)

const completedLine = computed(() => {
  if (!plan.value || isInfo.value || interactive.value || !props.completed) return ''
  return isIteration.value ? '已按拆解执行。' : '已确认生成。'
})

const summaryRows = computed(() => {
  const rows = questions.value.map((q) => ({
    label: q.q,
    value: answerFor(q) || '未回答',
  }))
  if (styles.value.length) {
    rows.push({
      label: '风格方向',
      value: effectiveStyle.value?.name || '未选择，由 AI 决定',
    })
  }
  return rows
})

const primaryLabel = computed(() => {
  if (starting.value) return '生成中…'
  if (isIteration.value) return '按拆解执行'
  if (!stepCount.value || isLastStep.value) return '确认并生成'
  return '下一步'
})

const primaryIcon = computed(() => {
  if (starting.value) return 'refresh'
  if (isIteration.value || !stepCount.value || isLastStep.value) return 'sparkle'
  return 'arrow-right'
})

const primaryDisabled = computed(() => {
  if (starting.value || replanning.value || canvas.busy) return true
  if (!stepCount.value || isLastStep.value || isIteration.value) return !canSubmit.value
  const q = currentQuestion.value
  return !q || !answerFor(q)
})

function onPrimary() {
  if (primaryDisabled.value) return
  if (!stepCount.value || isIteration.value || isLastStep.value) {
    void submitPlan()
    return
  }
  nextStep()
}

function pickStyle(s: PlanStyle) {
  if (pickedStyle.value?.name === s.name && !styleDraft.value.trim()) {
    pickedStyle.value = null
  } else {
    pickedStyle.value = s
    styleDraft.value = ''
  }
  syncStyle()
}

function onStyleInput(e: Event) {
  styleDraft.value = (e.target as HTMLInputElement).value
  if (styleDraft.value.trim()) pickedStyle.value = null
  syncStyle()
}

function toggleExpanded() {
  expanded.value = !expanded.value
}

function findOriginalPrompt(): string {
  const idx = ws.messages.findIndex((m) => m.id === props.msg.id)
  for (let i = idx - 1; i >= 0; i--) {
    if (ws.messages[i].role === 'user') {
      // promptText 是实际发给模型的完整提示词（含附件拼入的正文），优先于展示文案
      const origin = ws.messages[i]
      return origin.promptText || origin.content || ''
    }
  }
  return ''
}

async function onReplan() {
  const payload = plan.value
  if (!payload || !props.msg.artboardId || replanning.value || canvas.busy) return
  replanning.value = true
  try {
    await replan(props.msg.artboardId, props.msg.id, findOriginalPrompt())
  } finally {
    replanning.value = false
  }
}

async function submitPlan() {
  const payload = plan.value
  if (!payload || !props.msg.artboardId || !canSubmit.value) return
  starting.value = true
  try {
    await startFromPlan({
      boardId: props.msg.artboardId,
      originalPrompt: findOriginalPrompt(),
      plan: payload,
      answers: { ...localAnswers },
      style: effectiveStyle.value,
    })
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section
    class="plan-card"
    :class="{
      done: !interactive && !isInfo,
      info: isInfo,
      docked: interactive,
    }"
  >
    <header class="plan-head">
      <span class="plan-status" :class="statusTone">
        <AppIcon :name="statusIcon" :size="13" :class="{ 'plan-spin': statusSpin }" />
      </span>
      <div class="plan-head-text">
        <p class="plan-title">{{ title }}</p>
        <p v-if="description" class="plan-desc">{{ description }}</p>
      </div>
      <button
        v-if="interactive && !isIteration"
        class="plan-icon-btn"
        :disabled="replanning || canvas.busy"
        :title="replanning ? '正在重新规划' : '换一批问题和风格'"
        @click="onReplan"
      >
        <AppIcon name="refresh" :size="12" :class="{ 'plan-spin': replanning }" />
      </button>
      <button
        v-if="!isInfo && !interactive && hasDetails"
        class="plan-icon-btn"
        :title="expanded ? '收起确认内容' : '展开确认内容'"
        @click="toggleExpanded"
      >
        <AppIcon name="chevron" :size="12" :class="{ 'chev-down': expanded }" />
      </button>
    </header>

    <div
      v-show="bodyOpen"
      class="plan-body"
      :class="{ readonly: !interactive && !isInfo, locked: starting || replanning }"
    >
      <template v-if="isInfo">
        <ol v-if="items.length" class="plan-item-list">
          <li v-for="(item, i) in items" :key="'i' + i" class="plan-item">
            <span class="plan-item-no">{{ i + 1 }}</span>
            <span>{{ item }}</span>
          </li>
        </ol>
        <div v-for="s in styles" :key="s.name" class="plan-info-style">
          <b>{{ s.name }}</b>
          <small>{{ s.desc }}</small>
        </div>
      </template>

      <template v-else-if="!interactive">
        <ol v-if="isIteration && items.length" class="plan-item-list">
          <li v-for="(item, i) in items" :key="'i' + i" class="plan-item">
            <span class="plan-item-no">{{ i + 1 }}</span>
            <span>{{ item }}</span>
          </li>
        </ol>
        <div v-else class="plan-summary">
          <div v-for="(row, i) in summaryRows" :key="i" class="plan-summary-row">
            <span class="plan-summary-q">{{ row.label }}</span>
            <span class="plan-summary-a">{{ row.value }}</span>
          </div>
        </div>
      </template>

      <template v-else>
        <template v-if="isIteration">
          <ol v-if="items.length" class="plan-item-list">
            <li v-for="(item, i) in items" :key="'i' + i" class="plan-item">
              <span class="plan-item-no">{{ i + 1 }}</span>
              <span>{{ item }}</span>
            </li>
          </ol>
        </template>

        <template v-else>
          <div v-if="currentStep" :key="stepIndex" class="plan-step-pane">
            <section v-if="currentQuestion" class="plan-q-block">
              <p class="plan-question">{{ currentQuestion.q }}</p>
              <div class="plan-choices">
                <button
                  v-for="opt in currentQuestion.options"
                  :key="opt"
                  class="plan-choice"
                  :class="{ picked: answerFor(currentQuestion) === opt }"
                  @click="pickAnswer(currentQuestion, opt)"
                >
                  <span class="plan-radio" />
                  <span class="plan-choice-label">{{ opt }}</span>
                </button>
              </div>
              <input
                class="plan-custom-input"
                :class="{ filled: isCustomAnswer(currentQuestion) }"
                :value="draftOf(currentQuestion)"
                :placeholder="customPlaceholder(currentQuestion)"
                @input="onCustomAnswerInput(currentQuestion, $event)"
              />
              <p
                v-if="isArtifactModeQuestion(currentQuestion)"
                class="plan-hint"
                :class="{ warn: modeBlocked }"
              >
                {{ modeHint }}
              </p>
            </section>

            <section v-else-if="isStyleStep" class="plan-q-block">
              <p class="plan-question">
                选择风格方向
                <span class="plan-optional">可选</span>
              </p>
              <div class="plan-choices">
                <button
                  v-for="s in styles"
                  :key="s.name"
                  class="plan-choice"
                  :class="{ picked: pickedStyle?.name === s.name && !styleDraft.trim() }"
                  @click="pickStyle(s)"
                >
                  <span class="plan-radio" />
                  <span class="plan-choice-text">
                    <b>{{ s.name }}</b>
                    <small>{{ s.desc }}</small>
                  </span>
                </button>
              </div>
              <input
                class="plan-custom-input"
                :class="{ filled: !!styleDraft.trim() }"
                :value="styleDraft"
                placeholder="或描述你想要的风格"
                @input="onStyleInput"
              />
              <p class="plan-hint">不选也可以直接生成，AI 会按需求决定。</p>
            </section>
          </div>
        </template>
      </template>
    </div>

    <footer v-if="interactive" class="plan-actions">
      <span class="flex1" />
      <button
        v-if="stepIndex > 0"
        class="plan-btn"
        :disabled="starting || replanning || canvas.busy"
        @click="prevStep"
      >
        <AppIcon name="arrow-left" :size="11" />
        上一页
      </button>
      <button class="plan-btn primary" :disabled="primaryDisabled" @click="onPrimary">
        <AppIcon
          :name="primaryIcon"
          :size="12"
          :class="{ 'plan-spin': starting }"
        />
        {{ primaryLabel }}
      </button>
    </footer>
    <div v-else-if="completedLine" class="plan-result">
      <AppIcon name="check" :size="11" />
      {{ completedLine }}
    </div>
  </section>
</template>

<style scoped>
.plan-card {
  width: 100%;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-l);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
  overflow: hidden;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.plan-card.info {
  background:
    linear-gradient(180deg, rgba(22, 119, 255, 0.055), transparent 64%),
    var(--bg-elevated);
}
.plan-card.done {
  background: transparent;
  border-color: transparent;
  box-shadow: none;
}
.plan-card.docked {
  border-radius: 14px;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.03),
    0 12px 30px rgba(0, 0, 0, 0.32);
}
.plan-card.docked .plan-body {
  max-height: min(38vh, 380px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.plan-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 11px 11px 9px;
}
.plan-card.done .plan-head {
  padding: 7px 8px 6px;
}
.plan-status {
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  margin-top: -1px;
  background: var(--bg-raised);
  color: var(--ink-2);
  box-shadow: inset 0 0 0 1px var(--line);
}
.plan-status.ask,
.plan-status.busy {
  background: var(--accent-soft);
  color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.34);
}
.plan-status.done {
  background: rgba(82, 196, 26, 0.1);
  color: #73d13d;
  box-shadow: inset 0 0 0 1px rgba(82, 196, 26, 0.22);
}
.plan-status.info {
  background: var(--bg-raised);
  color: var(--ink-2);
}
.plan-head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 1px;
}
.plan-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--ink);
  font-family: var(--display);
}
.plan-card.done .plan-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--ink-2);
}
.plan-desc {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-3);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.plan-icon-btn {
  flex: none;
  width: 21px;
  height: 21px;
  margin-top: -1px;
  display: grid;
  place-items: center;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}
.plan-icon-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--active);
}
.plan-icon-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.plan-icon-btn .chev-down {
  transform: rotate(90deg);
}
.plan-body {
  padding: 0 11px 11px;
}
.plan-body.readonly {
  padding-bottom: 10px;
}
.plan-body.locked {
  pointer-events: none;
}
.plan-step-pane {
  display: flex;
  flex-direction: column;
  animation: plan-step-in var(--dur) var(--ease);
}
.plan-q-block + .plan-q-block {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line);
}
.plan-item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.plan-item {
  display: flex;
  gap: 7px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-2);
}
.plan-item-no {
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: var(--hover);
  color: var(--ink-3);
  font-family: var(--mono);
  font-size: 9px;
  line-height: 1;
}
.plan-info-style {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin-top: 7px;
  padding-top: 7px;
  border-top: 1px solid var(--line);
  min-width: 0;
}
.plan-info-style b {
  flex: none;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--ink-2);
}
.plan-info-style small {
  min-width: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ink-3);
}
.plan-summary {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.plan-summary-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.plan-summary-q {
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--ink-3);
}
.plan-summary-a {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-2);
  word-break: break-word;
}
.plan-question {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--ink);
}
.plan-optional {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--ink-3);
  font-size: 9.5px;
  font-weight: 400;
  font-family: var(--mono);
  letter-spacing: 0.04em;
  vertical-align: 1px;
}
.plan-choices {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.plan-choice {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-2);
  text-align: left;
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}
.plan-choice:hover {
  border-color: var(--line-strong);
  background: var(--hover);
  color: var(--ink);
}
.plan-choice.picked {
  border-color: rgba(22, 119, 255, 0.5);
  background: var(--accent-soft);
  color: var(--ink);
}
.plan-radio {
  flex: none;
  position: relative;
  width: 12px;
  height: 12px;
  margin-top: 1px;
  border: 1.5px solid var(--line-strong);
  border-radius: 50%;
  transition: all var(--dur-fast) var(--ease);
}
.plan-choice.picked .plan-radio {
  border-color: var(--accent);
  background: var(--accent);
}
.plan-choice.picked .plan-radio::after {
  content: '';
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: #fff;
}
.plan-choice-label {
  min-width: 0;
  font-weight: 500;
}
.plan-choice-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.plan-choice-text b {
  font-size: 12px;
  font-weight: 500;
}
.plan-choice-text small {
  font-size: 10.5px;
  line-height: 1.45;
  color: var(--ink-3);
}
.plan-choice.picked .plan-choice-text small {
  color: var(--ink-2);
}
.plan-custom-input {
  width: 100%;
  height: 29px;
  margin-top: 7px;
  padding: 0 9px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink);
  font-family: var(--sans);
  font-size: 12px;
  outline: none;
  transition:
    border-color var(--dur-fast) var(--ease),
    background var(--dur-fast) var(--ease);
}
.plan-custom-input::placeholder {
  color: var(--ink-3);
}
.plan-custom-input:hover {
  border-color: var(--ink-3);
}
.plan-custom-input:focus {
  border-style: solid;
  border-color: var(--accent);
  background: var(--bg-raised);
}
.plan-custom-input.filled {
  border-style: solid;
  border-color: rgba(22, 119, 255, 0.45);
  background: var(--accent-soft);
}
.plan-hint {
  margin: 6px 0 0;
  font-family: var(--mono);
  font-size: 10px;
  line-height: 1.5;
  letter-spacing: 0.02em;
  color: var(--ink-3);
}
.plan-hint.warn {
  color: var(--spark);
}
.plan-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.012);
}
.plan-actions .flex1 {
  flex: 1;
}
.plan-btn {
  flex: none;
  height: 27px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-2);
  font-family: var(--sans);
  font-size: 11.5px;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}
.plan-btn:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--hover);
  color: var(--ink);
}
.plan-btn.primary {
  padding: 0 12px;
  border-color: transparent;
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
  font-weight: 500;
}
.plan-btn.primary:hover:not(:disabled) {
  filter: brightness(1.08);
  border-color: transparent;
  color: #fff;
}
.plan-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.plan-result {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px 8px 37px;
  color: var(--ink-3);
  font-size: 10.5px;
  line-height: 1.4;
}
.plan-result svg {
  color: #73d13d;
}
.plan-spin {
  animation: plan-spin 0.9s linear infinite;
}
@keyframes plan-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes plan-step-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
