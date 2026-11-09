<script setup lang="ts">
/**
 * 项目级品牌契约编辑器：调色板 → --brand-* 变量、字体、圆角/间距基准、自定义硬规则。
 * 保存后跟随项目落盘；之后本项目所有生成（原型新建 / 增量迭代 / 本机 Agent 改代码）
 * 都会被强制遵守，导出可拿到与生成约束逐字一致的 tokens.css。
 */
import { computed, ref, watch } from 'vue'
import { Button, Input, Modal, message } from 'antdv-next'
import { useWorkspaceStore } from '@/stores/workspace'
import type { BrandContract } from '@/types'
import {
  contractPrompt,
  defaultBrandContract,
  sanitizeToken,
  TOKEN_PREFIX,
  tokensCSS,
} from '@/utils/brandContract'
import { downloadText } from '@/utils/exportProject'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const ws = useWorkspaceStore()

/** 编辑态草稿 + 当前项目是否已有契约（决定「停用」按钮显隐） */
const draft = ref<BrandContract>(defaultBrandContract())
const existed = ref(false)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    const current = ws.currentProject?.brandContract
    existed.value = Boolean(current)
    // 深拷贝落库对象，避免编辑动作直接改到 store
    draft.value = current ? (JSON.parse(JSON.stringify(current)) as BrandContract) : defaultBrandContract()
  },
)

/** 空白 token 建议序列：常用 token 名轮着填，已存在的跳过 */
const TOKEN_SUGGESTIONS = ['primary', 'accent', 'bg', 'surface', 'text', 'muted', 'border', 'primary-contrast']
function addSwatch() {
  const taken = new Set(draft.value.palette.map((p) => sanitizeToken(p.token)))
  const next = TOKEN_SUGGESTIONS.find((t) => !taken.has(t)) ?? `token-${draft.value.palette.length + 1}`
  draft.value.palette.push({ token: next, color: '#2F5D50' })
}

/** 规范化草稿：token 清洗、去空行 —— 预览与保存共用同一函数，所见即所得 */
function cleaned(): BrandContract {
  const d = draft.value
  return {
    voice: d.voice.trim(),
    palette: d.palette
      .map((p) => ({ token: sanitizeToken(p.token), color: p.color.trim() }))
      .filter((p) => p.token),
    fontDisplay: d.fontDisplay.trim(),
    fontBody: d.fontBody.trim(),
    radius: d.radius.trim(),
    spacing: d.spacing.trim(),
    rules: d.rules.trim(),
  }
}

const cssPreview = computed(() => tokensCSS(cleaned(), ws.currentProject?.name || 'project'))
const promptPreview = computed(() => contractPrompt(cleaned()))

async function save() {
  const c = cleaned()
  if (!contractPrompt(c)) {
    message.warning('还没有填写任何内容：至少填好一种颜色或调性，契约才会启用')
    return
  }
  await ws.setBrandContract(c)
  message.success('品牌契约已保存：本项目之后的生成都会遵守')
  emit('update:open', false)
}

async function disable() {
  await ws.setBrandContract(null)
  message.success('已停用品牌契约，生成恢复不受约束')
  emit('update:open', false)
}

function copyCss() {
  if (!cssPreview.value) return
  void navigator.clipboard.writeText(cssPreview.value)
  message.success('已复制 tokens.css')
}

