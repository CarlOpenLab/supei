<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Input, InputNumber, Modal, Select, message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { createEmptyArtboard } from '@/services/orchestrator'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import InfiniteCanvas from '@/components/canvas/InfiniteCanvas.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { pluginRegistry } from '@/plugins/registry'
import type { TemplatePluginData } from '@/plugins/types'

const route = useRoute()
const router = useRouter()
const ws = useWorkspaceStore()
const canvas = useCanvasStore()
const settings = useSettingsStore()

const settingsOpen = ref(false)
const newBoardOpen = ref(false)
const helpOpen = ref(false)
const setupDismissed = ref(localStorage.getItem('dc.setup-dismissed') === '1')

function dismissSetup() {
  setupDismissed.value = true
  localStorage.setItem('dc.setup-dismissed', '1')
}

const SIZE_PRESETS = [
  ...pluginRegistry.listByKind('template').map((t) => {
    const d = t.data as TemplatePluginData
    return { label: t.name, value: `${d.width}x${d.height}` }
  }),
  { label: '自定义', value: 'custom' },
]
const newBoardTitle = ref('')
const newBoardSize = ref('1280x800')
const customW = ref(1024)
const customH = ref(768)

const providerLabel = computed(() =>
  settings.isDemo ? '演示模式' : settings.active.name || '未命名服务商',
)

function onGlobalKeydown(e: KeyboardEvent) {
  if (e.key === '?') {
    const el = document.activeElement as HTMLElement | null
    const tag = el?.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || el?.isContentEditable) return
    helpOpen.value = true
  }
}

onMounted(async () => {
  const id = route.params.id as string
  // 直接在 /p/:id 刷新时项目列表尚未加载，先补齐
  if (!ws.loaded) await ws.loadProjects()
  if (ws.currentProjectId !== id) await ws.openProject(id)
  if (!ws.currentProject) {
    message.error('项目不存在')
    router.replace('/')
    return
  }
  canvas.setProjectKey(id)
  canvas.select(canvas.restoreFor(id))
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown))

watch(
  () => route.params.id,
  async (id) => {
    if (id && typeof id === 'string' && ws.currentProjectId !== id) {
      await ws.openProject(id)
      canvas.setProjectKey(id)
      canvas.select(canvas.restoreFor(id))
    }
  },
)

const renaming = ref(false)
const nameDraft = ref('')
function startRename() {
  nameDraft.value = ws.currentProject?.name ?? ''
  renaming.value = true
}
async function commitRename() {
  renaming.value = false
  if (ws.currentProjectId && nameDraft.value.trim()) {
    await ws.renameProject(ws.currentProjectId, nameDraft.value)
  }
}

async function createBoard() {
  const isCustom = newBoardSize.value === 'custom'
  const [w, h] = isCustom ? [customW.value, customH.value] : newBoardSize.value.split('x').map(Number)
  await createEmptyArtboard({
    title: newBoardTitle.value.trim() || `画板 ${ws.artboards.length + 1}`,
    width: Math.min(2400, Math.max(200, w)),
    height: Math.min(2400, Math.max(200, h)),
  })
  newBoardOpen.value = false
  newBoardTitle.value = ''
}
</script>

