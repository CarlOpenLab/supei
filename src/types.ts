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
  /** 演示模式种子，迭代时用于推导下一个配色 */
  demoSeed?: number
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

export interface Artboard {
  id: string
  projectId: string
  title: string
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

export interface ProviderConfig {
  id: string
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
