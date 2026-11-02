<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Input, InputNumber, Modal, Select, message } from 'antdv-next'
import { useCanvasStore } from '@/stores/canvas'
import { useSettingsStore } from '@/stores/settings'
import { useWorkspaceStore } from '@/stores/workspace'
import { useLiveStore } from '@/stores/live'
import { createEmptyArtboard } from '@/services/orchestrator'
import { desktopAvailable, requireDesktopBridge } from '@/services/desktop'
import type { RepoInfo } from '@/services/mygo-client'
import ChatPanel from '@/components/chat/ChatPanel.vue'
import InfiniteCanvas from '@/components/canvas/InfiniteCanvas.vue'
import InspectorPanel from '@/components/canvas/InspectorPanel.vue'
import SettingsModal from '@/components/settings/SettingsModal.vue'
import ShareModal from '@/components/share/ShareModal.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ThemeToggle from '@/components/ui/ThemeToggle.vue'
import { pluginRegistry } from '@/plugins/registry'
import type { TemplatePluginData } from '@/plugins/types'
import { buildProjectViewerHtml, downloadViewer } from '@/utils/exportProject'

const route = useRoute()
const router = useRouter()
const ws = useWorkspaceStore()
const canvas = useCanvasStore()
const settings = useSettingsStore()

const settingsOpen = ref(false)
const newBoardOpen = ref(false)
const helpOpen = ref(false)

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

const providerLabel = computed(() => settings.active?.name || '未配置模型')

// —— 实时画板：打开本地仓库 / 捕获网页（仅桌面端）——
const liveStore = useLiveStore()
const LIVE_SIZES = SIZE_PRESETS.filter((o) => o.value !== 'custom')
const liveSize = ref('1280x800')
const repoInfo = ref<RepoInfo | null>(null)
const repoScript = ref('')
const webOpen = ref(false)
const webUrl = ref('')

/**
 * @description 把尺寸预设值（如 "1280x800"）拆成宽高。
 * @param value - 预设值
 * @returns 画板宽高
 */
function sizeOf(value: string): { width: number; height: number } {
  const [width, height] = value.split('x').map(Number)
  return { width, height }
}

/**
 * @description 选择本地前端项目目录，读出 scripts 后弹出确认（默认选 dev / start）。
 */
async function openRepo() {
  try {
    const bridge = await requireDesktopBridge('打开代码仓库')
    const info = await bridge.DevServer.pickRepo()
    if (!info.dir) return
    if (!info.scripts.length) {
      message.warning('这个项目的 package.json 里没有可运行的 scripts')
      return
    }
    repoScript.value = ['dev', 'start', 'serve', 'preview'].find((s) => info.scripts.includes(s)) ?? info.scripts[0]
    repoInfo.value = info
  } catch (err) {
    message.error((err as Error).message)
  }
}

/** 确认打开仓库：建实时画板并启动 dev server */
async function createRepoBoard() {
  const info = repoInfo.value
  if (!info) return
  repoInfo.value = null
  const board = await createEmptyArtboard({
    title: info.name,
    ...sizeOf(liveSize.value),
    kind: 'live',
    live: {
      type: 'repo',
      repoDir: info.dir,
      script: repoScript.value,
      packageManager: info.packageManager,
      url: '',
      route: '/',
    },
  })
  liveStore.start(board.id)
}

/** 捕获网页：建网页实时画板（经本机代理加载），用户调整好页面状态后再「捕获」 */
async function createWebBoard() {
  const raw = webUrl.value.trim()
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    message.warning('请输入有效的网址')
    return
  }
  webOpen.value = false
  webUrl.value = ''
  const board = await createEmptyArtboard({
    title: url.hostname,
    ...sizeOf(liveSize.value),
    kind: 'live',
    live: { type: 'web', url: url.href, route: url.pathname + url.search + url.hash },
  })
  liveStore.start(board.id)
}