<template>
  <div class="canvas-page">
    <header class="page-bar">
      <button class="back-btn" @click="router.push('/')">
        <AppIcon name="arrow-left" :size="13" /> 项目
      </button>
      <input
        v-if="renaming"
        v-model="nameDraft"
        class="name-input"
        @keydown.enter="commitRename"
        @blur="commitRename"
      />
      <span v-else class="proj-name" title="点击重命名" @click="startRename">
        {{ ws.currentProject?.name || '…' }}
      </span>
      <span class="flex1" />
      <span class="provider-chip" :class="{ demo: settings.isDemo }">{{ providerLabel }}</span>
      <button class="bar-btn" @click="newBoardOpen = true">
        <AppIcon name="plus" :size="13" /> 新建画板
      </button>
      <button class="bar-btn icon-only" title="模型与风格设置" @click="settingsOpen = true">
        <AppIcon name="gear" :size="14" />
      </button>
      <button class="bar-btn icon-only" title="快捷键（按 ?）" @click="helpOpen = true">
        <AppIcon name="help" :size="14" />
      </button>
    </header>

    <Modal v-model:open="helpOpen" title="快捷键与操作" width="460px" :footer="null">
      <div class="help-list">
        <div class="help-group">画布</div>
        <div class="help-row"><span>缩放 100% / 适配全部</span><span class="keys">0 / 1</span></div>
        <div class="help-row"><span>缩放</span><span class="keys">Ctrl/⌘ + 滚轮</span></div>
        <div class="help-row"><span>平移</span><span class="keys">拖拽空白区</span></div>
        <div class="help-row"><span>移动画板</span><span class="keys">拖拽画板头栏</span></div>
        <div class="help-group">画板</div>
        <div class="help-row"><span>复制画板</span><span class="keys">Ctrl/⌘ + D</span></div>
        <div class="help-row"><span>删除画板</span><span class="keys">Del</span></div>
        <div class="help-row"><span>重命名画板</span><span class="keys">双击标题</span></div>
        <div class="help-group">AI</div>
        <div class="help-row"><span>发送 / 停止生成</span><span class="keys">Enter / 停止按钮</span></div>
        <div class="help-row"><span>定向反馈</span><span class="keys">⌖ 点选元素</span></div>
        <div class="help-row"><span>取消选中</span><span class="keys">Esc</span></div>
        <p class="help-note">提示：画板获得焦点时（点过画板内部），快捷键由 webview 内部转发，行为一致。</p>
      </div>
    </Modal>

    <div v-if="settings.isDemo && !setupDismissed" class="setup-banner">
      <AppIcon name="sparkle" :size="13" class="banner-icon" />
      <span class="banner-text">
        当前为<b>演示模式</b>。在「设置 → 模型设置」里配置一个真实模型 Key（任意 OpenAI 兼容服务商，
        如智谱 <code>open.bigmodel.cn/api/paas/v4</code>），即可解锁 AI 规划、深度思考与真实生成。
      </span>
      <button class="banner-btn" @click="settingsOpen = true">去配置</button>
      <button class="banner-close" title="不再提示" @click="dismissSetup">×</button>
    </div>

    <div class="canvas-body">
      <ChatPanel />
      <div class="canvas-col">
        <InfiniteCanvas />
      </div>
    </div>

    <SettingsModal v-model:open="settingsOpen" />

    <Modal v-model:open="newBoardOpen" title="新建画板" @ok="createBoard">
      <div class="board-form">
        <label>
          <span>画板名称（可留空）</span>
          <Input v-model:value="newBoardTitle" placeholder="如：落地页 A 方案" />
        </label>
        <label>
          <span>尺寸</span>
          <Select v-model:value="newBoardSize" :options="SIZE_PRESETS" />
        </label>
        <div v-if="newBoardSize === 'custom'" class="grid2">
          <label>
            <span>宽</span>
            <InputNumber v-model:value="customW" :min="200" :max="2400" />
          </label>
          <label>
            <span>高</span>
            <InputNumber v-model:value="customH" :min="200" :max="2400" />
          </label>
        </div>
        <p class="hint">创建后在左侧聊天中输入需求即可在该画板上生成原型。</p>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.canvas-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.page-bar {
  height: 52px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--line);
}
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--ink-2);
  font-size: 13px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: var(--radius-s);
  font-family: var(--sans);
  transition: color var(--dur-fast) var(--ease);
}
.back-btn:hover {
  color: var(--ink);
  background: var(--active);
}
.proj-name {
  font-family: var(--serif);
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
  cursor: text;
  padding: 4px 8px;
  border-radius: var(--radius-s);
  max-width: 280px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.proj-name:hover {
  background: var(--active);
}
.name-input {
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--accent);
  border-radius: var(--radius-s);
  padding: 4px 8px;
  outline: none;
  width: 220px;
  background: var(--bg-raised);
  color: var(--ink);
}
.provider-chip {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  color: var(--ink-2);
}
.provider-chip.demo {
  color: var(--accent);
  border-color: rgba(255, 107, 71, 0.5);
}
.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  padding: 6px 14px;
  border-radius: var(--radius-s);
  cursor: pointer;
  font-family: var(--sans);
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.bar-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.bar-btn.icon-only {
  padding: 6px 9px;
}
.flex1 {
  flex: 1;
}
.setup-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  background: linear-gradient(90deg, rgba(255, 107, 71, 0.14), rgba(255, 107, 71, 0.05));
  border-bottom: 1px solid rgba(255, 107, 71, 0.3);
  font-size: 12.5px;
  color: var(--ink-2);
}
.banner-icon {
  color: var(--accent);
  flex: none;
}
.banner-text {
  flex: 1;
  min-width: 0;
  line-height: 1.5;
}
.banner-text b {
  color: var(--accent);
}
.banner-text code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--bg-raised);
  padding: 1px 5px;
  border-radius: 4px;
}
.banner-btn {
  flex: none;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  padding: 4px 14px;
  border-radius: var(--radius-s);
  cursor: pointer;
  font-family: var(--sans);
  transition: background var(--dur-fast) var(--ease);
}
.banner-btn:hover {
  background: var(--accent-deep);
}
.banner-close {
  flex: none;
  border: none;
  background: transparent;
  color: var(--ink-3);
  font-size: 15px;
  cursor: pointer;
  padding: 2px 6px;
}
.banner-close:hover {
  color: var(--ink);
}
.canvas-body {
  flex: 1;
  display: flex;
  min-height: 0;
  animation: enter var(--dur-slow) var(--ease);
}
.canvas-col {
  flex: 1;
  position: relative;
  min-width: 0;
}
.help-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.help-group {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.1em;
  color: var(--ink-3);
  margin-top: 8px;
}
.help-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 13px;
  color: var(--ink);
  padding: 5px 2px;
  border-bottom: 1px solid var(--line);
}
.help-row .keys {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 1px 8px;
}
.help-note {
  font-size: 11.5px;
  color: var(--ink-3);
  margin: 8px 0 0;
}
.board-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.board-form label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.board-form label span {
  font-size: 12px;
  color: var(--ink-2);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.hint {
  font-size: 12px;
  color: var(--ink-3);
  margin: 0;
}
</style>
