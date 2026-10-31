<script setup lang="ts">
import { computed, ref } from 'vue'
import { Modal } from 'antdv-next'
import type { Artboard } from '@/types'
import { diffHtml, markDiff } from '@/utils/diff'
import type { DiffEntry } from '@/utils/diff'

const props = defineProps<{ open: boolean; board: Artboard | null; versionA: string; versionB: string }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void }>()

const htmlA = computed(
  () => props.board?.versions.find((v) => v.id === props.versionA)?.html ?? '',
)
const htmlB = computed(
  () => props.board?.versions.find((v) => v.id === props.versionB)?.html ?? '',
)
const labelA = computed(() => {
  const list = props.board?.versions ?? []
  return `v${list.findIndex((v) => v.id === props.versionA) + 1}`
})
const labelB = computed(() => {
  const list = props.board?.versions ?? []
  return `v${list.findIndex((v) => v.id === props.versionB) + 1}`
})

const diff = computed(() => diffHtml(htmlA.value, htmlB.value))
const highlight = ref(true)
/** 点击统计 chip 过滤高亮类别；再点取消。null = 全部 */
const kindFilter = ref<DiffEntry['kind'] | null>(null)
function toggleKind(k: DiffEntry['kind']) {
  kindFilter.value = kindFilter.value === k ? null : k
}

const markedA = computed(() => {
  if (!highlight.value) return htmlA.value
  const entries = diff.value.entries.filter(
    (e) => e.kind !== 'add' && (!kindFilter.value || e.kind === kindFilter.value),
  )
  return markDiff(htmlA.value, entries)
})
const markedB = computed(() => {
  if (!highlight.value) return htmlB.value
  const entries = diff.value.entries.filter(
    (e) => e.kind !== 'del' && (!kindFilter.value || e.kind === kindFilter.value),
  )
  return markDiff(htmlB.value, entries)
})

const hasDiff = computed(
  () => diff.value.added + diff.value.changed + diff.value.attrChanged + diff.value.removed > 0,
)
</script>

<template>
  <Modal
    :open="props.open"
    :title="`版本对比 — ${props.board?.title ?? ''}`"
    width="88vw"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <div class="cmp-toolbar">
      <div class="diff-stats" v-if="hasDiff">
        <button class="stat add" :class="{ active: kindFilter === 'add' }" @click="toggleKind('add')">+{{ diff.added }} 新增</button>
        <button class="stat chg" :class="{ active: kindFilter === 'chg' }" @click="toggleKind('chg')">~{{ diff.changed }} 修改</button>
        <button class="stat attr" :class="{ active: kindFilter === 'attr' }" v-if="diff.attrChanged" @click="toggleKind('attr')">◦{{ diff.attrChanged }} 样式</button>
        <button class="stat del" :class="{ active: kindFilter === 'del' }" v-if="diff.removed" @click="toggleKind('del')">−{{ diff.removed }} 移除</button>
      </div>
      <span v-else class="diff-none">两版内容一致</span>
      <span class="flex1" />
      <span v-if="kindFilter" class="filter-hint">已过滤：仅此类别</span>
      <button
        v-if="hasDiff"
        class="hl-toggle"
        :class="{ on: highlight }"
        @click="highlight = !highlight"
      >
        高亮改动
      </button>
    </div>
    <div class="compare">
      <div class="pane">
        <div class="pane-head">
          <span class="ver">{{ labelA }}</span>
          <span class="pane-note">上一版</span>
          <span class="flex1" />
          <span class="pane-diff del" v-if="highlight && diff.removed">−{{ diff.removed }}</span>
        </div>
        <iframe class="preview" :srcdoc="markedA" sandbox="allow-same-origin" />
      </div>
      <div class="pane">
        <div class="pane-head">
          <span class="ver accent">{{ labelB }}</span>
          <span class="pane-note">当前版</span>
          <span class="flex1" />
          <span class="pane-diff add" v-if="highlight && diff.added">+{{ diff.added }}</span>
        </div>
        <iframe class="preview" :srcdoc="markedB" sandbox="allow-same-origin" />
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.cmp-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.diff-stats {
  display: flex;
  gap: 6px;
}
.stat {
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  border: none;
  cursor: pointer;
  transition: all var(--dur-fast) var(--ease);
}
.stat:hover {
  filter: brightness(1.15);
}
.stat.active {
  filter: brightness(1.2);
  box-shadow:
    inset 0 0 0 1px currentColor,
    0 0 0 3px rgba(22, 119, 255, 0.12);
}
.filter-hint {
  font-size: 11px;
  color: var(--ink-3);
}
.stat.add {
  color: var(--accent);
  background: var(--accent-soft);
}
.stat.chg {
  color: var(--ink-2);
  box-shadow: var(--btn-quiet-shadow);
}
.stat.attr {
  color: #f0a020;
  background: rgba(240, 160, 32, 0.1);
}
.stat.del {
  color: #ff5459;
  background: rgba(255, 84, 89, 0.1);
}
.diff-none {
  font-size: 12px;
  color: var(--ink-3);
}
.flex1 {
  flex: 1;
}
.hl-toggle {
  border: none;
  background: transparent;
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
  font-size: 12px;
  padding: 3.5px 12px;
  border-radius: 999px;
  cursor: pointer;
  font-family: var(--sans);
  transition: all var(--dur-fast) var(--ease);
}
.hl-toggle.on {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
.pane-diff {
  font-family: var(--mono);
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
}
.pane-diff.add {
  color: var(--accent);
  background: var(--accent-soft);
}
.pane-diff.del {
  color: #ff5459;
  background: rgba(255, 84, 89, 0.1);
}
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pane {
  border: none;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--bg-raised);
}
.ver {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  background: rgba(255, 255, 255, 0.06);
  padding: 2px 9px;
  border-radius: 999px;
}
.ver.accent {
  color: var(--accent);
  background: var(--accent-soft);
}
.pane-note {
  font-size: 11.5px;
  color: var(--ink-3);
}
.preview {
  width: 100%;
  height: 62vh;
  border: 0;
  background: #fff;
}
</style>
