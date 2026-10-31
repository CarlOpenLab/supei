<script setup lang="ts">
import { onMounted } from 'vue'
import { ConfigProvider, theme } from 'antdv-next'
import zhCN from 'antdv-next/locale/zh_CN'
import { autoLoadDesktopPlugins, watchDesktopPluginDir } from '@/services/desktop'

onMounted(() => {
  autoLoadDesktopPlugins()
  watchDesktopPluginDir()
})

const themeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#1677ff',
    colorInfo: '#1677ff',
    colorBgBase: '#0d0d0d',
    colorBgContainer: '#161616',
    colorBgElevated: '#1c1c1c',
    colorBorder: 'rgba(255, 255, 255, 0.09)',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.06)',
    colorText: 'rgba(255, 255, 255, 0.95)',
    colorTextSecondary: 'rgba(255, 255, 255, 0.6)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.38)',
    borderRadius: 8,
    fontFamily:
      '\'Inter\', -apple-system, \'SF Pro Text\', \'PingFang SC\', \'Microsoft YaHei\', \'Segoe UI\', sans-serif',
  },
}
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <RouterView />
  </ConfigProvider>
</template>
