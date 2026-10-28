import { defineStore } from 'pinia'
import type { ProviderConfig } from '@/types'
import { uid } from '@/utils/id'

export const DEMO_PROVIDER: ProviderConfig = {
  id: 'demo',
  name: '内置演示（无需 Key）',
  baseURL: '',
  apiKey: '',
  model: 'demo',
}

const LS_KEY = 'dc.settings.v1'
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    providers: [DEMO_PROVIDER] as ProviderConfig[],
    activeId: 'demo',
  }),
  getters: {
    active(state): ProviderConfig {
      return state.providers.find((p) => p.id === state.activeId) ?? DEMO_PROVIDER
    },
    isDemo(state): boolean {
      return state.activeId === 'demo'
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
        }
        const providers = data.providers?.filter((p) => p.id !== DEMO_PROVIDER.id) ?? []
        this.providers = [DEMO_PROVIDER, ...providers]
        this.activeId = data.activeId ?? 'demo'
      } catch {
        /* 设置损坏时回退默认 */
      }
    },
    save() {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          providers: this.providers.filter((p) => p.id !== DEMO_PROVIDER.id),
          activeId: this.activeId,
        }),
      )
    },

  },
})
