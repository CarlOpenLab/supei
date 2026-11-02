<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Button,
  Input,
  InputPassword,
  InputNumber,
  Modal,
  Select,
  Popconfirm,
  message,
} from 'antdv-next'
import { useSettingsStore } from '@/stores/settings'
import type { ProviderConfig, ProviderKind } from '@/types'
import { pluginRegistry, parsePluginFile } from '@/plugins/registry'
import type { DesignPlugin, PluginKind } from '@/plugins/types'
import { desktopAvailable, getDesktopBridge, IS_DESKTOP } from '@/services/desktop'
import { isAgentProvider, listModels } from '@/services/llm'
import type { AgentInfo } from '@/services/mygo-client'
import { uid } from '@/utils/id'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const settings = useSettingsStore()

const tab = ref<'model' | 'plugins'>('model')

// —— 模型设置 ——
const draft = ref<ProviderConfig[]>([])
const activeId = ref('')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    draft.value = settings.providers.map((p) => ({ ...p, kind: p.kind ?? 'openai' }))
    activeId.value = settings.activeId
    closeEditor()
    expandedId.value = draft.value.length === 1 ? draft.value[0].id : null
    if (desktopAvailable.value) void detectAgents()
  },
)

// —— 本机 Agent（仅桌面端）——
const AGENT_LABEL: Record<Exclude<ProviderKind, 'openai'>, { name: string; bin: string; modelHint: string }> = {
  'claude-code': { name: 'Claude Code', bin: 'claude', modelHint: '留空用 CLI 默认，如 sonnet / opus' },
  codex: { name: 'Codex', bin: 'codex', modelHint: '留空用 CLI 默认，如 gpt-5-codex' },
}
const providerKindOptions = computed(() => [
  { label: 'OpenAI 兼容接口', value: 'openai' },
  ...(desktopAvailable.value
    ? (Object.keys(AGENT_LABEL) as Array<keyof typeof AGENT_LABEL>).map((k) => ({
        label: `${AGENT_LABEL[k].name}（本机 Agent）`,
        value: k,
      }))
    : []),
])

function kindLabel(p: ProviderConfig): string {
  return isAgentProvider(p) ? AGENT_LABEL[p.kind].name : 'OpenAI 兼容'
}

/** 本机 Agent 探测结果；null = 尚未探测完成 */
const agents = ref<AgentInfo[] | null>(null)

/**
 * @description 探测本机已安装的 Agent CLI（claude / codex），用于在服务商卡片上显示是否可用及版本。
 * @returns 探测完成后写入 agents
 */
async function detectAgents(): Promise<void> {
  agents.value = null
  const bridge = await getDesktopBridge()
  if (!bridge) return
  agents.value = await bridge.Agent.detect()
}

/**
 * @description 选中 Agent 类型时补全默认名称，免去手填。
 * @param p - 正在编辑的服务商草稿
 */
function onKindChange(p: ProviderConfig) {
  if (isAgentProvider(p) && !p.name.trim()) p.name = AGENT_LABEL[p.kind].name
}

function save() {
  const valid = draft.value.filter(
    (p) => p.name.trim() && (isAgentProvider(p) || (p.baseURL.trim() && p.model.trim())),
  )
  if (valid.length !== draft.value.length) {
    message.warning('存在未填写完整的服务商（OpenAI 兼容接口需要名称、baseURL、模型名），已自动忽略')
  }
  settings.providers = valid
  settings.activeId = valid.some((p) => p.id === activeId.value) ? activeId.value : ''
  settings.save()
  message.success('设置已保存')
  emit('update:open', false)
}

const defaultOptions = ref<Array<{ label: string; value: string }>>([])
watch(
  [draft, activeId],
  () => {
    defaultOptions.value = draft.value
      .filter((p) => p.name.trim())
      .map((p) => ({ label: p.name, value: p.id }))
  },
  { deep: true },
)

// —— 服务商手风琴：收起时一行摘要，展开才是完整表单 ——
const expandedId = ref<string | null>(null)

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id
}

function addProvider() {
  const p: ProviderConfig = { id: uid('prov'), kind: 'openai', name: '', baseURL: '', apiKey: '', model: '' }
  draft.value.push(p)
  expandedId.value = p.id
}

