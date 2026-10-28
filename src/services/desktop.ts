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

/** 桌面模式下加载 mygo 生成的绑定；浏览器返回 null。 */
export function getDesktopBridge(): Promise<MygoBridge | null> {
  if (!IS_DESKTOP) return Promise.resolve(null)
  if (!bridgePromise) {
    bridgePromise = Promise.all([
      import('mygo-runtime'),
      import('./mygo-client'),
    ])
      .then(([, client]) => ({ LLM: client.LLMService, Storage: client.StorageService }))
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
