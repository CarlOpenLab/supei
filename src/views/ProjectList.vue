<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Input, Modal, Popconfirm, message } from 'antdv-next'
import { useWorkspaceStore } from '@/stores/workspace'
import AppIcon from '@/components/ui/AppIcon.vue'

const router = useRouter()
const ws = useWorkspaceStore()

const ready = ref(false)
onMounted(async () => {
  await ws.loadProjects()
  ready.value = true
})

const renameOpen = ref(false)
const renameTarget = ref<{ id: string; name: string } | null>(null)

async function createProject() {
  const p = await ws.createProject()
  router.push(`/p/${p.id}`)
}
function go(id: string) {
  router.push(`/p/${id}`)
}
function openRename(id: string, name: string) {
  renameTarget.value = { id, name }
  renameOpen.value = true
}
async function commitRename() {
  if (!renameTarget.value) return
  await ws.renameProject(renameTarget.value.id, renameTarget.value.name)
  renameOpen.value = false
}
async function remove(id: string) {
  await ws.deleteProject(id)
  message.success('项目已删除')
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div class="home">
    <header class="topbar">
      <span class="wordmark">原型画布<i>·</i>Design Canvas</span>
      <span class="topbar-meta">v0.1</span>
    </header>

    <main v-if="ready" class="content">
      <div class="head-row">
        <span class="micro-label">项目</span>
        <span class="rule" />
        <button class="new-btn" @click="createProject">
          <AppIcon name="plus" :size="13" />
          新建
        </button>
      </div>

      <button class="project-row ghost" @click="createProject">
        <span class="row-index">＋</span>
        <span class="row-body">
          <span class="row-name dim">从空白项目开始</span>
        </span>
        <span class="row-hint">聊天生成原型 · 点选元素定向反馈 · 画布上对比方案</span>
      </button>

      <button
        v-for="(p, i) in ws.projects"
        :key="p.id"
        class="project-row"
        :style="{ animationDelay: `${Math.min(i, 8) * 40}ms` }"
        @click="go(p.id)"
      >
        <span class="row-index">{{ String(i + 1).padStart(2, '0') }}</span>
        <span class="row-body">
          <span class="row-name">{{ p.name }}</span>
          <span class="row-meta">{{ fmtDate(p.createdAt) }}</span>
        </span>
        <span class="row-actions" @click.stop>
          <span class="action" @click="openRename(p.id, p.name)">重命名</span>
          <Popconfirm title="删除该项目及其全部画板？" @confirm="remove(p.id)">
            <span class="action danger">删除</span>
          </Popconfirm>
        </span>
        <AppIcon class="row-arrow" name="arrow-right" :size="14" />
      </button>

      <p v-if="!ws.projects.length" class="empty-note">
        画布会记住一切——项目、画板、对话与版本都在本机。
      </p>
    </main>

    <footer class="foot">
      <span class="foot-key">Enter</span> 发送 ·
      <span class="foot-key">⌖ 点击元素</span> 定向反馈 ·
      <span class="foot-key">Space</span> 拖移画布
    </footer>

    <Modal v-model:open="renameOpen" title="重命名项目" @ok="commitRename">
      <Input v-model:value="renameTarget!.name" placeholder="项目名称" @keydown.enter="commitRename" />
    </Modal>
  </div>
</template>

<style scoped>
.home {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--canvas-glow), var(--bg-canvas);
}
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}
.wordmark {
  font-family: var(--serif);
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.01em;
}
.wordmark i {
  font-style: normal;
  color: var(--accent);
  margin: 0 7px;
}
.topbar-meta {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.08em;
}
.content {
  width: min(720px, 100% - 48px);
  margin: 0 auto;
  flex: 1;
  padding: 48px 0 40px;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
}
.micro-label {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.14em;
  color: var(--ink-2);
}
.rule {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.new-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--ink);
  font-size: 12.5px;
  font-family: var(--sans);
  padding: 5px 12px;
  border-radius: var(--radius-s);
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.new-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.project-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
  padding: 13px 16px;
  margin-bottom: 8px;
  cursor: pointer;
  text-align: left;
  font-family: var(--sans);
  transition: border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
  animation: enter var(--dur) var(--ease) backwards;
}
.project-row:hover {
  border-color: var(--line-strong);
  background: var(--bg-raised);
  transform: translateY(-1px);
}
.project-row.ghost {
  background: transparent;
  border-style: dashed;
  border-color: var(--line-strong);
}
.project-row.ghost:hover {
  background: var(--hover);
  transform: none;
  border-color: var(--accent);
}
.row-index {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-3);
  width: 20px;
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-name {
  font-family: var(--serif);
  font-size: 16px;
  font-weight: 600;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-name.dim {
  font-size: 13.5px;
  font-weight: 500;
  font-family: var(--sans);
  color: var(--ink-2);
}
.row-meta {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
}
.row-hint {
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
}
.row-actions {
  display: flex;
  gap: 12px;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease);
}
.project-row:hover .row-actions {
  opacity: 1;
}
.action {
  font-size: 12px;
  color: var(--ink-2);
  cursor: pointer;
}
.action:hover {
  color: var(--ink);
}
.action.danger:hover {
  color: var(--accent);
}
.row-arrow {
  color: var(--ink-3);
  transition: transform var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.project-row:hover .row-arrow {
  color: var(--accent);
  transform: translateX(3px);
}
.empty-note {
  font-size: 12.5px;
  color: var(--ink-3);
  padding: 6px 2px;
}
.foot {
  padding: 14px 28px;
  border-top: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--ink-3);
  text-align: center;
}
.foot-key {
  font-family: var(--mono);
  font-size: 10.5px;
  border: 1px solid var(--line-strong);
  border-radius: 4px;
  padding: 1px 5px;
  color: var(--ink-2);
}
</style>