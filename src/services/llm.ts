import type { ProviderConfig } from '@/types'
import type { AgentEvent } from './mygo-client'
import type { MygoBridge } from './desktop'

export type LLMMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface StreamChatOptions {
  baseURL: string
  apiKey: string
  model: string
  messages: LLMMessage[]
  signal?: AbortSignal
  temperature?: number
  /** 思考档位（high/medium/low）；服务端不支持时通常被忽略 */
  reasoningEffort?: string
}

export type AgentKind = 'claude-code' | 'codex'

/**
 * @description 判断服务商是否为本机 Agent CLI（Claude Code / Codex）。
 * @param p - 服务商配置
 * @returns 是 Agent 时为 true，并把 p.kind 收窄为 AgentKind
 */
export function isAgentProvider(p: ProviderConfig): p is ProviderConfig & { kind: AgentKind } {
  return p.kind === 'claude-code' || p.kind === 'codex'
}

export interface CompletionOptions {
  messages: LLMMessage[]
  signal?: AbortSignal
  temperature?: number
  reasoningEffort?: string
}

/**
 * @description 统一的文本生成入口，生成/规划/风格顾问都经由这里：OpenAI 兼容服务商走 streamChat；
 * 本机 Agent 走 streamAgent 的 design 模式（无工具、空目录），把多轮消息压平成单段 prompt。
 * @param provider - 当前服务商（非演示模式）
 * @param opts - 消息、中止信号与采样参数（Agent 不支持 temperature / reasoningEffort，忽略）
 * @returns 流式产出文本增量
 */
export async function* streamCompletion(
  provider: ProviderConfig,
  opts: CompletionOptions,
): AsyncGenerator<string> {
  if (!isAgentProvider(provider)) {
    yield* streamChat({ baseURL: provider.baseURL, apiKey: provider.apiKey, model: provider.model, ...opts })
    return
  }
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content)
  const turns = opts.messages.filter((m) => m.role !== 'system')
  const prompt =
    turns.length === 1
      ? turns[0].content
      : turns.map((m) => `【${m.role === 'user' ? '用户' : '助手'}】\n${m.content}`).join('\n\n')
  yield* streamAgent({
    kind: provider.kind,
    model: provider.model,
    mode: 'design',
    systemPrompt: system.join('\n\n'),
    prompt,
    signal: opts.signal,
  })
}

export interface AgentStreamOptions {
  kind: AgentKind
  /** 留空用 CLI 自身默认模型 */
  model?: string
  /** design：纯文本生成；code：在 cwd 仓库内读写代码 */
  mode: 'design' | 'code'
  cwd?: string
  systemPrompt?: string
  prompt: string
  signal?: AbortSignal
  /** 工具调用 / 提示日志（code 模式用来展示 Agent 进度） */
  onEvent?: (e: AgentEvent) => void
}

/**
 * @description 在桌面端运行本机 Agent CLI，只产出回答文本，工具调用与日志经 onEvent 上报。
 * 中止时关闭 Channel，Go 侧随之杀掉 CLI 进程树。
 * @param opts - Agent 类型、模式、提示词与回调
 * @returns 流式产出 Agent 的回答文本
 */
export async function* streamAgent(opts: AgentStreamOptions): AsyncGenerator<string> {
  const { requireDesktopBridge, consumeChannel } = await import('./desktop')
  const bridge = await requireDesktopBridge('本机 Agent')
  const { Channel } = await import('mygo-runtime')
  const ch = new Channel<AgentEvent>()
  const done = bridge.Agent.run(
    {
      kind: opts.kind,
      model: opts.model || undefined,
      mode: opts.mode,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      prompt: opts.prompt,
    },
    ch,
  )
  for await (const ev of consumeChannel(ch, done, opts.signal)) {
    if (ev.type === 'text') yield ev.text
    else opts.onEvent?.(ev)
  }
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

/**
 * @description 桌面壳：经 mygo 绑定调用 Go 侧流式代理；中止时关闭 Channel 让 Go 侧取消 HTTP 请求。
 * @param bridge - 已加载的 mygo 桥接
 * @param opts - 请求参数
 * @returns 流式产出文本增量
 */
async function* streamChatDesktop(bridge: MygoBridge, opts: StreamChatOptions): AsyncGenerator<string> {
  const { consumeChannel } = await import('./desktop')
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
  for await (const d of consumeChannel(ch, done, opts.signal)) {
    if (d.err) throw new Error(d.err)
    if (d.delta) yield d.delta
  }
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
