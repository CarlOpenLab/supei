/**
 * Design Infra 插件注册表。
 * 内置插件在模块加载时注册；用户插件持久化在 localStorage。
 * 所有消费方（AppIcon / ChatPanel / orchestrator / 设置弹窗）只从这里读取能力。
 */
import { reactive, watch } from 'vue'
import type {
  DesignPlugin,
  IconPluginData,
  PluginKind,
  PresetPluginData,
  StylePluginData,
  TemplatePluginData,
} from './types'
import { isPluginKind } from './types'

// —— 内置插件数据（从旧散落常量收编）——

const BUILTIN_STYLE_PLUGINS: DesignPlugin<StylePluginData>[] = [
  {
    id: 'style:auto',
    kind: 'style',
    source: 'builtin',
    name: '自动',
    description: '由基础设计规范自由发挥',
    enabled: true,
    data: { prompt: '' },
  },
  {
    id: 'style:ai',
    kind: 'style',
    source: 'builtin',
    name: 'AI 设计风格',
    description: '由模型根据需求现场设计风格指令',
    enabled: true,
    data: { prompt: '' },
  },
  {
    id: 'style:editorial',
    kind: 'style',
    source: 'builtin',
    name: '编辑杂志风',
    enabled: true,
    data: {
      prompt: `【设计风格：编辑杂志风（Editorial）】
- 排版是主角：超大衬线标题（思源宋体/Noto Serif SC 或 Georgia + 宋体栈），标题字号与正文拉开 3-4 倍对比。
- 强网格但敢于打破：非对称分栏、跨栏大标题、大留白与紧凑段落交替形成节奏。
- 配色克制：米白/纯纸色底，近黑墨色文字，全页只允许一个强调色（如朱红/钴蓝）用于下划线、序号、关键按钮。
- 细节：细分隔线（1px 墨色 20% 透明）、序号编号（01 / 02）、首字下沉、图片上的图注小字。
- 禁止：渐变、玻璃拟态、emoji 图标、居中对称的英雄区。`,
    },
  },
  {
    id: 'style:dark-tech',
    kind: 'style',
    source: 'builtin',
    name: '深色科技',
    enabled: true,
    data: {
      prompt: `【设计风格：深色科技（Dark Tech）】
- 深色底（#0A0A0C～#141418 之间的近黑，不是纯黑），文字用高透白（rgba(255,255,255,.92)）。
- 一个荧光强调色（电光青/荧光绿/亮紫任选其一）只用于关键操作、数据高亮、状态点；页面 95% 面积保持深色灰阶。
- 层次靠「抬升」而非描边：卡片用比底色亮一档的深灰 + 极淡的顶部内高光；关键卡片可用 1px 半透明描边。
- 数据可视化感：大号等宽数字、细网格背景线、状态圆点、micro-label（11px 大写字距 +0.08em）。
- 禁止：大面积彩色渐变背景、纯白大底卡片、emoji 图标。`,
    },
  },
  {
    id: 'style:swiss',
    kind: 'style',
    source: 'builtin',
    name: '瑞士国际主义',
    enabled: true,
    data: {
      prompt: `【设计风格：瑞士国际主义（Swiss / International Typographic Style）】
- 严格的 12 列网格，所有元素对齐网格线；大量留白，信息密度低而精准。
- 无衬线字体一族到底（Helvetica Neue / 苹方 / 雅黑），仅靠字号（12/14/18/24/36/56）与字重（400/500/700）制造层级。
- 黑 + 白 + 一个红（或钴蓝）：强调色出现不超过 5 处，其余全是黑白灰。
- 平面化：无阴影或仅 1 层极淡阴影，无圆角或仅 2px，无渐变；用色块、粗规则线（2-3px 黑线）分区。
- 数字与标签用等宽字体；按钮是方正的实心色块。`,
    },
  },
  {
    id: 'style:soft',
    kind: 'style',
    source: 'builtin',
    name: '温和亲和',
    enabled: true,
    data: {
      prompt: `【设计风格：温和亲和（Soft & Friendly）】
- 奶油/暖白底（#FAF7F2 类），配一个柔和的主色（鼠尾草绿、陶土橙、雾蓝任选）和一个更浅的辅助色。
- 大圆角（16-20px）、柔和多层阴影、generous 内边距。
- 标题圆体感，行高 1.7；标签用 pill 形状。
- 适度使用大面积浅色色块分区，而不是细线框；按钮饱满圆润。
- 禁止：纯黑白强对比、锐利直角、密集表格感。`,
    },
  },
  {
    id: 'style:brutalist',
    kind: 'style',
    source: 'builtin',
    name: '新粗野主义',
    enabled: true,
    data: {
      prompt: `【设计风格：新粗野主义（Neo-Brutalism）】
- 高饱和撞色底（如亮黄、荧光绿、天蓝大面积使用），黑色粗描边（2-3px solid #111）。
- 硬阴影：offset 实心阴影（box-shadow: 4px 4px 0 #111），无模糊。
- 字大而粗（800-900 字重），排版直白甚至故意溢出、旋转个别标签。
- 组件直给：按钮是实心色块+黑边+硬阴影，hover 时位移 2px 模拟按下。
- 禁止：渐变、半透明、精致细腻的过渡动画。`,
    },
  },
  {
    id: 'style:wabi-sabi',
    kind: 'style',
    source: 'builtin',
    name: '侘寂极简',
    enabled: true,
    data: {
      prompt: `【设计风格：侘寂极简（Wabi-Sabi Minimal）——原研哉 / 无印良品式的克制】
- 设计哲学：内容之外的一切都退后。大量留白（一处留白 ≥ 视口的 30%），让用户在「空」里休息。
- 纸感底色（#F7F5F0～#EFECE5），墨灰文字（#3A3A38，不是纯黑），像未涂布的印刷纸。
- 字号小而精（正文 13-14px，行高 2.0），层级靠位置与疏密，几乎不用色块；标题可用细宋体。
- 材质细节：细线（0.5px）、灰调摄影位（用纯色占位块代替）、竖排小标签、页脚版权小字。
- 全页颜色 ≤ 4 种；按钮是细描边或墨色实底，绝不渐变。
- 禁止：饱和色、大圆角、卡片阴影、任何喧宾夺主的装饰。`,
    },
  },
  {
    id: 'style:dark-saas',
    kind: 'style',
    source: 'builtin',
    name: 'Linear 深色 SaaS',
    enabled: true,
    data: {
      prompt: `【设计风格：Linear / Vercel 深色专业工具】
- 设计哲学：信息密度与优雅并存——专业软件的精准，消费产品的顺滑。
- 深色底（#08090A），前景白 rgba(255,255,255,.9)；卡片比底色亮 4%（#101114），1px 描边 rgba(255,255,255,.07)。
- 顶部若有渐变：极暗的径向光晕（主色 8% 透明度），营造「暗室打光」。
- 中间态字体（13-14px）+ 5px 圆角 + 紧凑行高（1.5）；侧栏/工具条用 11px 次级文字。
- 微交互到位：hover 背景 +3% 亮度、transition 150ms、按钮按下 scale(0.98)。
- 一个克制的强调色（靛蓝/薄荷/琥珀任选）用于主按钮与激活态；图标线性 1.5px。
- 禁止：大圆角（>8px）、明亮底色、卡通元素、手写体。`,
    },
  },
  {
    id: 'style:bauhaus',
    kind: 'style',
    source: 'builtin',
    name: '包豪斯构成',
    enabled: true,
    data: {
      prompt: `【设计风格：包豪斯 / 构成主义（Bauhaus Constructivism）】
- 设计哲学：形式追随功能，用几何与原色构成页面——页面本身是一幅构成主义海报。
- 三原色体系：红 #E63329、蓝 #0057B8、黄 #F2B705，配大面积黑与米白；每个色块面积经过构图权衡。
- 几何元素：圆形、1/4 圆弧、斜线、实心色块直接参与排版（色块里放文字）。
- 无衬线粗体大写标题，正文小而疏朗。
- 布局用严格的几何切割（横竖 45° 线分块），元素可以出血到页面边缘。
- 禁止：圆角阴影拟物、柔和渐变、图片占位用渐变色块与几何图形代替。`,
    },
  },
]