// —— 快捷预设：一键填好常用服务商 / 本地网关，字段仍可随意改 ——
const PROVIDER_PRESETS: Array<{ label: string; name: string; baseURL: string; model: string }> = [
  { label: '智谱 GLM', name: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7' },
  { label: 'DeepSeek', name: 'DeepSeek', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o' },
  // Magpie（github.com/yetone/magpie）本地网关默认监听 127.0.0.1:3425，OpenAI 协议走 /v1，通常无需 Key
  { label: 'Magpie 本地网关', name: 'Magpie 本地网关', baseURL: 'http://127.0.0.1:3425/v1', model: '' },
]

function addPreset(preset: (typeof PROVIDER_PRESETS)[number]) {
  const p: ProviderConfig = {
    id: uid('prov'),
    kind: 'openai',
    name: preset.name,
    baseURL: preset.baseURL,
    apiKey: '',
    model: preset.model,
  }
  draft.value.push(p)
  expandedId.value = p.id
}

// —— 模型列表：从网关拉取真实模型 ID，点选填入（仍可手动输入任意模型名）——
const modelChoices = ref<Record<string, string[]>>({})
const fetchingModels = ref<Record<string, boolean>>({})

async function fetchModels(p: ProviderConfig) {
  if (!p.baseURL.trim()) {
    message.warning('先填 Base URL 再获取模型列表')
    return
  }
  fetchingModels.value[p.id] = true
  try {
    const list = await listModels(p.baseURL.trim(), p.apiKey.trim())
    if (!list.length) {
      message.warning('网关返回了空列表，请手动填写模型名')
      return
    }
    modelChoices.value[p.id] = list
    message.success(`获取到 ${list.length} 个模型，点击即可选用`)
  } catch (err) {
    message.error(`获取失败：${(err as Error).message}`)
  } finally {
    fetchingModels.value[p.id] = false
  }
}

function removeProvider(id: string) {
  draft.value = draft.value.filter((p) => p.id !== id)
  if (activeId.value === id) activeId.value = ''
  if (expandedId.value === id) expandedId.value = null
}

// —— 插件库 ——
const KIND_LABEL: Record<PluginKind, string> = {
  style: '设计风格',
  preset: '需求预设',
  template: '画板模板',
  icon: '图标集',
}

const plugins = computed(() => pluginRegistry.list())

const grouped = computed(() => {
  const groups: Array<{ kind: PluginKind; label: string; items: DesignPlugin[] }> = []
  for (const kind of ['style', 'preset', 'template', 'icon'] as PluginKind[]) {
    const items = plugins.value.filter((p) => p.kind === kind)
    if (items.length) groups.push({ kind, label: KIND_LABEL[kind], items })
  }
  return groups
})

const editing = ref<null | {
  id: string | null
  kind: PluginKind
  name: string
  prompt: string
  width: number
  height: number
}>(null)

function openCreate(kind: PluginKind) {
  editing.value = {
    id: null,
    kind,
    name: '',
    prompt: '',
    width: kind === 'template' ? 1280 : 0,
    height: kind === 'template' ? 800 : 0,
  }
}

function openEdit(p: DesignPlugin) {
  editing.value = {
    id: p.id,
    kind: p.kind,
    name: p.name,
    prompt: p.kind === 'style' ? (p.data as { prompt: string }).prompt : '',
    width: p.kind === 'template' ? (p.data as { width: number }).width : 0,
    height: p.kind === 'template' ? (p.data as { height: number }).height : 0,
  }
}

function closeEditor() {
  editing.value = null
}

function savePlugin() {
  const e = editing.value
  if (!e) return
  if (!e.name.trim()) {
    message.warning('名称不能为空')
    return
  }
  if (pluginRegistry.list().some((p) => p.name === e.name.trim() && p.id !== e.id)) {
    message.warning('已存在同名插件，换一个名字')
    return
  }
  if (e.id) {
    if (e.kind === 'style') pluginRegistry.updateUserPlugin(e.id, { name: e.name, data: { prompt: e.prompt } })
    if (e.kind === 'preset') pluginRegistry.updateUserPlugin(e.id, { name: e.name })
    if (e.kind === 'template')
      pluginRegistry.updateUserPlugin(e.id, { name: e.name, data: { width: e.width, height: e.height } })
    message.success('插件已更新')
  } else {
    if (e.kind === 'style') pluginRegistry.addUserPlugin({ kind: 'style', name: e.name, data: { prompt: e.prompt } })
    if (e.kind === 'preset')
      pluginRegistry.addUserPlugin({ kind: 'preset', name: e.name, data: { icon: 'sparkle', prompt: e.prompt } })
    if (e.kind === 'template')
      pluginRegistry.addUserPlugin({ kind: 'template', name: e.name, data: { width: e.width, height: e.height } })
    message.success('插件已创建')
  }
  closeEditor()
}

function duplicate(p: DesignPlugin) {
  let base = `${p.name} 副本`
  let n = 2
  while (pluginRegistry.list().some((x) => x.name === base)) base = `${p.name} 副本 ${n++}`
  pluginRegistry.addUserPlugin({
    kind: p.kind,
    name: base,
    description: p.description,
    data: JSON.parse(JSON.stringify(p.data)),
  })
  message.success(`已复制为「${base}」`)
}

function toggle(p: DesignPlugin) {
  pluginRegistry.toggleEnabled(p.id)
}

function previewText(p: DesignPlugin): string {
  if (p.kind === 'style') return (p.data as { prompt: string }).prompt.split('\n').find((l) => l.trim()) ?? ''
  if (p.kind === 'preset') return (p.data as { prompt: string }).prompt.slice(0, 60)
  if (p.kind === 'template') {
    const d = p.data as { width: number; height: number }
    return `${d.width} × ${d.height}`
  }
  return p.description ?? '图标集'
}

function exportPlugin(p: DesignPlugin) {
  const manifest = {
    format: 'mygo-design-plugin',
    name: p.name,
    plugins: [{ kind: p.kind, name: p.name, description: p.description, ...(p.data as Record<string, unknown>) }],
  }
  download(`${p.name}.json`, JSON.stringify(manifest, null, 2))
  message.success('已导出插件包')
}

function exportAll() {
  const user = plugins.value.filter((p) => p.source === 'user')
  if (!user.length) {
    message.warning('还没有自定义插件可导出')
    return
  }
  const manifest = {
    format: 'mygo-design-plugin',
    name: 'my-plugins',
    plugins: user.map((p) => ({ kind: p.kind, name: p.name, description: p.description, ...(p.data as Record<string, unknown>) })),
  }
  download('design-plugins.json', JSON.stringify(manifest, null, 2))
  message.success(`已导出 ${user.length} 个插件`)
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

async function onImportFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (!files.length) return
  await applyImport(
    await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))),
  )
}

