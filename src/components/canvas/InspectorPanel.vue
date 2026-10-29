<script setup lang="ts">
/**
 * 检查器：编辑模式下选中元素的样式面板。修改先写入 canvas.edits（iframe 内实时预览），
 * 点「保存为新版本」时由 commitManualEdits 批量落到源 HTML。
 */
import { computed } from 'vue'
import { message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useWorkspaceStore } from '@/stores/workspace'
import { commitManualEdits } from '@/services/orchestrator'
import AppIcon from '@/components/ui/AppIcon.vue'

const canvas = useCanvasStore()
const ws = useWorkspaceStore()

const sel = computed(() => canvas.inspect)
const meta = computed(() => sel.value?.meta ?? null)
const editable = computed(() => !!meta.value?.dcId)
const onLiveBoard = computed(() => ws.findArtboard(sel.value?.artboardId ?? null)?.kind === 'live')
const edit = computed(() =>
  sel.value && meta.value?.dcId ? canvas.edits[sel.value.artboardId]?.[meta.value.dcId] : undefined,
)
const pending = computed(() => (sel.value ? canvas.editCount(sel.value.artboardId) : 0))

const title = computed(() => {
  const m = meta.value
  if (!m) return ''
  return m.tag + (m.classes.length ? '.' + m.classes.slice(0, 2).join('.') : '')
})
const size = computed(() => {
  const r = meta.value?.rect
  return r ? `${Math.round(r.width)} × ${Math.round(r.height)}` : ''
})

/**
 * @description 字段当前值：用户改过的值优先（保持输入原样），否则用计算样式。
 * @param prop - CSS 属性名
 * @returns 属性值字符串
 */
function valueOf(prop: string): string {
  return edit.value?.styles[prop] || meta.value?.styles[prop] || ''
}

/**
 * @description 写入一处样式修改（iframe 内即时预览，保存前不落盘）。
 * @param prop - CSS 属性名
 * @param value - 新值；空字符串表示移除该内联样式
 */
function setStyle(prop: string, value: string) {
  if (!sel.value || !meta.value?.dcId) return
  canvas.setEdit(sel.value.artboardId, meta.value.dcId, { styles: { [prop]: value } })
}

/**
 * @description 读取 px 类属性的数值（如 "24px" → 24），无法解析时为空。
 * @param prop - CSS 属性名
 * @returns 数值，或空字符串（让输入框显示为空）
 */
function numOf(prop: string): number | '' {
  const n = parseFloat(valueOf(prop))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : ''
}

/**
 * @description 数值输入框提交（回车 / 失焦 / 方向键步进）：写成带单位的样式值，清空则移除。
 * @param prop - CSS 属性名
 * @param e - change 事件
 * @param unit - 单位，默认 px
 */
function onNum(prop: string, e: Event, unit = 'px') {
  const raw = (e.target as HTMLInputElement).value.trim()
  setStyle(prop, raw === '' ? '' : `${raw}${unit}`)
}

/**
 * @description 原样提交文本类样式值（行高可写 1.5 或 24px）。
 * @param prop - CSS 属性名
 * @param e - change 事件
 */
function onRaw(prop: string, e: Event) {
  setStyle(prop, (e.target as HTMLInputElement).value.trim())
}

/**
 * @description 把计算样式的颜色转成 #rrggbb，供原生取色器使用。
 * @param css - rgb()/rgba()/#hex 颜色
 * @returns 十六进制颜色；完全透明或无法解析时为 null
 */
function toHex(css: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(css)) return css.toLowerCase()
  const m = css.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*([\d.]+))?/i)
  if (!m || (m[4] !== undefined && parseFloat(m[4]) === 0)) return null
  return '#' + [m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')
}

/**
 * @description 颜色字段的展示文本：不透明色显示 hex，透明显示 transparent，其余原样。
 * @param prop - CSS 颜色属性名
 * @returns 展示文本
 */
function colorLabel(prop: string): string {
  const v = valueOf(prop)
  return toHex(v) ?? (/rgba?\([^)]*[,/]\s*0\s*\)/.test(v) ? 'transparent' : v)
}

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const ALIGNS = [
  { v: 'left', label: '左' },
  { v: 'center', label: '中' },
  { v: 'right', label: '右' },
  { v: 'justify', label: '两端' },
]
const align = computed(() => {
  const a = valueOf('text-align')
  return a === 'start' ? 'left' : a === 'end' ? 'right' : a
})
const SIDES = [
  { k: 'top', label: '上' },
  { k: 'right', label: '右' },
  { k: 'bottom', label: '下' },
  { k: 'left', label: '左' },
]
const opacity = computed(() => {
  const n = parseFloat(valueOf('opacity'))
  return Number.isFinite(n) ? Math.round(n * 100) : 100
})

