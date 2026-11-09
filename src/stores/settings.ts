import { defineStore } from 'pinia'
import type { ProviderConfig } from '@/types'

const LS_KEY = 'dc.settings.v1'
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    providers: [] as ProviderConfig[],
    /** 未配置 / 未选择时为空串，UI 用 placeholder 引导去设置 */
    activeId: '',
    /** 生成完成后的模型自评（critique gate）；默认开启，开关在设置弹窗 */
    critique: true,
  }),
  getters: {
    active(state): ProviderConfig | null {
      return state.providers.find((p) => p.id === state.activeId) ?? null
    },
  },
  actions: {
    load() {
      try {
        const raw = localStorage.getItem(LS_KEY)
        if (!raw) return
        const data = JSON.parse(raw) as {
          providers?: ProviderConfig[]
          activeId?: string
          critique?: boolean
        }
        // 兼容旧配置：丢弃内置演示服务商，未配置时保持为空
        this.providers = (data.providers ?? []).filter((p) => p.id !== 'demo')
        this.activeId = this.providers.some((p) => p.id === data.activeId) ? data.activeId! : ''
        if (data.critique !== undefined) this.critique = data.critique
      } catch {
        /* 设置损坏时回退默认 */
      }
    },
    save() {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          providers: this.providers,
          activeId: this.activeId,
          critique: this.critique,
        }),
      )
    },
  },
})
