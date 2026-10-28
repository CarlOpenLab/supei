/**
 * Design Infra 插件类型体系。
 * 每个插件是一个可注入的能力单元，kind 决定 data 的结构与消费方。
 */

export type PluginKind = 'style' | 'preset' | 'template' | 'icon'

/** 风格插件：拼入生成 system prompt 的风格指令 */
export interface StylePluginData {
  prompt: string
}

/** 需求预设插件：聊天空态的一键起点 */
export interface PresetPluginData {
  icon: string
  prompt: string
}

/** 画板模板插件：尺寸预设 */
export interface TemplatePluginData {
  width: number
  height: number
}

/** 图标插件：扩展 AppIcon 的图标集（name → SVG path d） */
export type IconPluginData = Record<string, string>

export interface DesignPlugin<T = unknown> {
  id: string
  kind: PluginKind
  source: 'builtin' | 'user'
  name: string
  description?: string
  enabled: boolean
  data: T
}

export type DesignPluginDraft = Omit<DesignPlugin, 'id' | 'source' | 'enabled'>

/** 插件包 manifest（分享/导入格式 v2） */
export interface PluginManifest {
  format: 'mygo-design-plugin'
  name: string
  plugins: Array<DesignPluginDraft>
}

export const isPluginKind = (v: unknown): v is PluginKind =>
  v === 'style' || v === 'preset' || v === 'template' || v === 'icon'
