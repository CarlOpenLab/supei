<script setup lang="ts">
/**
 * 极简线性图标（stroke 1.5px, currentColor）。
 * 内置集合 + 通过插件注册表注入的 icon 插件扩展。
 */
import { computed } from 'vue'
import { pluginRegistry } from '@/plugins/registry'

const props = withDefaults(defineProps<{ name: string; size?: number }>(), {
  size: 15,
})

const BUILTIN_PATHS: Record<string, string> = {
  'arrow-left': 'M19 12H5M11 18l-6-6 6-6',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.5-2-3.5-2.4 1a7.4 7.4 0 0 0-2-1.2L14.5 3h-5L9 5.6a7.4 7.4 0 0 0-2 1.2l-2.4-1-2 3.5 2 1.5a7.4 7.4 0 0 0 0 2.4l-2 1.5 2 3.5 2.4-1a7.4 7.4 0 0 0 2 1.2L9.5 21h5l.4-2.6a7.4 7.4 0 0 0 2-1.2l2.4 1 2-3.5-2-1.5c.1-.4.1-.8.1-1.2Z',
  cursor: 'M4 4l7.5 16 2.2-6.3L20 11.5 4 4Z',
  frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  share: 'M12 15V3m0 0L8 7m4-4 4 4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  copy: 'M9 9h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2V9Zm-4 8H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v1',
  duplicate: 'M8 8h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10Zm-2 8H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3',
  'zoom-out': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.8-4.8M8 11h6',
  'zoom-in': 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-4.8-4.8M8 11h6M11 8v6',
  fit: 'M9 3H5a2 2 0 0 0-2 2v4m12-6h4a2 2 0 0 1 2 2v4M9 21H5a2 2 0 0 1-2-2v-4m12 6h4a2 2 0 0 0 2-2v-4',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3ZM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16Z',
  pencil: 'M17 3l4 4L8 20l-5 1 1-5L17 3Z',
  desktop: 'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm6 16h6m-3-4v4',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  stop: 'M7 7h10v10H7z',
  send: 'M4 12l16-8-6 8 6 8-16-8Z',
  dots: 'M6 12h.01M12 12h.01M18 12h.01',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 1 0 18ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
  chevron: 'M9 6l6 6-6 6',
  code: 'M8 8l-5 4 5 4M16 8l5 4-5 4',
}

// 图标插件注入的扩展图标（kind: 'icon'）
const PLUGIN_PATHS = pluginRegistry
  .listByKind('icon')
  .reduce<Record<string, string>>((acc, p) => ({ ...acc, ...(p.data as Record<string, string>) }), {})

const d = computed(() => PLUGIN_PATHS[props.name] ?? BUILTIN_PATHS[props.name] ?? '')
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-if="d" :d="d" />
  </svg>
</template>
