import { defineStore } from 'pinia'
import type { Artboard } from '@/types'
import type { DevEvent } from '@/services/mygo-client'
import { consumeChannel, requireDesktopBridge } from '@/services/desktop'
import { BRIDGE_SCRIPT } from '@/bridge/bridge'
import { useWorkspaceStore } from './workspace'

/** 实时画板的运行态（不落盘）：dev server / 代理进程的状态与日志 */
export interface LiveSession {
  status: 'starting' | 'ready' | 'error' | 'stopped'
  /** 注入代理的源（http://127.0.0.1:port），就绪后才有 */
  proxyOrigin: string | null
  /** 被代理的真实源（dev server 或网站），捕获时用来还原资源地址 */
  targetOrigin: string | null
  /** iframe 打开的路由；页面内 SPA 导航只同步地址栏，不改它（否则会整页重载） */
  navRoute: string
  logs: string[]
  error: string | null
}

const MAX_LOGS = 400
/** 每个会话的中止器：中止即关闭 Channel，Go 侧随之停掉 dev server 与代理 */
const controllers = new Map<string, AbortController>()

export const useLiveStore = defineStore('live', {
  state: () => ({
    sessions: {} as Record<string, LiveSession>,
  }),
  actions: {
    /**
     * @description 启动实时画板：repo 类型运行 dev server，web 类型只起注入代理；立即返回，状态写入 sessions。
     * 按 id 取 store 里的响应式画板（新建时拿到的是原始对象，直接改它界面不会更新）。
     * @param boardId - 实时画板 id
     */
    start(boardId: string) {
      const ws = useWorkspaceStore()
      const board = ws.findArtboard(boardId)
      const live = board?.live
      if (!board || !live || controllers.has(board.id)) return
      const ac = new AbortController()
      controllers.set(board.id, ac)
      this.sessions[board.id] = {
        status: 'starting',
        proxyOrigin: null,
        targetOrigin: null,
        navRoute: live.route || '/',
        logs: [],
        error: null,
      }
      const s = this.sessions[board.id]

      void (async () => {
        try {
          const bridge = await requireDesktopBridge('实时预览')
          const { Channel } = await import('mygo-runtime')
          const ch = new Channel<DevEvent>()
          const done =
            live.type === 'repo'
              ? bridge.DevServer.start(
                  {
                    dir: live.repoDir!,
                    script: live.script!,
                    packageManager: live.packageManager!,
                    bridgeScript: BRIDGE_SCRIPT,
                  },
                  ch,
                )
              : bridge.DevServer.proxy(live.url, BRIDGE_SCRIPT, ch)
          for await (const ev of consumeChannel(ch, done, ac.signal)) {
            if (ev.type === 'log') {
              s.logs.push(ev.text ?? '')
              if (s.logs.length > MAX_LOGS) s.logs.splice(0, s.logs.length - MAX_LOGS)
            } else if (ev.type === 'ready') {
              const target = new URL(ev.target!)
              s.proxyOrigin = new URL(ev.url!).origin
              s.targetOrigin = target.origin
              // web：记住重定向后的最终地址，下次直接打开；repo：首次就绪时记录 dev server 地址与基础路径
              if (live.type === 'web' || !live.url) {
                if (!live.url && live.route === '/' && target.pathname !== '/') {
                  live.route = target.pathname
                  s.navRoute = live.route
                }
                live.url = target.href
                await ws.persistArtboard(board.id)
              }
              s.status = 'ready'
            }
          }
          s.status = 'stopped'
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            s.status = 'stopped'
          } else {
            s.status = 'error'
            s.error = (err as Error).message
          }
        } finally {
          controllers.delete(board.id)
          s.proxyOrigin = null
        }
      })()
    },

    /**
     * @description 停止实时画板的 dev server / 代理。
     * @param boardId - 画板 id
     */
    stop(boardId: string) {
      controllers.get(boardId)?.abort()
    },

    /**
     * @description 地址栏跳转：更新 iframe 路由并记住它（下次启动直接打开）。
     * @param board - 实时画板
     * @param route - 以 / 开头的路由
     */
    async navigate(board: Artboard, route: string) {
      if (!board.live) return
      board.live.route = route
      const s = this.sessions[board.id]
      if (s) s.navRoute = route
      await useWorkspaceStore().persistArtboard(board.id)
    },

    /**
     * @description 页面内 SPA 导航后同步当前路由（只记录，不重载 iframe）。
     * @param board - 实时画板
     * @param route - 页面上报的 path + query + hash
     */
    async syncRoute(board: Artboard, route: string) {
      if (!board.live || board.live.route === route) return
      board.live.route = route
      await useWorkspaceStore().persistArtboard(board.id)
    },
  },
})
