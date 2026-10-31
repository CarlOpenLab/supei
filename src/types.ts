export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
}

export interface Version {
  id: string
  html: string
  createdAt: number
  /** 产生该版本的用户消息 id，可溯源 */
  sourceMessageId?: string
}

export interface ElementRect {
  x: number
  y: number
  width: number
  height: number
}

/** 由 iframe 内 bridge 上报的选中元素上下文 */
export interface ElementContext {
  selector: string
  tag: string
  classes: string[]
  text?: string
  outerHTML: string
  rect: ElementRect
}

/** 画板内点选工具：comment = 点选元素给 AI 定向反馈；edit = 检查器手动编辑 + 测量 */
export type FrameTool = 'comment' | 'edit' | null

/** 编辑模式下由 bridge 上报的选中元素：计算样式 + 稳定编号 */
export interface InspectMeta {
  /** 源 HTML 中的稳定编号（data-dc-id）；null = 运行时脚本生成或实时页面元素，不可直接编辑 */
  dcId: string | null
  selector: string
  tag: string
  classes: string[]
  /** 纯文本叶子元素的文字；非叶子为 null（不提供改字） */
  text: string | null
  rect: ElementRect
  /** 计算样式（CSS 属性名 → 计算值） */
  styles: Record<string, string>
}

/** 单个元素的待保存手动修改：内联样式覆盖 + 可选文字 */
export interface ElementEdit {
  styles: Record<string, string>
  text?: string
}

export type ChatRole = 'user' | 'assistant'

/** AI 规划卡：对话流里的澄清问题与风格方案，用户点选后才开始生成 */
export interface PlanQuestion {
  id: string
  q: string
  options: string[]
}

export interface PlanStyle {
  /** 风格名，如「墨绿期刊」 */
  name: string
  /** 一句话说明这个方向的气质 */
  desc: string
  /** 完整风格指令，生成时直接拼入 system prompt */
  directive: string
}

export interface PlanPayload {
  title?: string
  questions: PlanQuestion[]
  styles: PlanStyle[]
  /** 迭代确认卡：AI 拆解的修改项清单 */
  items?: string[]
  /** 迭代确认卡标记 */
  iteration?: boolean
  /** 信息展示卡（多方案方向）：不可点选 */
  info?: boolean
}

export interface ChatMessage {
  id: string
  projectId: string
  /** 关联画板；null 表示当时新建 */
  artboardId: string | null
  role: ChatRole
  content: string
  elementContext?: ElementContext | null
  versionId?: string | null
  status: 'ok' | 'error' | 'aborted'
  /** assistant 消息可携带交互卡（规划：澄清问题 + 风格方案） */
  plan?: PlanPayload | null
  createdAt: number
}

/** 实时画板的来源：本地仓库的 dev server，或任意网址（都经桌面端 Go 注入代理加载） */
export interface LiveSource {
  type: 'repo' | 'web'
  /** repo：仓库目录 / 启动脚本 / 包管理器 */
  repoDir?: string
  script?: string
  packageManager?: string
  /** web：目标网址；repo：dev server 就绪时打印的地址 */
  url: string
  /** 当前页面路由（path + query + hash），地址栏可改 */
  route: string
}

/** 捕获来源：从实时画板捕获的设计稿，首个版本即捕获基线，「写回代码」据此计算设计改动 */
export interface CaptureSource {
  /** 捕获自哪块实时画板 */
  boardId: string
  /** 仓库目录；网页捕获没有，不能写回代码 */
  repoDir?: string
  route: string
  url: string
}

export interface Artboard {
  id: string
  projectId: string
  title: string
  /** 缺省为 'html'（AI / 手动编辑的 HTML 原型）；'live' 为实时画板 */
  kind?: 'html' | 'live'
  live?: LiveSource
  capture?: CaptureSource
  /** 衍生自哪块画板（多方案/副本时指向父画板），用于连线可视化 */
  parent?: string
  x: number
  y: number
  width: number
  height: number
  versions: Version[]
  currentVersionId: string | null
  createdAt: number
  updatedAt: number
}

/** 服务商类型：OpenAI 兼容 HTTP 接口，或本机 Agent CLI（仅桌面端，用用户自己的订阅） */
export type ProviderKind = 'openai' | 'claude-code' | 'codex'

export interface ProviderConfig {
  id: string
  /** 缺省视为 'openai'（兼容旧配置） */
  kind?: ProviderKind
  name: string
  baseURL: string
  apiKey: string
  model: string
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

export interface WheelPayload {
  deltaX: number
  deltaY: number
  /** 相对 iframe 内视口的坐标 */
  localX: number
  localY: number
}
