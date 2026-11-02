import type { ArtifactMode, PlanQuestion, PlannedArtifactMode } from '@/types'

export const ARTIFACT_MODE_QUESTION_ID = 'artifact-mode'
export const PAGE_OPTION = '整页原型'
export const COMPONENT_OPTION = '单个组件'
export const ARTIFACT_MODE_OPTIONS = [PAGE_OPTION, COMPONENT_OPTION] as const

/** 规划卡固定插入的产物类型问题（选项由应用掌控，不依赖模型输出）。 */
export function makeArtifactModeQuestion(): PlanQuestion {
  return {
    id: ARTIFACT_MODE_QUESTION_ID,
    q: '这次要生成整页原型，还是单个 UI 组件？',
    options: [...ARTIFACT_MODE_OPTIONS],
  }
}

export function isArtifactModeQuestion(q: PlanQuestion): boolean {
  return q.id === ARTIFACT_MODE_QUESTION_ID
}

/** 模型自作主张写的「整页 vs 组件」问题：选项里同时能识别出两种类型。 */
export function looksLikeArtifactModeQuestion(q: PlanQuestion): boolean {
  const modes = new Set(q.options.map((o) => inferArtifactMode(o)).filter(Boolean))
  return modes.has('page') && modes.has('component')
}

export function normalizePlannedMode(value: unknown): PlannedArtifactMode | undefined {
  if (value === 'page' || value === 'component' || value === 'ambiguous') return value
  if (typeof value !== 'string') return undefined
  const t = normalizeText(value)
  if (t === 'component' || t === '组件' || t === '单个组件' || t === '控件') return 'component'
  if (t === 'page' || t === '页面' || t === '整页' || t === '整页原型' || t === '原型' || t === '网页') return 'page'
  if (t === 'ambiguous' || t === '不确定' || t === '无法判断' || t === '未知') return 'ambiguous'
  return undefined
}

const COMPONENT_RE =
  /(组件|控件|组件库|原子组件|按钮|卡片|弹窗|模态框|对话框|抽屉|表单|输入框|搜索框|文本框|下拉|选择器|开关|复选框|单选框|滑块|标签页|徽章|头像|导航栏|导航条|侧边栏|侧栏|工具栏|菜单栏|菜单|顶栏|表格|列表项|分页|步骤条|面包屑|进度条|评分|上传|提示框|提示条|气泡|骨架屏|空状态|日期选择|时间线|轮播|折叠面板|分段控制器|button|card|modal|dialog|drawer|form|input|select|dropdown|toggle|switch|checkbox|radio|slider|tag|badge|avatar|tabs|navbar|sidebar|menu|table|pagination|steps|breadcrumb|progress|rating|upload|toast|snackbar|tooltip|popover|skeleton|emptystate|datepicker|carousel|timeline|accordion|component|widget)/i
const PAGE_RE =
  /(整页|页面|网页|网站|官网|站点|落地页|首页|主页|详情页|列表页|登录页|注册页|仪表盘|后台|控制台|工作台|看板|fullpage|webpage|website|landingpage|homepage|dashboard)/i
const COMPONENT_SCOPE_RE = /(只要|仅要|单独|只做|只设计|不要页面|不是页面|无需页面|别做页面|一个组件)/i

/**
 * @description 从需求文本推断产物类型（兜底用，主判断交给规划模型）。
 * 无法判断时返回 undefined，由调用方决定是否让用户选择。
 * @param text - 用户需求或规划卡答案
 * @returns page / component，或 undefined
 */
export function inferArtifactMode(text: string): ArtifactMode | undefined {
  const t = normalizeText(text)
  if (!t) return undefined
  if (t === PAGE_OPTION || t === '整页' || t === '页面原型') return 'page'
  if (t === COMPONENT_OPTION || t === '单个ui组件' || t === '组件ui') return 'component'

  const hasComponent = COMPONENT_RE.test(t)
  const hasPage = PAGE_RE.test(t)
  if (!hasComponent && !hasPage) return undefined

  // 「只要一个搜索框」这类明确限定组件范围的表达优先
  if (hasComponent && COMPONENT_SCOPE_RE.test(t)) return 'component'
  if (hasComponent && hasPage) {
    // 以句尾的中心词判断最终交付物：
    // 「登录页里的登录表单组件」→ component；「带按钮的登录页」→ page
    return lastMatchIndex(COMPONENT_RE, t) > lastMatchIndex(PAGE_RE, t) ? 'component' : 'page'
  }
  return hasComponent ? 'component' : 'page'
}

/** 正则最后一次命中的位置；没有命中返回 -1。 */
function lastMatchIndex(re: RegExp, text: string): number {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  let index = -1
  for (const m of text.matchAll(global)) index = m.index ?? index
  return index
}

/**
 * @description 决定最终产物类型：用户答案 → 规划判断 → 画板既有类型 → 兜底。
 * 用户答案判断不了时继续往下走，避免一段随意文本翻转画板类型。
 */
export function resolveArtifactMode(params: {
  answer?: string | null
  planMode?: PlannedArtifactMode
  boardMode?: ArtifactMode
  fallback?: ArtifactMode
}): ArtifactMode {
  const answer = params.answer?.trim()
  const fromAnswer = answer ? inferArtifactMode(answer) : undefined
  if (fromAnswer) return fromAnswer
  if (params.planMode === 'page' || params.planMode === 'component') return params.planMode
  if (params.boardMode) return params.boardMode
  return params.fallback ?? 'page'
}

export function artifactModeLabel(mode: PlannedArtifactMode | undefined): string {
  if (mode === 'component') return COMPONENT_OPTION
  if (mode === 'page') return PAGE_OPTION
  return '待确认'
}

/** 拼进生成提示词的产物类型说明。 */
export function artifactModePromptLabel(mode: ArtifactMode): string {
  return mode === 'component'
    ? '单个 UI 组件（组件视觉设计稿 HTML；不是完整页面，不是 Vue/React 源码）'
    : '整页原型页面（完整 HTML 页面）'
}

/** 统一大小写、全角标点与空白，便于关键词判断。 */
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[\s，。！？、；：,.!?;:()（）\[\]【】"'“”‘’]/g, '')
}
