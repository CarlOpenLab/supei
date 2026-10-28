<script setup lang="ts">
import { onMounted } from 'vue'
import { ConfigProvider, theme } from 'antdv-next'
import zhCN from 'antdv-next/locale/zh_CN'
import { autoLoadDesktopPlugins } from '@/services/desktop'

onMounted(() => {
  autoLoadDesktopPlugins()
})

const themeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#ff6b47',
    colorInfo: '#ff6b47',
    colorBgBase: '#0d0f11',
    colorBgContainer: '#15171b',
    colorBgElevated: '#1b1e23',
    colorBorder: 'rgba(255, 255, 255, 0.09)',
    colorBorderSecondary: 'rgba(255, 255, 255, 0.06)',
    colorText: 'rgba(255, 255, 255, 0.92)',
    colorTextSecondary: 'rgba(255, 255, 255, 0.6)',
    colorTextTertiary: 'rgba(255, 255, 255, 0.38)',
    borderRadius: 8,
    fontFamily:
      '-apple-system, \'SF Pro Text\', \'PingFang SC\', \'Microsoft YaHei\', \'Segoe UI\', sans-serif',
  },
}
</script>

<template>
  <ConfigProvider :locale="zhCN" :theme="themeConfig">
    <RouterView />
  </ConfigProvider>
</template>