const BUILTIN_PRESET_PLUGINS: DesignPlugin<PresetPluginData>[] = [
  {
    id: 'preset:ecommerce',
    kind: 'preset',
    source: 'builtin',
    name: '电商产品落地页',
    enabled: true,
    data: {
      icon: 'desktop',
      prompt:
        '设计一个智能耳机的电商落地页：首屏产品大图与核心卖点、参数对比区、用户评价、底部购买 CTA，走高级深色风格。',
    },
  },
  {
    id: 'preset:dashboard',
    kind: 'preset',
    source: 'builtin',
    name: 'SaaS 数据仪表盘',
    enabled: true,
    data: {
      icon: 'frame',
      prompt:
        '设计一个 SaaS 后台数据仪表盘：顶部 4 张指标卡、中部折线图与柱状图（用 CSS 绘制示意）、右侧实时动态列表，浅色简洁风格。',
    },
  },
  {
    id: 'preset:onboarding',
    kind: 'preset',
    source: 'builtin',
    name: '移动端 Onboarding',
    enabled: true,
    data: {
      icon: 'sparkle',
      prompt:
        '设计一个移动 App 的 3 步引导页（onboarding），渐变背景、插画占位、跳过与下一步按钮，375 宽移动端布局。',
    },
  },
]

const BUILTIN_TEMPLATE_PLUGINS: DesignPlugin<TemplatePluginData>[] = [
  {
    id: 'template:desktop',
    kind: 'template',
    source: 'builtin',
    name: '桌面 1280 × 800',
    enabled: true,
    data: { width: 1280, height: 800 },
  },
  {
    id: 'template:tablet',
    kind: 'template',
    source: 'builtin',
    name: '平板 834 × 1112',
    enabled: true,
    data: { width: 834, height: 1112 },
  },
  {
    id: 'template:mobile',
    kind: 'template',
    source: 'builtin',
    name: '移动 375 × 812',
    enabled: true,
    data: { width: 375, height: 812 },
  },
]