/** 桌面壳：重新读取插件目录（~/.config/ai-design-canvas/plugins） */
async function refreshFromDir() {
  const bridge = await getDesktopBridge()
  if (!bridge) return
  const files = await bridge.Storage.readPluginDir()
  if (!files?.length) {
    message.info('插件目录为空：把 .md / .json 插件包放进去后点刷新')
    return
  }
  await applyImport(files.map((f) => ({ name: f.name, text: f.content })))
}

async function importViaDesktop() {
  const bridge = await getDesktopBridge()
  if (!bridge) return
  const files = await bridge.Storage.readStyleFiles()
  if (!files?.length) return
  await applyImport(files.map((f) => ({ name: f.name, text: f.content })))
}

async function applyImport(entries: Array<{ name: string; text: string }>) {
  let added = 0
  let skipped = 0
  const errors: string[] = []
  for (const f of entries) {
    try {
      const parsed = parsePluginFile(f.text, f.name)
      for (const entry of parsed) {
        if (pluginRegistry.list().some((p) => p.name === entry.name)) {
          skipped++
          continue
        }
        pluginRegistry.addUserPlugin({ kind: entry.kind, name: entry.name, data: entry.data })
        added++
      }
    } catch (err) {
      errors.push(`${f.name}: ${(err as Error).message}`)
    }
  }
  if (added) message.success(`导入 ${added} 个插件`)
  if (skipped) message.warning(`${skipped} 个因重名被跳过`)
  if (errors.length) message.error(errors[0])
}

const isEditing = computed(() => editing.value !== null)
const kindOptions = (['style', 'preset', 'template'] as PluginKind[]).map((k) => ({
  label: KIND_LABEL[k],
  value: k,
}))
</script>