function downloadCss() {
  if (!cssPreview.value) return
  const safe = (ws.currentProject?.name || 'project').replace(/[\\/:*?"<>|]/g, '_')
  downloadText(`${safe}-tokens.css`, cssPreview.value)
  message.success('已导出 tokens.css')
}
</script>

<template>
  <Modal :open="open" title="品牌契约" width="660px" :footer="null" @cancel="emit('update:open', false)">
    <div class="contract-form">
      <p class="hint">
        项目级设计 token（DESIGN.md 思路）：启用后，本项目所有「生成 / 迭代 / Agent 改代码」都被强制遵守，
        保证多块画板之间的色彩、字体与圆角一致。
      </p>

      <label class="field">
        <span>品牌调性（一句话，拼进每次生成）</span>
        <Input v-model:value="draft.voice" placeholder="如：克制、纸感、像老派数据杂志" />
      </label>

      <div class="field">
        <span>核心调色板（每个颜色 → 一个 CSS 变量）</span>
        <div class="palette-list">
          <div v-for="(row, i) in draft.palette" :key="i" class="palette-row">
            <input v-model="row.color" type="color" class="swatch" />
            <Input v-model:value="row.token" placeholder="变量名，如 primary" class="token-input" />
            <code class="var-name mono">{{ TOKEN_PREFIX }}{{ sanitizeToken(row.token) || '…' }}</code>
            <button type="button" class="row-del" title="删除该颜色" @click="draft.palette.splice(i, 1)">
              <AppIcon name="trash" :size="13" />
            </button>
          </div>
          <Button size="small" dashed @click="addSwatch"><AppIcon name="plus" :size="12" /> 添加颜色</Button>
        </div>
      </div>

      <div class="grid2">
        <label class="field">
          <span>标题字体（Google Fonts 字族或字体栈）</span>
          <Input v-model:value="draft.fontDisplay" placeholder="如 Fraunces；留空不约束" />
        </label>
        <label class="field">
          <span>正文字体</span>
          <Input v-model:value="draft.fontBody" placeholder="如 Inter；留空不约束" />
        </label>
        <label class="field">
          <span>统一圆角</span>
          <Input v-model:value="draft.radius" placeholder="如 12px；留空不约束" />
        </label>
        <label class="field">
          <span>间距基准（取其整数倍）</span>
          <Input v-model:value="draft.spacing" placeholder="如 8px；留空不约束" />
        </label>
      </div>

      <label class="field">
        <span>自定义硬规则（每行一条，会原样拼进提示词）</span>
        <textarea
          v-model="draft.rules"
          class="rules-input"
          rows="3"
          placeholder="强调色面积 &lt; 5%，只用于主按钮与关键数据；不使用大面积渐变背景…"
        ></textarea>
      </label>

      <details class="prompt-peep" :title="promptPreview">
        <summary>生成时下发的契约约束（生成的 system prompt 会包含这段）</summary>
        <pre class="mono preview">{{ promptPreview || '（还没有有效内容）' }}</pre>
      </details>

      <div class="field">
        <span>tokens.css（与上面约束逐字一致，可直接进真实仓库）</span>
        <pre class="mono preview">{{ cssPreview || '（还没有有效 token）' }}</pre>
      </div>

      <div class="footer">
        <Button v-if="existed" size="small" danger @click="disable">停用契约</Button>
        <span class="flex1" />
        <Button size="small" :disabled="!cssPreview" @click="copyCss">复制</Button>
        <Button size="small" :disabled="!cssPreview" @click="downloadCss">下载 tokens.css</Button>
        <Button size="small" type="primary" @click="save">保存</Button>
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.contract-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.hint {
  color: var(--muted, #888);
  font-size: 12px;
  line-height: 1.6;
  margin: 0;
}

.field {
  display: block;
}

.field > span {
  display: block;
  font-size: 12px;
  color: var(--muted, #888);
  margin-bottom: 6px;
}

.palette-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.palette-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.swatch {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 6px;
  background: none;
  cursor: pointer;
}

.token-input {
  width: 160px;
}

.var-name {
  flex: 1;
  font-size: 11px;
  color: var(--muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-del {
  border: none;
  background: none;
  color: var(--muted, #999);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
}

.row-del:hover {
  color: #d4380d;
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 14px;
}

.rules-input {
  width: 100%;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  border-radius: 8px;
  background: none;
  color: inherit;
}

.rules-input:focus {
  outline: none;
  border-color: var(--primary, #2f5d50);
}

.prompt-peep summary {
  font-size: 12px;
  color: var(--muted, #888);
  cursor: pointer;
}

.preview {
  margin: 8px 0 0;
  padding: 10px 12px;
  font-size: 11px;
  line-height: 1.6;
  max-height: 180px;
  overflow: auto;
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  background: rgba(127, 127, 127, 0.06);
  white-space: pre;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.footer {
  display: flex;
  align-items: center;
  gap: 8px;
}

.flex1 {
  flex: 1;
}
</style>
