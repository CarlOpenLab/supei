<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Button,
  Input,
  InputPassword,
  InputNumber,
  Modal,
  Select,
  Tabs,
  TabPane,
  Popconfirm,
  message,
} from 'antdv-next'
import { DEMO_PROVIDER, useSettingsStore } from '@/stores/settings'
import type { ProviderConfig } from '@/types'
import { pluginRegistry, parsePluginFile } from '@/plugins/registry'
import type { DesignPlugin, PluginKind } from '@/plugins/types'
import { getDesktopBridge, IS_DESKTOP } from '@/services/desktop'
import { uid } from '@/utils/id'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const settings = useSettingsStore()

const tab = ref('model')

// —— 模型设置 ——
const draft = ref<ProviderConfig[]>([])
const activeId = ref('demo')

watch(
  () => props.open,
  (open) => {
    if (!open) return
    draft.value = settings.providers
      .filter((p) => p.id !== DEMO_PROVIDER.id)
      .map((p) => ({ ...p }))
    activeId.value = settings.activeId
    closeEditor()
  },
)

function save() {
  const valid = draft.value.filter((p) => p.name.trim() && p.baseURL.trim() && p.model.trim())
  if (valid.length !== draft.value.length) {
    message.warning('存在未填写完整的服务商（需要名称、baseURL、模型名），已自动忽略')
  }
  settings.providers = [DEMO_PROVIDER, ...valid]
  settings.activeId = valid.some((p) => p.id === activeId.value) ? activeId.value : 'demo'
  settings.save()
  message.success('设置已保存')
  emit('update:open', false)
}

const defaultOptions = ref<Array<{ label: string; value: string }>>([])
watch(
  [draft, activeId],
  () => {
    defaultOptions.value = [
      { label: DEMO_PROVIDER.name, value: DEMO_PROVIDER.id },
      ...draft.value
        .filter((p) => p.name.trim())
        .map((p) => ({ label: p.name, value: p.id })),
    ]
  },
  { deep: true },
)

function addProvider() {
  draft.value.push({ id: uid('prov'), name: '', baseURL: '', apiKey: '', model: '' })
}

function removeProvider(id: string) {
  draft.value = draft.value.filter((p) => p.id !== id)
  if (activeId.value === id) activeId.value = 'demo'
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
  <Modal :open="props.open" title="设置" width="680px" @cancel="emit('update:open', false)">
    <template #footer>
      <template v-if="tab === 'model'">
        <Button @click="emit('update:open', false)">取消</Button>
        <Button type="primary" @click="save">保存</Button>
      </template>
      <template v-else>
        <Button @click="emit('update:open', false)">关闭</Button>
      </template>
    </template>

    <Tabs v-model:activeKey="tab" size="small">
      <TabPane key="model" tab="模型设置">
        <div class="settings-body">
          <div class="demo-row">
            <div>
              <b>{{ DEMO_PROVIDER.name }}</b>
              <p>内置样例原型，不调用网络，用于快速体验完整流程。</p>
            </div>
            <label class="radio">
              <input v-model="activeId" type="radio" value="demo" />
              使用
            </label>
          </div>

          <div v-for="(p, i) in draft" :key="p.id" class="provider-card">
            <div class="card-head">
              <b>服务商 {{ i + 1 }}</b>
              <label class="radio">
                <input v-model="activeId" type="radio" :value="p.id" />
                设为默认
              </label>
              <Button size="small" danger type="text" @click="removeProvider(p.id)">删除</Button>
            </div>
            <div class="grid2">
              <label>
                <span>名称</span>
                <Input v-model:value="p.name" placeholder="如：智谱 GLM" />
              </label>
              <label>
                <span>模型名</span>
                <Input v-model:value="p.model" placeholder="如：glm-4.7" />
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
          </div>

          <Button type="dashed" block @click="addProvider">＋ 添加服务商</Button>

          <div class="tips">
            <p>· 兼容所有提供 OpenAI 接口的服务商：智谱、DeepSeek、OpenAI 等。</p>
            <p>· Key 仅保存在本机浏览器（localStorage），请求由浏览器直连服务商。</p>
          </div>
        </div>
      </TabPane>

      <TabPane key="plugins" tab="插件">
        <div class="settings-body">
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
            <span class="toolbar-hint">.md 风格包 / .json 插件包，导入即用</span>
          </div>

          <div v-if="editing" class="provider-card">
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
      </TabPane>
    </Tabs>
  </Modal>
</template>

<style scoped>
.settings-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 58vh;
  overflow-y: auto;
  padding-right: 4px;
}
.demo-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border: none;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  background: rgba(255, 255, 255, 0.02);
  padding: 11px 14px;
}
.demo-row p {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--ink-3);
}
.radio {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--ink-2);
  white-space: nowrap;
}
.provider-card {
  border: none;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  background: rgba(255, 255, 255, 0.02);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.demo-row b {
  font-size: 13px;
  color: var(--ink);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
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
  font-size: 12px;
  color: var(--ink-3);
  line-height: 1.7;
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
  padding: 10px 14px;
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
  gap: 8px;
  flex: none;
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
}
</style>