<template>
  <Modal :open="props.open" title="设置" width="880px" @cancel="emit('update:open', false)">
    <template #footer>
      <template v-if="tab === 'model'">
        <Button @click="emit('update:open', false)">取消</Button>
        <Button type="primary" @click="save">保存</Button>
      </template>
      <template v-else>
        <Button @click="emit('update:open', false)">关闭</Button>
      </template>
    </template>

    <div class="settings-shell">
      <!-- 左侧分区导航 -->
      <nav class="settings-rail" aria-label="设置分区">
        <button
          type="button"
          class="rail-item"
          :class="{ on: tab === 'model' }"
          :aria-current="tab === 'model'"
          @click="tab = 'model'"
        >
          <AppIcon name="gear" :size="15" class="rail-icon" />
          <span class="rail-text">
            <b>模型与 Agent</b>
            <small>服务商 · 本机 CLI · 默认模型</small>
          </span>
        </button>
        <button
          type="button"
          class="rail-item"
          :class="{ on: tab === 'plugins' }"
          :aria-current="tab === 'plugins'"
          @click="tab = 'plugins'"
        >
          <AppIcon name="sparkle" :size="15" class="rail-icon" />
          <span class="rail-text">
            <b>设计插件</b>
            <small>风格 · 预设 · 模板 · 图标</small>
          </span>
        </button>
      </nav>

      <!-- 右侧内容面板 -->
      <section v-show="tab === 'model'" class="settings-pane">
        <header class="pane-head">
          <h3>模型与 Agent</h3>
          <p>任何 OpenAI 兼容接口都能接入；桌面端还可以直接使用本机已登录的 Claude Code / Codex。</p>
        </header>

        <div class="pane-body">
          <p v-if="!draft.length" class="empty-hint">
            还没有配置模型：点下方「快速添加」选一个服务商，或用 Magpie 本地网关，填好 Base URL 与 Key 即可。
          </p>

          <div v-for="p in draft" :key="p.id" class="provider-card" :class="{ open: expandedId === p.id }">
            <!-- 收起态摘要行 -->
            <div
              class="prov-head"
              role="button"
              tabindex="0"
              :aria-expanded="expandedId === p.id"
              @click="toggleExpand(p.id)"
              @keydown.enter="toggleExpand(p.id)"
              @keydown.space.prevent="toggleExpand(p.id)"
            >
              <AppIcon name="chevron" :size="12" class="prov-caret" :class="{ open: expandedId === p.id }" />
              <span class="prov-name">{{ p.name.trim() || '未命名服务商' }}</span>
              <span class="kind-badge">{{ kindLabel(p) }}</span>
              <span class="prov-model">{{ p.model.trim() || '未设置模型' }}</span>
              <button
                type="button"
                class="default-btn"
                :class="{ on: activeId === p.id }"
                :title="activeId === p.id ? '当前默认模型' : '设为默认模型'"
                :aria-pressed="activeId === p.id"
                @click.stop="activeId = activeId === p.id ? '' : p.id"
              >
                <AppIcon name="star" :size="12" />
                <span>默认</span>
              </button>
              <Popconfirm title="删除该服务商？" @confirm="removeProvider(p.id)">
                <button type="button" class="prov-remove" title="删除" aria-label="删除服务商" @click.stop>
                  <AppIcon name="trash" :size="12" />
                </button>
              </Popconfirm>
            </div>

            <!-- 展开态编辑表单 -->
            <div v-if="expandedId === p.id" class="prov-editor">
              <label v-if="providerKindOptions.length > 1 || isAgentProvider(p)">
                <span>类型</span>
                <Select v-model:value="p.kind" :options="providerKindOptions" @change="onKindChange(p)" />
              </label>
              <template v-if="isAgentProvider(p)">
                <div class="grid2">
                  <label>
                    <span>名称</span>
                    <Input v-model:value="p.name" :placeholder="AGENT_LABEL[p.kind].name" />
                  </label>
                  <label>
                    <span>模型（可选）</span>
                    <Input v-model:value="p.model" :placeholder="AGENT_LABEL[p.kind].modelHint" />
                  </label>
                </div>
                <p v-if="!desktopAvailable" class="agent-status bad">本机 Agent 仅在桌面端可用</p>
                <p v-else-if="agents === null" class="agent-status">正在检测 {{ AGENT_LABEL[p.kind].bin }} 命令…</p>
                <p v-else-if="agents.some((a) => a.kind === p.kind)" class="agent-status ok">
                  已检测到 {{ agents.find((a) => a.kind === p.kind)!.version || AGENT_LABEL[p.kind].bin }}，
                  使用你已登录的订阅，不消耗额外额度
                </p>
                <p v-else class="agent-status bad">
                  未找到 {{ AGENT_LABEL[p.kind].bin }} 命令：请先安装并登录，确保它在 PATH 中
                </p>
              </template>
              <template v-else>
                <div class="grid2">
                  <label>
                    <span>名称</span>
                    <Input v-model:value="p.name" placeholder="如：智谱 GLM" />
                  </label>
                  <label>
                    <span class="span-row">
                      模型名
                      <button
                        type="button"
                        class="fetch-btn"
                        :disabled="fetchingModels[p.id] || !p.baseURL.trim()"
                        @click="fetchModels(p)"
                      >
                        {{ fetchingModels[p.id] ? '获取中…' : '从网关获取' }}
                      </button>
                    </span>
                    <Input v-model:value="p.model" placeholder="如：glm-4.7；本地网关可点上方按钮拉取" />
                    <div v-if="modelChoices[p.id]?.length" class="model-choices">
                      <button
                        v-for="m in modelChoices[p.id]"
                        :key="m"
                        type="button"
                        class="model-tag"
                        :class="{ on: p.model === m }"
                        @click="p.model = m"
                      >
                        {{ m }}
                      </button>
                    </div>
                  </label>
                </div>
                <label>
                  <span>Base URL（OpenAI 兼容，以 /v1 结尾）</span>
                  <Input v-model:value="p.baseURL" placeholder="open.bigmodel.cn/api/paas/v4" />
                </label>
                <label>
                  <span>API Key</span>
                  <InputPassword v-model:value="p.apiKey" placeholder="sk-…" />
                </label>
              </template>
            </div>
          </div>

          <div class="add-row">
            <div class="preset-row">
              <span class="micro-label">快速添加</span>
              <div class="preset-chips">
                <button
                  v-for="preset in PROVIDER_PRESETS"
                  :key="preset.label"
                  type="button"
                  class="preset-chip"
                  @click="addPreset(preset)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
            <Button type="dashed" block @click="addProvider">＋ 添加服务商</Button>
          </div>

          <div class="tips">
            <p>· 兼容所有提供 OpenAI 接口的服务商；本地网关（如 <code>Magpie</code>，默认 <code>http://127.0.0.1:3425/v1</code>）通常无需 Key。</p>
            <p>· 模型名可手填，也可点「从网关获取」拉取真实列表后点选；Key 仅存本机（localStorage）。</p>
            <p v-if="desktopAvailable">· 桌面端可选「本机 Agent」：直接调用已登录的 Claude Code / Codex，生成与写回代码都用你自己的订阅。</p>
          </div>
        </div>
      </section>

      <section v-show="tab === 'plugins'" class="settings-pane">
        <header class="pane-head">
          <h3>设计插件</h3>
          <p>风格 / 需求预设 / 画板模板 / 图标集四类插件，注入生成流程；支持 .md 风格包与 .json 插件包导入导出。</p>
        </header>

        <div class="pane-body">
          <div class="styles-toolbar">
            <Button size="small" type="primary" :disabled="isEditing" @click="openCreate('style')">
              ＋ 新建插件
            </Button>
            <button v-if="IS_DESKTOP" class="import-btn" @click="importViaDesktop">导入插件包</button>
            <label v-else class="import-btn">
              导入插件包
              <input type="file" accept=".md,.json,.txt" multiple @change="onImportFiles" />
            </label>
            <Button size="small" @click="exportAll">导出全部</Button>
            <Button v-if="IS_DESKTOP" size="small" @click="refreshFromDir">从插件目录刷新</Button>
            <span class="toolbar-hint">导入即用</span>
          </div>

          <div v-if="editing" class="provider-card editor-card">
            <div class="card-head">
              <b>{{ editing.id ? '编辑插件' : '新建插件' }}</b>
              <Button size="small" type="text" @click="closeEditor">收起</Button>
            </div>
            <div class="grid2">
              <label>
                <span>名称</span>
                <Input v-model:value="editing.name" placeholder="如：孟菲斯波普" />
              </label>
              <label>
                <span>类型</span>
                <Select v-model:value="editing.kind" :options="kindOptions" :disabled="!!editing.id" />
              </label>
            </div>
            <label v-if="editing.kind === 'style'">
              <span>风格指令（拼入生成提示词：配色 / 字体 / 构图 / 禁止项）</span>
              <textarea v-model="editing.prompt" class="prompt-editor" rows="8" />
            </label>
            <label v-if="editing.kind === 'preset'">
              <span>需求指令</span>
              <textarea v-model="editing.prompt" class="prompt-editor" rows="5" />
            </label>
            <div v-if="editing.kind === 'template'" class="grid2">
              <label>
                <span>宽</span>
                <InputNumber v-model:value="editing.width" :min="200" :max="2400" />
              </label>
              <label>
                <span>高</span>
                <InputNumber v-model:value="editing.height" :min="200" :max="2400" />
              </label>
            </div>
            <div class="editor-actions">
              <Button size="small" @click="closeEditor">取消</Button>
              <Button size="small" type="primary" @click="savePlugin">保存</Button>
            </div>
          </div>

          <template v-for="g in grouped" :key="g.kind">
            <div class="styles-section">
              <span class="micro-label">{{ g.label }}（{{ g.items.length }}）</span>
            </div>
            <div
              v-for="p in g.items"
              :key="p.id"
              class="style-row"
              :class="{ readonly: p.source === 'builtin', disabled: !p.enabled }"
            >
              <div class="style-body">
                <b>{{ p.name }} <span v-if="!p.enabled" class="off-tag">已停用</span></b>
                <p>{{ previewText(p) }}</p>
              </div>
              <div class="style-actions">
                <button class="sa" @click="toggle(p)">{{ p.enabled ? '停用' : '启用' }}</button>
                <button v-if="p.source === 'user'" class="sa" @click="openEdit(p)">编辑</button>
                <button v-if="p.source === 'builtin'" class="sa" @click="duplicate(p)">复制</button>
                <button class="sa" @click="exportPlugin(p)">导出</button>
                <Popconfirm
                  v-if="p.source === 'user'"
                  :title="`删除插件「${p.name}」？`"
                  @confirm="pluginRegistry.removeUserPlugin(p.id)"
                >
                  <button class="sa danger">删除</button>
                </Popconfirm>
              </div>
            </div>
          </template>
        </div>
      </section>
    </div>
  </Modal>