const BUILTIN_ICON_PLUGINS: DesignPlugin<IconPluginData>[] = [
  {
    id: 'icon:core',
    kind: 'icon',
    source: 'builtin',
    name: 'Core Icons',
    description: '内置线性图标集',
    enabled: true,
    data: {},
  },
]

const BUILTINS: DesignPlugin[] = [
  ...BUILTIN_STYLE_PLUGINS,
  ...BUILTIN_PRESET_PLUGINS,
  ...BUILTIN_TEMPLATE_PLUGINS,
  ...BUILTIN_ICON_PLUGINS,
]

// —— 注册表状态 ——
const LS_KEY = 'dc.plugins.v1'

interface RegistryState {
  user: DesignPlugin[]
  disabled: string[]
}

const state = reactive<RegistryState>({ user: [], disabled: [] })

function load(): void {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return
    const data = JSON.parse(raw) as RegistryState
    state.user = Array.isArray(data.user) ? data.user : []
    state.disabled = Array.isArray(data.disabled) ? data.disabled : []
  } catch {
    /* 损坏时回退默认 */
  }
}

function persist(): void {
  localStorage.setItem(LS_KEY, JSON.stringify({ user: state.user, disabled: state.disabled }))
}

function allPlugins(): DesignPlugin[] {
  return [...BUILTINS, ...state.user].map((p) => ({
    ...p,
    enabled: p.enabled && !state.disabled.includes(p.id),
  }))
}

function byKind<K extends PluginKind>(kind: K): DesignPlugin[] {
  return allPlugins().filter((p) => p.kind === kind && p.enabled)
}

// —— 对外 API ——