function onText(e: Event) {
  if (!sel.value || !meta.value?.dcId) return
  canvas.setEdit(sel.value.artboardId, meta.value.dcId, { text: (e.target as HTMLTextAreaElement).value })
}

async function save() {
  if (!sel.value) return
  try {
    const v = await commitManualEdits(sel.value.artboardId)
    if (v) message.success('手动修改已保存为新版本')
  } catch (err) {
    message.error((err as Error).message)
  }
}

function discard() {
  if (sel.value) canvas.clearEdits(sel.value.artboardId)
}
</script>

<template>
  <aside v-if="meta" class="inspector" @pointerdown.stop @wheel.stop>
    <header class="in-head">
      <div class="in-title">
        <b :title="meta.selector">{{ title }}</b>
        <span>{{ size }}</span>
      </div>
      <button class="in-close" title="取消选中（Esc）" @click="canvas.clearInspect()">×</button>
    </header>

    <p v-if="!editable && onLiveBoard" class="in-note">
      实时页面只能查看与测量。先在头栏「捕获」为设计稿再手动编辑，或切到「点选反馈」让 Agent 直接改代码。
    </p>
    <p v-else-if="!editable" class="in-note">
      该元素由页面脚本在运行时生成，无法直接编辑。可切换到「点选反馈」让 AI 修改。
    </p>

    <div class="in-body" :class="{ readonly: !editable }">
      <section v-if="meta.text !== null" class="in-sec">
        <h4>文字</h4>
        <textarea
          class="in-text"
          rows="3"
          :value="edit?.text ?? meta.text"
          :disabled="!editable"
          @input="onText"
        />
      </section>

      <section class="in-sec">
        <h4>排版</h4>
        <div class="in-grid">
          <label class="in-field">
            <span>字号</span>
            <input type="number" min="0" :value="numOf('font-size')" :disabled="!editable" @change="onNum('font-size', $event)" />
          </label>
          <label class="in-field">
            <span>字重</span>
            <select :value="valueOf('font-weight')" :disabled="!editable" @change="onRaw('font-weight', $event)">
              <option v-for="w in WEIGHTS" :key="w" :value="String(w)">{{ w }}</option>
            </select>
          </label>
          <label class="in-field">
            <span>行高</span>
            <input type="text" :value="valueOf('line-height')" :disabled="!editable" @change="onRaw('line-height', $event)" />
          </label>
          <label class="in-field">
            <span>字距</span>
            <input type="number" step="0.1" :value="numOf('letter-spacing')" :disabled="!editable" @change="onNum('letter-spacing', $event)" />
          </label>
        </div>
        <div class="in-seg">
          <button
            v-for="a in ALIGNS"
            :key="a.v"
            :class="{ on: align === a.v }"
            :disabled="!editable"
            @click="setStyle('text-align', a.v)"
          >
            {{ a.label }}
          </button>
        </div>
        <label class="in-color">
          <span>文字色</span>
          <input type="color" :value="toHex(valueOf('color')) ?? '#000000'" :disabled="!editable" @input="onRaw('color', $event)" />
          <code>{{ colorLabel('color') }}</code>
        </label>
      </section>

      <section class="in-sec">
        <h4>填充</h4>
        <label class="in-color">
          <span>背景</span>
          <input
            type="color"
            :value="toHex(valueOf('background-color')) ?? '#ffffff'"
            :disabled="!editable"
            @input="onRaw('background-color', $event)"
          />
          <code>{{ colorLabel('background-color') }}</code>
          <button
            v-if="toHex(valueOf('background-color'))"
            class="in-mini"
            title="设为透明"
            :disabled="!editable"
            @click="setStyle('background-color', 'transparent')"
          >
            透明
          </button>
        </label>
      </section>

      <section class="in-sec">
        <h4>尺寸</h4>
        <div class="in-grid">
          <label class="in-field">
            <span>宽</span>
            <input type="number" min="0" :value="numOf('width')" :disabled="!editable" @change="onNum('width', $event)" />
          </label>
          <label class="in-field">
            <span>高</span>
            <input type="number" min="0" :value="numOf('height')" :disabled="!editable" @change="onNum('height', $event)" />
          </label>
          <label class="in-field">
            <span>圆角</span>
            <input type="number" min="0" :value="numOf('border-radius')" :disabled="!editable" @change="onNum('border-radius', $event)" />
          </label>
          <label class="in-field">
            <span>不透明</span>
            <input
              type="number"
              min="0"
              max="100"
              :value="opacity"
              :disabled="!editable"
              @change="setStyle('opacity', String(Number(($event.target as HTMLInputElement).value) / 100))"
            />
          </label>
          <label v-if="/flex|grid/.test(valueOf('display'))" class="in-field">
            <span>间隙</span>
            <input type="number" min="0" :value="numOf('gap')" :disabled="!editable" @change="onNum('gap', $event)" />
          </label>
        </div>
      </section>

      <section v-for="box in ['padding', 'margin']" :key="box" class="in-sec">
        <h4>{{ box === 'padding' ? '内边距' : '外边距' }}</h4>
        <div class="in-grid four">
          <label v-for="s in SIDES" :key="s.k" class="in-field">
            <span>{{ s.label }}</span>
            <input
              type="number"
              :min="box === 'padding' ? 0 : undefined"
              :value="numOf(`${box}-${s.k}`)"
              :disabled="!editable"
              @change="onNum(`${box}-${s.k}`, $event)"
            />
          </label>
        </div>
      </section>
    </div>

    <p class="in-tip"><AppIcon name="sparkle" :size="11" /> 双击文字直接改字 · 按住 Alt 悬停其它元素看间距</p>

    <footer v-if="pending" class="in-foot">
      <span>{{ pending }} 个元素有改动</span>
      <button class="in-btn" @click="discard">放弃</button>
      <button class="in-btn primary" @click="save">保存为新版本</button>
    </footer>
  </aside>