</template>

<style scoped>
/* —— 双栏骨架：左侧分区导航 + 右侧内容面板 —— */
.settings-shell {
  display: flex;
  height: 58vh;
  min-height: 400px;
}
.settings-rail {
  flex: none;
  width: 196px;
  padding: 6px 10px 6px 4px;
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.rail-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--ink-2);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.rail-item:hover {
  background: var(--hover);
  color: var(--ink);
}
.rail-item.on {
  background: var(--accent-soft);
  color: var(--ink);
}
.rail-item.on .rail-icon {
  color: var(--accent);
}
.rail-icon {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur-fast) var(--ease);
}
.rail-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.rail-text b {
  font-size: 13px;
  font-weight: 560;
  color: inherit;
}
.rail-text small {
  font-size: 10.5px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 内容面板 —— */
.settings-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 2px 4px 2px 18px;
}
.pane-head {
  flex: none;
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.pane-head h3 {
  margin: 0 0 3px;
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}
.pane-head p {
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.6;
}
.pane-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-right: 6px;
}
.empty-hint {
  margin: 0;
  padding: 11px 14px;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  background: var(--hover);
  font-size: 12px;
  color: var(--ink-2);
  line-height: 1.7;
}

/* —— 服务商手风琴卡 —— */
.provider-card {
  border: none;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  background: transparent;
  overflow: hidden;
  transition: box-shadow var(--dur-fast) var(--ease);
}
.provider-card.open {
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.prov-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px 9px 8px;
  cursor: pointer;
  user-select: none;
  transition: background var(--dur-fast) var(--ease);
}
.prov-head:hover {
  background: var(--hover);
}
.provider-card.open .prov-head {
  background: var(--hover);
}
.prov-caret {
  flex: none;
  color: var(--ink-3);
  transform: rotate(0deg);
  transition: transform var(--dur-fast) var(--ease);
}
.prov-caret.open {
  transform: rotate(90deg);
}
.prov-name {
  flex: none;
  max-width: 34%;
  font-size: 13px;
  font-weight: 560;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kind-badge {
  flex: none;
  font-family: var(--mono);
  font-size: 9.5px;
  letter-spacing: 0.04em;
  color: var(--ink-3);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}
.prov-model {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.default-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 8px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--ink-3);
  font-size: 11px;
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.default-btn:hover {
  background: var(--active);
  color: var(--ink);
}
.default-btn.on {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
.default-btn.on :deep(svg) {
  fill: currentColor;
}
.prov-remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.prov-remove:hover {
  background: var(--active);
  color: var(--spark);
}
.prov-editor {
  padding: 12px 14px 14px;
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
  animation: editor-in var(--dur-fast) var(--ease);
}
@keyframes editor-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.add-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.preset-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.preset-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.preset-chip {
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  background: transparent;
  color: var(--ink-2);
  font-size: 11.5px;
  padding: 3px 11px;
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.preset-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.span-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.fetch-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
}
.fetch-btn:disabled {
  color: var(--ink-3);
  cursor: not-allowed;
}
.model-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 120px;
  overflow-y: auto;
}
.model-tag {
  border: 1px solid var(--line-strong);
  border-radius: 6px;
  background: none;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--ink-2);
  cursor: pointer;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-tag:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.model-tag.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-raised);
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
label span {
  font-size: 12px;
  color: var(--ink-2);
}
.tips {
  font-size: 11.5px;
  color: var(--ink-3);
  line-height: 1.7;
  padding-top: 8px;
  border-top: 1px dashed var(--line);
}
.tips p {
  margin: 0;
}
.tips code {
  background: var(--bg-raised);
  padding: 1px 4px;
  border-radius: 4px;
  font-size: 11px;
}
.agent-status {
  margin: 0;
  font-size: 12px;
  color: var(--ink-3);
}
.agent-status.ok {
  color: var(--accent);
}
.agent-status.bad {
  color: var(--spark);
}

