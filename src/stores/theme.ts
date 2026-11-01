import { defineStore } from 'pinia'

export type ThemeMode = 'dark' | 'light'

const LS_KEY = 'dc.theme.v1'

/** 读取已保存的主题；未保存过时保持暗色（应用原本的外观）。 */
function storedMode(): ThemeMode {
  try {
    return localStorage.getItem(LS_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * @description 把主题写到 <html> 上：CSS 变量、滚动条与原生表单控件一起切换。
 * @param mode - 主题模式
 */
export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement
  root.dataset.theme = mode
  root.style.colorScheme = mode
}

export const useThemeStore = defineStore('theme', {
  state: () => ({
    mode: 'dark' as ThemeMode,
  }),
  getters: {
    isDark: (state) => state.mode === 'dark',
  },
  actions: {
    load() {
      this.mode = storedMode()
      applyTheme(this.mode)
    },
    set(mode: ThemeMode) {
      this.mode = mode
      applyTheme(mode)
      try {
        localStorage.setItem(LS_KEY, mode)
      } catch {
        /* 隐私模式下写入失败时仅本会话生效 */
      }
    },
    toggle() {
      this.set(this.mode === 'dark' ? 'light' : 'dark')
    },
  },
})
