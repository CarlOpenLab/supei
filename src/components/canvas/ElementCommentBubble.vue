<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Button, TextArea } from 'antdv-next'
import type { ElementContext } from '@/types'

const props = defineProps<{
  ctx: ElementContext
  artboardWidth: number
}>()

const emit = defineEmits<{
  (e: 'submit', text: string): void
  (e: 'cancel'): void
}>()

const text = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)

// 点选后一键发送的常用指令
const QUICK_CHIPS: Array<{ label: string; prompt: string }> = [
  { label: '更醒目', prompt: '让这个元素更醒目：加大视觉重量与对比，但不要改变整体布局' },
  { label: '更紧凑', prompt: '让这个元素更紧凑：减小内边距与字号，保持可读性' },
  { label: '加圆角', prompt: '给这个元素加明显的圆角' },
  { label: '加阴影', prompt: '给这个元素加一层柔和投影，提升层次感' },
  { label: '换强调色', prompt: '为这个元素换一个更合适的强调色，页面其余部分不动' },
  { label: '整体换配色', prompt: '整体换一套更高级的配色方案，保持布局与内容不变' },
]

function submitChip(prompt: string) {
  emit('submit', prompt)
}

watch(
  () => props.ctx,
  () => {
    text.value = ''
    nextTick(() => {
      inputRef.value?.querySelector('textarea')?.focus()
    })
  },
  { immediate: true },
)

function submit() {
  if (!text.value.trim()) return
  emit('submit', text.value)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('cancel')
  }
}

// 气泡跟随元素位置，横向做简单钳制避免溢出画板
const bubbleStyle = computed(() => {
  const half = 150
  const cx = props.ctx.rect.x + props.ctx.rect.width / 2
  const clampedX = Math.min(Math.max(cx, half), Math.max(half, props.artboardWidth - half))
  const top = Math.max(4, props.ctx.rect.y - 10)
  return {
    left: `${clampedX}px`,
    top: `${top}px`,
    transform: 'translate(-50%, -100%)',
  }
})
</script>

<template>
  <div class="comment-bubble" :style="bubbleStyle" @pointerdown.stop @wheel.stop>
    <div class="target-chip">
      <code>{{ ctx.tag }}{{ ctx.classes.length ? '.' + ctx.classes.join('.') : '' }}</code>
      <span v-if="ctx.text" class="chip-text">{{ ctx.text }}</span>
    </div>
    <div class="quick-chips">
      <button v-for="c in QUICK_CHIPS" :key="c.label" class="qchip" @click="submitChip(c.prompt)">
        {{ c.label }}
      </button>
    </div>
    <TextArea
      ref="inputRef"
      v-model:value="text"
      :auto-size="{ minRows: 2, maxRows: 5 }"
      placeholder="告诉 AI 这里要怎么改（Enter 发送）"
      @keydown="onKeydown"
    />
    <div class="bubble-actions">
      <span v-if="!text.trim()" class="hint">Esc 取消</span>
      <Button size="small" @click="emit('cancel')">取消</Button>
      <Button size="small" type="primary" :disabled="!text.trim()" @click="submit">发送</Button>
    </div>
  </div>
</template>

<style scoped>
.comment-bubble {
  position: absolute;
  width: 300px;
  background: rgba(22, 22, 22, 0.92);
  backdrop-filter: blur(10px);
  border-radius: 12px;
  border: none;
  box-shadow:
    inset 0 0 0 1px rgba(255, 255, 255, 0.09),
    0 16px 48px rgba(0, 0, 0, 0.55);
  padding: 10px;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.target-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.target-chip code {
  background: rgba(22, 119, 255, 0.16);
  color: var(--accent);
  border: none;
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}
.chip-text {
  font-size: 12px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.quick-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.qchip {
  border: none;
  box-shadow: var(--btn-quiet-shadow);
  background: transparent;
  color: var(--ink-2);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.12s;
  font-family: var(--sans);
}
.qchip:hover {
  color: var(--accent);
  background: var(--accent-soft);
  box-shadow: inset 0 0 0 1px rgba(22, 119, 255, 0.35);
}
.bubble-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.hint {
  margin-right: auto;
  font-size: 11px;
  color: var(--ink-3);
}
</style>