/* —— 插件页 —— */
.styles-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.toolbar-hint {
  font-size: 11px;
  color: var(--ink-3);
}
.import-btn {
  display: inline-flex;
  align-items: center;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  font-size: 12px;
  color: var(--ink-2);
  padding: 4px 10px;
  cursor: pointer;
}
.import-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.import-btn input {
  display: none;
}
.editor-card {
  box-shadow: inset 0 0 0 1px var(--line-strong);
}
.editor-card .card-head {
  padding: 9px 12px;
  border-bottom: 1px solid var(--line);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.card-head b {
  margin-right: auto;
  font-size: 13px;
  color: var(--ink);
}
.editor-card > .grid2,
.editor-card > label,
.editor-card > div.grid2 {
  margin: 0;
}
.editor-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 12px;
}
.editor-card .grid2,
.editor-card > label {
  padding: 0 12px;
}
.styles-section {
  margin-top: 4px;
}
.micro-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
}
.style-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 9px 12px;
  transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.style-row:hover {
  background: var(--hover);
}
.style-row.readonly {
  background: var(--bg-raised);
}
.style-row.disabled {
  opacity: 0.45;
}
.style-body {
  flex: 1;
  min-width: 0;
}
.style-body b {
  font-size: 13px;
  color: var(--ink);
}
.off-tag {
  font-size: 10px;
  color: var(--ink-3);
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 6px;
}
.style-body p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.style-actions {
  display: flex;
  gap: 4px;
  flex: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.style-row:hover .style-actions,
.style-row:focus-within .style-actions {
  opacity: 1;
}
.sa {
  border: none;
  background: transparent;
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 5px;
}
.sa:hover {
  background: var(--active);
  color: var(--ink);
}
.sa.danger:hover {
  color: var(--accent);
}
.prompt-editor {
  width: 100%;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  font-family: var(--sans);
  line-height: 1.7;
  resize: vertical;
  outline: none;
  background: var(--bg-raised);
  color: var(--ink);
}
.prompt-editor:focus {
  border-color: var(--accent);
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 12px;
}
</style>
