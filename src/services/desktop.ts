/**
 * 桌面环境（mygo 壳）检测与原生能力桥接。
 * mygo dev / mygo build 都以 --mode desktop 运行 Vite，
 * 浏览器直接访问时 MODE 保持默认，走纯 Web 路径。
 */

import { ref } from 'vue'

export const IS_DESKTOP = import.meta.env.MODE === 'desktop'

export type MygoBridge = {
  LLM: typeof import('./mygo-client').LLMService
  Storage: typeof import('./mygo-client').StorageService
  Agent: typeof import('./mygo-client').AgentService
  DevServer: typeof import('./mygo-client').DevServerService
  Share: typeof import('./mygo-client').ShareService
  Sys: typeof import('./mygo-client').SysService
}

/** 桌面桥接是否真实可用（Web 版恒为 false）。UI 据此显示 Agent / 仓库预览 / 分享等桌面专属入口。 */
export const desktopAvailable = ref(false)

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
        desktopAvailable.value = true
        return {
          LLM: client.LLMService,
          Storage: client.StorageService,
          Agent: client.AgentService,
          DevServer: client.DevServerService,
          Share: client.ShareService,
          Sys: client.SysService,
        }
      })
      .catch((err) => {
        console.error('[desktop] mygo 桥接加载失败，回退浏览器路径', err)
        return null
      })
  }
  return bridgePromise
}

/**
 * @description 取桌面桥接，不可用时抛错。用于只在桌面端出现入口的功能（Agent 写回代码、仓库预览、分享），
 * 入口已按 desktopAvailable 隐藏，走到这里仍不可用说明运行环境异常，应明确报错而不是静默降级。
 * @param feature - 功能名，拼入错误提示
 * @returns 已加载的 mygo 桥接
 */
export async function requireDesktopBridge(feature: string): Promise<MygoBridge> {
  const bridge = await getDesktopBridge()
  if (!bridge) throw new Error(`「${feature}」仅在桌面端可用，请使用桌面版（desktop/ 下 go tool mygo dev）。`)
  return bridge
}

/**
 * @description 消费 Go 方法的 Channel：signal 中止时关闭 Channel（Go 侧 ctx 取消、请求或子进程随之终止）并抛出 AbortError，
 * 与浏览器 fetch 的中止语义保持一致，调用方统一按 err.name === 'AbortError' 判断。
 * @param ch - 已传给 Go 方法的 Channel
 * @param done - Go 方法调用返回的 Promise，Go 侧返回 error 时 reject
 * @param signal - 可选的中止信号
 * @returns 按顺序产出 Channel 中的每个值；Go 方法出错时抛出其错误
 */
export async function* consumeChannel<T>(
  ch: import('mygo-runtime').Channel<T>,
  done: Promise<void>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const onAbort = () => ch.close()
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for await (const v of ch) yield v
    if (signal?.aborted) {
      done.catch(() => {}) // 关闭 Channel 后 Go 侧以 ctx canceled 返回，属预期
      throw new DOMException('已停止', 'AbortError')
    }
    await done
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 解析并注入插件文件：同名跳过，单个文件损坏不影响其余。 */
async function importPluginFiles(
  files: Array<{ content: string; name: string }>,
  log: (name: string) => void,
): Promise<void> {
  const { pluginRegistry, parsePluginFile } = await import('@/plugins/registry')
  for (const f of files) {
    try {
      for (const entry of parsePluginFile(f.content, f.name)) {
        if (pluginRegistry.list().some((p) => p.name === entry.name)) continue
        pluginRegistry.addUserPlugin({ kind: entry.kind, name: entry.name, data: entry.data })
        log(entry.name)
      }
    } catch {
      /* 单个文件损坏不影响其余 */
    }
  }
}

/** 桌面端启动时：自动加载用户插件目录（~/.config/ai-design-canvas/plugins）下的插件包。 */
export async function autoLoadDesktopPlugins(): Promise<void> {
  const bridge = await getDesktopBridge()
  if (!bridge) return
  try {
    const files = await bridge.Storage.readPluginDir()
    if (files?.length) await importPluginFiles(files, (name) => console.info('[plugins] 自动加载', name))
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
        // 目录内容变化 → 重新全量加载（去重，同名跳过）
        const files = await bridge.Storage.readPluginDir()
        if (files?.length) {
          await importPluginFiles(files, (name) => console.info('[plugins] 热加载', name, '←', changedPath))
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
