<script setup lang="ts">
import { computed } from 'vue'
import { useThemeStore } from '@/stores/theme'
import AppIcon from './AppIcon.vue'

const themeStore = useThemeStore()

const label = computed(() => (themeStore.isDark ? '切换到白天模式' : '切换到暗黑模式'))
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :title="label"
    :aria-label="label"
    @click="themeStore.toggle()"
  >
    <AppIcon :name="themeStore.isDark ? 'sun' : 'moon'" :size="14" />
  </button>
</template>

<style scoped>
.theme-toggle {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-m);
  background: var(--btn-quiet-bg);
  box-shadow: var(--btn-quiet-shadow);
  color: var(--ink-2);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.theme-toggle:hover {
  background: var(--bg-raised);
  color: var(--ink);
}
.theme-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
