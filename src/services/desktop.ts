/**
 * 桌面环境（mygo 壳）检测与原生能力桥接。
 * mygo dev / mygo build 都以 --mode desktop 运行 Vite，
 * 浏览器直接访问时 MODE 保持默认，走纯 Web 路径。
 */

export const IS_DESKTOP = import.meta.env.MODE === 'desktop'

type MygoBridge = {
  LLM: typeof import('./mygo-client').LLMService
  Storage: typeof import('./mygo-client').StorageService
}

let bridgePromise: Promise<MygoBridge | null> | null = null

/** 桌面模式下加载 mygo 生成的绑定；浏览器或无 Go 运行时（普通标签页打开 mygo dev 页面）返回 null。 */
export function getDesktopBridge(): Promise<MygoBridge | null> {
  if (!IS_DESKTOP) return Promise.resolve(null)
  if (!bridgePromise) {
    bridgePromise = Promise.all([
      import('mygo-runtime'),
      import('./mygo-client'),
    ])
      .then(([rt, client]) => {
        // 运行时真实探测：mygo dev 页面在普通浏览器里打开时 MODE=desktop
        // 但没有 Go 运行时，必须回退纯 Web 路径（fetch 直连），否则报
        // "mygo: runtime not found"
        if (!rt.isMyGo()) return null
        return { LLM: client.LLMService, Storage: client.StorageService }
      })
      .catch((err) => {
        console.error('[desktop] mygo 桥接加载失败，回退浏览器路径', err)
        return null
      })
  }
  return bridgePromise
}

/** 桌面端启动时：自动加载用户插件目录（~/.config/ai-design-canvas/plugins）下的插件包。 */
export async function autoLoadDesktopPlugins(): Promise<void> {
  const bridge = await getDesktopBridge()
  if (!bridge) return
  try {
    const files = await bridge.Storage.readPluginDir()
    if (!files?.length) return
    const { pluginRegistry, parsePluginFile } = await import('@/plugins/registry')
    for (const f of files) {
      try {
        const entries = parsePluginFile(f.content, f.name)
        for (const entry of entries) {
          if (pluginRegistry.list().some((p) => p.name === entry.name)) continue
          pluginRegistry.addUserPlugin({ kind: entry.kind, name: entry.name, data: entry.data })
          console.info('[plugins] 自动加载', entry.name)
        }
      } catch {
        /* 单个文件损坏不影响其余 */
      }
    }
  } catch {
    /* 目录不可读时静默跳过 */
  }
}

/** 桌面端：监听插件目录变化，热重载插件（丢文件进目录即生效）。 */
export async function watchDesktopPluginDir(): Promise<void> {
  const bridge = await getDesktopBridge()
  if (!bridge) return
  try {
    const { Channel } = await import('mygo-runtime')
    const ch = new Channel<string>()
    const done = bridge.Storage.watchPluginDir(ch)
    for await (const changedPath of ch) {
      try {
        const { pluginRegistry, parsePluginFile } = await import('@/plugins/registry')
        // 目录内容变化 → 重新全量加载（去重，同名跳过）
        const { Storage } = bridge
        const files = await Storage.readPluginDir()
        if (!files?.length) continue
        for (const f of files) {
          const entries = parsePluginFile(f.content, f.name)
          for (const entry of entries) {
            if (pluginRegistry.list().some((p) => p.name === entry.name)) continue
            pluginRegistry.addUserPlugin({ kind: entry.kind, name: entry.name, data: entry.data })
            console.info('[plugins] 热加载', entry.name, '←', changedPath)
          }
        }
      } catch (e) {
        console.warn('[plugins] 热加载失败', e)
      }
    }
    void done
  } catch (e) {
    console.warn('[plugins] 目录监听不可用', e)
  }
}