export const pluginRegistry = {
  init: load,
  /** 全部插件（含禁用标记），供管理界面 */
  list: allPlugins,
  listByKind: byKind,
  isBuiltin: (id: string) => id.startsWith('style:') || id.startsWith('preset:') || id.startsWith('template:') || id === 'icon:core',

  /** 取单个插件（优先用户插件） */
  get(id: string): DesignPlugin | undefined {
    return state.user.find((p) => p.id === id) ?? BUILTINS.find((p) => p.id === id)
  },

  /** 风格指令：按 id 取 prompt；'auto' 返回空；兼容旧版无前缀 id */
  stylePrompt(id: string | undefined | null): string {
    if (!id || id === 'auto' || id === 'style:auto') return ''
    const key = id.includes(':') ? id : `style:${id}`
    const p = allPlugins().find((x) => x.id === key && x.kind === 'style')
    return p ? (p.data as StylePluginData).prompt : ''
  },

  addUserPlugin(
    plugin: Pick<DesignPlugin, 'kind' | 'name'> & {
      description?: string
      data: unknown
      enabled?: boolean
    },
  ): DesignPlugin {
    const full: DesignPlugin = {
      id: `plugin:${plugin.kind}:${Math.random().toString(36).slice(2, 10)}`,
      kind: plugin.kind,
      source: 'user',
      name: plugin.name,
      description: plugin.description,
      enabled: plugin.enabled ?? true,
      data: plugin.data,
    }
    state.user.push(full)
    persist()
    return full
  },

  updateUserPlugin(id: string, patch: Partial<Pick<DesignPlugin, 'name' | 'description' | 'data'>>) {
    const p = state.user.find((x) => x.id === id)
    if (!p) return
    Object.assign(p, patch)
    persist()
  },

  removeUserPlugin(id: string) {
    state.user = state.user.filter((p) => p.id !== id)
    persist()
  },

  toggleEnabled(id: string) {
    if (state.disabled.includes(id)) state.disabled = state.disabled.filter((x) => x !== id)
    else state.disabled.push(id)
    persist()
  },
}

// —— 兼容旧风格包（{name, prompt}）与新 manifest 的导入 ——

export interface ImportedPluginEntry {
  kind: PluginKind
  name: string
  description?: string
  data: unknown
}

export function parsePluginFile(text: string, filename: string): ImportedPluginEntry[] {
  const isJson =
    filename.endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')
  if (isJson) {
    const data = JSON.parse(text)
    const arr = Array.isArray(data) ? data : [data]
    return arr.flatMap((item: Record<string, unknown>) => {
      // v2 manifest
      if (Array.isArray(item.plugins)) {
        const kindDefault = isPluginKind(item.kind) ? item.kind : undefined
        return (item.plugins as Record<string, unknown>[]).map((p) =>
          normalizeEntry(kindDefault ?? p.kind, p),
        )
      }
      // 旧风格包：{name, prompt}
      return [normalizeEntry('style', item)]
    })
  }
  // markdown 风格包（frontmatter + 正文 → style 插件）
  const fm = text.trim().match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  let label = ''
  let body = text.trim()
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^name\s*:\s*(.+)$/)
      if (m) label = m[1].trim().replace(/^["']|["']$/g, '')
    }
    body = fm[2]
  }
  if (!label) {
    const h1 = body.match(/^#\s+(.+)$/m)
    label = h1 ? h1[1].trim() : filename.replace(/\.[^.]+$/, '')
  }
  return [{ kind: 'style', name: label, data: { prompt: body.trim() } }]
}

function normalizeEntry(kind: unknown, p: Record<string, unknown>): ImportedPluginEntry {
  const k = isPluginKind(kind) ? kind : 'style'
  const name = String(p.name ?? p.label ?? '').trim()
  if (k === 'style') return { kind: k, name, data: { prompt: String(p.prompt ?? p.directive ?? '').trim() } }
  if (k === 'preset') return { kind: k, name, data: { icon: String(p.icon ?? 'sparkle'), prompt: String(p.prompt ?? '').trim() } }
  if (k === 'template')
    return {
      kind: k,
      name,
      data: { width: Number(p.width ?? 1280), height: Number(p.height ?? 800) },
    }
  if (k === 'icon') {
    const data = (p.data ?? p.icons ?? {}) as IconPluginData
    return { kind: k, name, data }
  }
  return { kind: 'style', name, data: { prompt: '' } }
}

// 启动加载用户插件
load()

// 用户插件变化时持久化（reactive 深度监听兜底，防绕过 API 的修改）
watch(state.user, persist, { deep: true })
