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
    <!-- 设计工具隐喻：顶部标尺刻度 -->
    <div class="ruler-x" aria-hidden="true" />

    <header class="topbar">
      <span class="win-lights" aria-hidden="true"><i /><i /><i /></span>
      <span class="logo-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="#fff">
          <path d="M8 0l1.7 4.6L14 3l-3 3.7L16 8l-5 1.3L14 13l-4.3-1.6L8 16l-1.7-4.6L2 13l3-3.7L0 8l5-1.3L2 3l4.3 1.6z" />
        </svg>
      </span>
      <span class="wordmark">原型画布</span>
      <span class="topbar-meta">Design Canvas · v0.1</span>
    </header>

    <main v-if="ready" class="content">
      <section class="hero">
        <div class="hero-left">
          <p class="kicker">AI Prototype Canvas</p>
          <h1 class="display-title hero-title">
            你和 AI 在同一块画布，<br />把设计做完。
          </h1>
        </div>
        <div class="hero-side">
          <p class="hero-desc">
            聊天生成 HTML 原型，点选元素定向反馈，多方案并排对比。满意后一键导出，交给正式开发。
          </p>
          <div class="hero-cta">
            <button class="btn-primary" @click="createProject">
              <AppIcon name="plus" :size="13" />
              新建项目
            </button>
            <button class="btn-ghost" @click="createProject">从空白开始</button>
          </div>
        </div>
      </section>

      <section class="projects">
        <div class="head-row">
          <span class="kicker">项目 / Projects</span>
          <span class="rule" />
          <span class="count" v-if="ws.projects.length">{{ ws.projects.length }}</span>
        </div>

        <button class="project-row ghost" @click="createProject">
          <span class="row-index">＋</span>
          <span class="row-body">
            <span class="row-name dim">从空白项目开始</span>
          </span>
          <span class="row-hint">回车聚焦输入 · 画布记住一切</span>
          <AppIcon class="row-arrow" name="arrow-right" :size="14" />
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
      </section>
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
  background:
    radial-gradient(900px 420px at 50% -8%, rgba(176, 92, 242, 0.1), transparent 62%),
    radial-gradient(700px 360px at 88% 4%, rgba(255, 107, 71, 0.05), transparent 60%),
    var(--bg-canvas);
}

/* 顶部标尺：8px 小刻度 + 80px 大刻度，设计工具隐喻 */
.ruler-x {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 26px;
  z-index: 20;
  background:
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.16) 0 1px, transparent 1px 80px) left bottom / 100% 9px no-repeat,
    repeating-linear-gradient(90deg, rgba(255, 255, 255, 0.07) 0 1px, transparent 1px 8px) left bottom / 100% 5px no-repeat,
    var(--bg-panel);
  border-bottom: 1px solid var(--line);
}

.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 26px;
  padding: 13px 24px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-panel);
}
.win-lights {
  display: inline-flex;
  gap: 6px;
  margin-right: 4px;
}
.win-lights i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  opacity: 0.55;
}
.win-lights i:nth-child(1) { background: #ff5f57; }
.win-lights i:nth-child(2) { background: #febc2e; }
.win-lights i:nth-child(3) { background: #28c840; }
.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--accent) 10%, var(--spark) 110%);
  box-shadow: var(--btn-primary-shadow);
}
.wordmark {
  font-family: var(--display);
  font-size: 14.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.topbar-meta {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.08em;
}

.content {
  width: min(880px, 100% - 48px);
  margin: 0 auto;
  flex: 1;
  padding: 64px 0 56px;
}

/* —— Hero：左标题右说明，wonder 双栏 —— */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 48px;
  align-items: end;
  padding-bottom: 56px;
  margin-bottom: 44px;
  border-bottom: 1px solid var(--line);
}
.hero-title {
  margin: 16px 0 0;
  font-size: clamp(32px, 4.4vw, 46px);
  color: var(--ink);
  font-weight: 560;
}
.hero-desc {
  margin: 0 0 20px;
  font-size: 14.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.hero-cta {
  display: flex;
  gap: 10px;
  align-items: center;
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 16px;
  border-radius: var(--radius-m);
  background: var(--btn-primary-bg);
  box-shadow: var(--btn-primary-shadow);
  border: none;
  color: #fff;
  font-size: 13.5px;
  font-weight: 500;
  font-family: var(--sans);
  cursor: pointer;
  transition: filter var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease);
}
.btn-primary:hover {
  filter: brightness(1.09);
  transform: translateY(-1px);
}
.btn-primary:active {
  transform: none;
}
.btn-ghost {
  padding: 9px 14px;
  border-radius: var(--radius-m);
  background: var(--btn-quiet-bg);
  box-shadow: var(--btn-quiet-shadow);
  border: none;
  color: var(--ink);
  font-size: 13.5px;
  font-weight: 500;
  font-family: var(--sans);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease);
}
.btn-ghost:hover {
  background: var(--bg-raised);
}

/* —— 项目列表：发丝分隔行 —— */
.head-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 6px;
}
.rule {
  flex: 1;
  height: 1px;
  background: var(--line);
}
.count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-3);
  min-width: 22px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  box-shadow: var(--btn-quiet-shadow);
}

.project-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 16px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--line);
  border-radius: 0;
  padding: 15px 10px;
  cursor: pointer;
  text-align: left;
  font-family: var(--sans);
  color: var(--ink);
  transition: background var(--dur-fast) var(--ease);
  animation: enter var(--dur) var(--ease) backwards;
}
.project-row:hover {
  background: var(--hover);
}
.project-row.ghost {
  border-bottom: 1px dashed var(--line-strong);
}
.project-row.ghost:hover {
  background: rgba(176, 92, 242, 0.05);
}
.row-index {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-3);
  width: 22px;
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.row-name {
  font-family: var(--display);
  font-size: 16.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
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
  font-size: 10.5px;
  color: var(--ink-3);
  letter-spacing: 0.04em;
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
  padding: 10px 2px;
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
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--ink-2);
  box-shadow: var(--btn-quiet-shadow);
}

@media (max-width: 760px) {
  .hero {
    grid-template-columns: 1fr;
    gap: 24px;
    align-items: start;
  }
}
</style>