/** 收集可导出/分享的画板（有版本的）；一块都没有时提示并返回 null */
function collectExportable(verb: string) {
  const boards = ws.artboards.filter((b) => b.versions.length > 0)
  if (!boards.length) message.warning(`还没有可${verb}的画板，先在左侧聊天里生成一个原型吧`)
  return boards.length ? boards : null
}

/** 整项目导出：全部画板最新版 → 单文件交互式预览页 */
function exportProjectViewer() {
  const boards = collectExportable('导出')
  if (!boards) return
  const html = buildProjectViewerHtml(ws.currentProject?.name || '未命名项目', boards)
  const safe = (ws.currentProject?.name || 'project').replace(/[\\/:*?"<>|]/g, '_')
  downloadViewer(`${safe}-preview.html`, html)
  message.success(`已导出 ${boards.length} 块画板的交互式预览页`)
}

/** 局域网分享整项目（桌面端）：与「导出预览」同一份交互式预览页，发布到本机服务 */
function shareProject() {
  const boards = collectExportable('分享')
  if (!boards) return
  const name = ws.currentProject?.name || '未命名项目'
  canvas.sharePayload = { title: name, html: buildProjectViewerHtml(name, boards) }
}

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
      <span class="provider-chip">{{ providerLabel }}</span>
      <button class="bar-btn" title="全部画板导出为单文件交互式预览页" @click="exportProjectViewer">
        <AppIcon name="share" :size="13" /> 导出预览
      </button>
      <button v-if="desktopAvailable" class="bar-btn" title="发布到局域网：同网络的同事扫码即看" @click="shareProject">
        <AppIcon name="link" :size="13" /> 分享
      </button>
      <template v-if="desktopAvailable">
        <button class="bar-btn" title="打开本地前端项目：画布上实时预览，点选元素让本机 Agent 改代码" @click="openRepo">
          <AppIcon name="code" :size="13" /> 代码仓库
        </button>
        <button class="bar-btn" title="把任意网页放到画布上，捕获为可编辑的设计稿" @click="webOpen = true">
          <AppIcon name="globe" :size="13" /> 捕获网页
        </button>
      </template>
      <button class="bar-btn" @click="newBoardOpen = true">
        <AppIcon name="plus" :size="13" /> 新建画板
      </button>
      <button class="bar-btn icon-only" title="模型与风格设置" @click="settingsOpen = true">
        <AppIcon name="gear" :size="14" />
      </button>
      <button class="bar-btn icon-only" title="快捷键（按 ?）" @click="helpOpen = true">
        <AppIcon name="help" :size="14" />
      </button>
      <ThemeToggle />
    </header>

    <Modal v-model:open="helpOpen" title="快捷键与操作" width="500px" :footer="null">
      <div class="help-list">
        <div class="help-group">画布</div>
        <div class="help-row"><span>重置缩放 / 适配全部</span><span class="keys">0 / 1</span></div>
        <div class="help-row"><span>缩放（阻尼平滑）</span><span class="keys">Ctrl/⌘ + 滚轮</span></div>
        <div class="help-row"><span>平移</span><span class="keys">Space + 拖拽 / 中键拖拽</span></div>
        <div class="help-row"><span>框选多选（Shift = 并集）</span><span class="keys">空白区左键拖拽</span></div>
        <div class="help-group">画板</div>
        <div class="help-row"><span>移动画板（吸附对齐）</span><span class="keys">拖拽画板头栏</span></div>
        <div class="help-row"><span>微移 1px / 10px</span><span class="keys">方向键 / Shift + 方向键</span></div>
        <div class="help-row"><span>全选</span><span class="keys">Ctrl/⌘ + A</span></div>
        <div class="help-row"><span>复制 / 粘贴（含版本）</span><span class="keys">Ctrl/⌘ + C / V</span></div>
        <div class="help-row"><span>创建副本</span><span class="keys">Ctrl/⌘ + D</span></div>
        <div class="help-row"><span>删除选中（含多选批量）</span><span class="keys">Del</span></div>
        <div class="help-row"><span>重命名画板</span><span class="keys">双击标题</span></div>
        <div class="help-row"><span>画板菜单</span><span class="keys">右键画板 / ⋮</span></div>
        <div class="help-row"><span>版本历史时间线</span><span class="keys">点击版本号</span></div>
        <div class="help-row"><span>加入多选</span><span class="keys">Shift + 点击头栏</span></div>
        <div class="help-group">AI</div>
        <div class="help-row"><span>发送 / 停止生成</span><span class="keys">Enter / 停止按钮</span></div>
        <div class="help-row"><span>定向反馈</span><span class="keys">⌖ 点选元素</span></div>
        <div class="help-group">手动编辑</div>
        <div class="help-row"><span>检查器调整样式</span><span class="keys">✎ 编辑工具 + 点选元素</span></div>
        <div class="help-row"><span>就地改字（Enter 完成 / Esc 撤销）</span><span class="keys">双击文字</span></div>
        <div class="help-row"><span>测量与其它元素的间距</span><span class="keys">选中后按住 Alt 悬停</span></div>
        <div class="help-row"><span>保存为新版本（AI 迭代前自动保存）</span><span class="keys">画板头栏「保存」</span></div>
        <div class="help-row"><span>取消 / 退出对比 / 清除选择</span><span class="keys">Esc</span></div>
        <p class="help-note">提示：画板获得焦点时（点过画板内部），快捷键由 webview 内部转发，行为一致。</p>
      </div>
    </Modal>

    <div class="canvas-body">
      <ChatPanel />
      <div class="canvas-col">
        <InfiniteCanvas />
        <InspectorPanel />
      </div>
    </div>

    <SettingsModal v-model:open="settingsOpen" />
    <ShareModal />

    <Modal :open="!!repoInfo" title="打开代码仓库" ok-text="启动预览" @ok="createRepoBoard" @cancel="repoInfo = null">
      <div v-if="repoInfo" class="board-form">
        <p class="hint mono">{{ repoInfo.dir }}</p>
        <label>
          <span>启动脚本（{{ repoInfo.packageManager }} run …）</span>
          <Select v-model:value="repoScript" :options="repoInfo.scripts.map((s) => ({ label: s, value: s }))" />
        </label>
        <label>
          <span>画板尺寸</span>
          <Select v-model:value="liveSize" :options="LIVE_SIZES" />
        </label>
        <p class="hint">在画布上运行 dev server 并实时预览：点选页面元素或直接在对话里描述，本机 Agent 会直接改代码；也可以「捕获」成设计稿再迭代。</p>
      </div>
    </Modal>

    <Modal v-model:open="webOpen" title="捕获网页" ok-text="打开" @ok="createWebBoard">
      <div class="board-form">
        <label>
          <span>网址</span>
          <Input v-model:value="webUrl" placeholder="https://example.com" @keydown.enter="createWebBoard" />
        </label>
        <label>
          <span>画板尺寸</span>
          <Select v-model:value="liveSize" :options="LIVE_SIZES" />
        </label>
        <p class="hint">网页经本机代理加载到画布上。关掉弹窗、滚到想要的状态后，点画板头栏的「捕获」得到可编辑的设计稿。</p>
      </div>
    </Modal>

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
  font-family: var(--display);
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
  border: none;
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
}
.bar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: var(--btn-quiet-bg);
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink);
  font-size: 13px;
  padding: 6px 14px;
  border-radius: var(--radius-m);
  cursor: pointer;
  font-family: var(--sans);
  transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.bar-btn:hover {
  background: var(--bg-raised);
  color: var(--ink);
}
.bar-btn.icon-only {
  padding: 6px 9px;
}
.flex1 {
  flex: 1;
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
.hint.mono {
  font-family: var(--mono);
  word-break: break-all;
}
</style>
