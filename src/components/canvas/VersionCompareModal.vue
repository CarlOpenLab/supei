<script setup lang="ts">
import { computed } from 'vue'
import { Modal } from 'antdv-next'
import type { Artboard } from '@/types'

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
</script>

<template>
  <Modal
    :open="props.open"
    :title="`版本对比 — ${props.board?.title ?? ''}`"
    width="88vw"
    :footer="null"
    @cancel="emit('update:open', false)"
  >
    <div class="compare">
      <div class="pane">
        <div class="pane-head">
          <span class="ver">{{ labelA }}</span>
          <span class="pane-note">上一版</span>
        </div>
        <iframe class="preview" :srcdoc="htmlA" sandbox="allow-same-origin" />
      </div>
      <div class="pane">
        <div class="pane-head">
          <span class="ver accent">{{ labelB }}</span>
          <span class="pane-note">当前版</span>
        </div>
        <iframe class="preview" :srcdoc="htmlB" sandbox="allow-same-origin" />
      </div>
    </div>
  </Modal>
</template>

<style scoped>
.compare {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pane {
  border: 1px solid var(--line);
  border-radius: var(--radius-m);
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
  background: var(--active);
  padding: 2px 8px;
  border-radius: 5px;
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
