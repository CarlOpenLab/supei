<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { ConfigProvider, theme } from 'antdv-next'
import zhCN from 'antdv-next/locale/zh_CN'
import { autoLoadDesktopPlugins, watchDesktopPluginDir } from '@/services/desktop'
import { useThemeStore } from '@/stores/theme'

const themeStore = useThemeStore()

onMounted(() => {
  autoLoadDesktopPlugins()
  watchDesktopPluginDir()
})

const themeConfig = computed(() => {
  const light = !themeStore.isDark
  return {
    algorithm: light ? theme.defaultAlgorithm : theme.darkAlgorithm,
    token: {
      colorPrimary: '#1677ff',
      colorInfo: '#1677ff',
      colorBgBase: light ? '#f3f3f5' : '#0d0d0d',
      colorBgContainer: light ? '#ffffff' : '#161616',
      colorBgElevated: light ? '#ffffff' : '#1c1c1c',
      colorBorder: light ? 'rgba(17, 17, 20, 0.12)' : 'rgba(255, 255, 255, 0.09)',
      colorBorderSecondary: light ? 'rgba(17, 17, 20, 0.08)' : 'rgba(255, 255, 255, 0.06)',
      colorText: light ? 'rgba(17, 17, 20, 0.92)' : 'rgba(255, 255, 255, 0.95)',
      colorTextSecondary: light ? 'rgba(17, 17, 20, 0.62)' : 'rgba(255, 255, 255, 0.6)',
      colorTextTertiary: light ? 'rgba(17, 17, 20, 0.4)' : 'rgba(255, 255, 255, 0.38)',
      borderRadius: 8,
      fontFamily:
        '\'Inter\', -apple-system, \'SF Pro Text\', \'PingFang SC\', \'Microsoft YaHei\', \'Segoe UI\', sans-serif',
    },
  }
})
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <RouterView />
  </ConfigProvider>
</template>