</template>

<style scoped>
.inspector {
  position: absolute;
  top: 12px;
  right: 12px;
  bottom: 68px;
  width: 268px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  background: rgba(22, 22, 22, 0.94);
  backdrop-filter: blur(12px);
  border-radius: var(--radius-l);
  box-shadow: var(--shadow-float);
  color: var(--ink);
  font-size: 12px;
  animation: enter var(--dur) var(--ease);
}
.in-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px 14px;
  border-bottom: 1px solid var(--line);
}
.in-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.in-title b {
  font-family: var(--mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.in-title span {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
}
.in-close {
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-s);
  background: transparent;
  color: var(--ink-2);
  font-size: 16px;
  cursor: pointer;
}
.in-close:hover {
  background: var(--hover);
  color: var(--ink);
}
.in-note {
  margin: 10px 12px 0;
  padding: 8px 10px;
  border-radius: var(--radius-s);
  background: rgba(255, 107, 71, 0.1);
  color: var(--spark);
  line-height: 1.6;
}
.in-body {
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px 8px 14px;
}
.in-body.readonly {
  opacity: 0.6;
}
.in-sec {
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
}
.in-sec:last-child {
  border-bottom: none;
}
.in-sec h4 {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--ink-3);
  letter-spacing: 0.04em;
}
.in-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.in-grid.four {
  grid-template-columns: repeat(4, 1fr);
}
.in-field {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius-s);
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
}
.in-field:focus-within {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.in-field span {
  flex: none;
  color: var(--ink-3);
  font-size: 11px;
}
.in-field input,
.in-field select {
  flex: 1;
  min-width: 0;
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-family: var(--mono);
  font-size: 12px;
}
.in-field select option {
  background: var(--bg-elevated);
}
/* 去掉原生步进按钮（窄输入框里会挤掉数值），方向键步进仍然可用 */
.in-field input[type='number'] {
  appearance: textfield;
}
.in-field input[type='number']::-webkit-inner-spin-button,
.in-field input[type='number']::-webkit-outer-spin-button {
  appearance: none;
  margin: 0;
}
.in-grid.four .in-field {
  gap: 4px;
  padding: 0 6px;
}
.in-seg {
  display: flex;
  margin-top: 6px;
  padding: 2px;
  border-radius: var(--radius-s);
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
}
.in-seg button {
  flex: 1;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--ink-2);
  font-size: 11px;
  font-family: var(--sans);
  cursor: pointer;
}
.in-seg button.on {
  background: var(--active);
  color: var(--ink);
}
.in-color {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  height: 28px;
}
.in-color span {
  width: 40px;
  color: var(--ink-3);
  font-size: 11px;
}
.in-color input[type='color'] {
  width: 26px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}
.in-color code {
  flex: 1;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.in-mini {
  border: none;
  border-radius: 4px;
  padding: 2px 6px;
  background: var(--bg-raised);
  color: var(--ink-2);
  font-size: 11px;
  cursor: pointer;
}
.in-text {
  width: 100%;
  resize: vertical;
  border: none;
  outline: none;
  padding: 8px;
  border-radius: var(--radius-s);
  background: var(--bg-raised);
  box-shadow: var(--hairline-inset);
  color: var(--ink);
  font-family: var(--sans);
  font-size: 12px;
  line-height: 1.6;
}
.in-text:focus {
  box-shadow: inset 0 0 0 1px var(--accent);
}
.in-tip {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 0;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
  color: var(--ink-3);
  font-size: 11px;
}
.in-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}
.in-foot span {
  flex: 1;
  color: var(--accent);
  font-size: 11px;
}
.in-btn {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-s);
  background: var(--btn-quiet-bg);
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
  font-size: 12px;
  font-family: var(--sans);
  cursor: pointer;
}
.in-btn:hover {
  color: var(--ink);
}
.in-btn.primary {
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  color: #fff;
}
</style>
