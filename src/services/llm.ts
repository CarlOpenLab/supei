import type { getDesktopBridge } from './desktop'

export interface StreamChatOptions {
  baseURL: string
  apiKey: string
  model: string
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  signal?: AbortSignal
  temperature?: number
  /** 思考档位（high/medium/low）；服务端不支持时通常被忽略 */
  reasoningEffort?: string
}

/** 调用 OpenAI 兼容的 /chat/completions 接口，流式产出文本增量。
 *  桌面壳（mygo）里走 Go 侧代理（无 CORS 限制），浏览器里直连。 */
export async function* streamChat(opts: StreamChatOptions): AsyncGenerator<string> {
  const { getDesktopBridge } = await import('./desktop')
  const bridge = await getDesktopBridge()
  if (bridge) {
    try {
      yield* streamChatDesktop(bridge, opts)
      return
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      // 桥接失效（如普通浏览器打开 mygo dev 页面：注入的运行时时有时无）
      // → 自动降级为浏览器直连，不让用户看到 "runtime not found"
      if (!/runtime not found/.test((err as Error).message)) throw err
    }
  }
  yield* streamChatBrowser(opts)
}

/** 桌面壳：经 mygo 绑定调用 Go 侧流式代理。 */
async function* streamChatDesktop(
  bridge: NonNullable<Awaited<ReturnType<typeof getDesktopBridge>>>,
  opts: StreamChatOptions,
): AsyncGenerator<string> {
  const { Channel } = await import('mygo-runtime')
  const ch = new Channel<{ delta?: string; err?: string }>()
  const done = bridge.LLM.stream(
    {
      baseURL: opts.baseURL,
      apiKey: opts.apiKey,
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
      reasoningEffort: opts.reasoningEffort,
    },
    ch,
  )
  try {
    for await (const d of ch) {
      if (d.err) throw new Error(d.err)
      if (d.delta) yield d.delta
    }
    await done
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error((err as Error).message || '桌面模型代理调用失败')
  }
  await done
}

/** 浏览器：fetch 直连（受 CORS 约束）。 */
async function* streamChatBrowser(opts: StreamChatOptions): AsyncGenerator<string> {
  if (!opts.baseURL) {
    throw new Error('未配置模型服务地址。请到「设置 → 模型设置」检查服务商的 baseURL 字段。')
  }
  const url = opts.baseURL.replace(/\/+$/, '') + '/chat/completions'
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
        temperature: opts.temperature ?? 0.7,
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      }),
      signal: opts.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new Error(
      '无法连接到模型服务。请检查网络、baseURL 是否正确；若服务商不允许浏览器直连（CORS），可在设置中换用支持直连的服务商。',
    )
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`模型服务返回 ${res.status}：${text.slice(0, 300) || res.statusText}`)
  }
  if (!res.body) throw new Error('模型服务未返回流式响应体')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          const json = JSON.parse(data)
          const delta: string = json.choices?.[0]?.delta?.content ?? ''
          if (delta) yield delta
        } catch {
          // 忽略无法解析的心跳/注释行
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
