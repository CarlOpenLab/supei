import { defineStore } from 'pinia'
import type { Artboard, ElementEdit, FrameTool, InspectMeta, Viewport } from '@/types'

export const MIN_ZOOM = 0.15
export const MAX_ZOOM = 3

export const useCanvasStore = defineStore('canvas', {
  state: () => ({
    viewport: { x: 0, y: 0, zoom: 1 } as Viewport,
    containerSize: { w: 0, h: 0 },
    selectedArtboardId: null as string | null,
    /** 画板内点选工具：默认 comment（点选定向反馈），edit 为检查器手动编辑 */
    tool: 'comment' as FrameTool,
    /** 编辑模式下当前检查的元素（同一时刻只在一块画板上） */
    inspect: null as { artboardId: string; meta: InspectMeta } | null,
    /** 待保存的手动修改：画板 id → dcId → 修改；保存时批量落成新版本 */
    edits: {} as Record<string, Record<string, ElementEdit>>,
    /** 正在生成的画板与流式 HTML（多方案并行时有多条） */
    generating: [] as Array<{ artboardId: string; html: string }>,
    /** 本机 Agent 正在改代码（进度写在 messageId 这条消息里）；同一时刻只跑一个 */
    agentRun: null as { boardId: string; messageId: string } | null,
    /** 待发布到局域网的页面（整项目预览页或单块画板）；非空时打开分享弹窗 */
    sharePayload: null as { title: string; html: string } | null,
    /** Esc 信号计数器：通知画板组件清除待发送的元素选中态 */
    escSignal: 0,
    /** 设计风格预设 id（plugins registry）；'ai' 表示由 AI 现场生成风格 */
    designStyleId: 'auto',
    currentProjectKey: null as string | null,
    /** 多选画板 id（Shift+点击），支持同步拖动与批量删除 */
    multi: [] as string[],
    /** 深度思考开关：开启后透传 reasoning_effort=high 给支持的服务商 */
    deepThink: false,
    /** 拖拽对齐参考线（世界坐标）：v = 垂直线 x 值，h = 水平线 y 值 */
    guides: { v: [] as number[], h: [] as number[] },
    /** 画板剪贴板（Ctrl+C/V）：存放画板快照，可重复粘贴 */
    clipboard: null as Artboard | null,
  }),
  getters: {
    /** 有 AI 任务在跑（生成原型或 Agent 改代码）：聊天发送与规划按钮据此禁用，停止按钮据此出现 */
    busy(state): boolean {
      return state.generating.length > 0 || state.agentRun !== null
    },
  },
  actions: {
    setViewport(vp: Partial<Viewport>) {
      Object.assign(this.viewport, vp)
    },
    panBy(dx: number, dy: number) {
      this.viewport.x += dx
      this.viewport.y += dy
    },
    /** 以容器坐标 (cx, cy) 为锚点缩放 */
    zoomAt(cx: number, cy: number, factor: number) {
      const z0 = this.viewport.zoom
      const z1 = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z0 * factor))
      if (z1 === z0) return
      const k = z1 / z0
      this.viewport.x = cx - (cx - this.viewport.x) * k
      this.viewport.y = cy - (cy - this.viewport.y) * k
      this.viewport.zoom = z1
    },
    resetZoom() {
      const { w, h } = this.containerSize
      this.zoomAt(w / 2, h / 2, 1 / this.viewport.zoom)
    },
    zoomStep(direction: 1 | -1) {
      const { w, h } = this.containerSize
      this.zoomAt(w / 2, h / 2, direction > 0 ? 1.2 : 1 / 1.2)
    },
    select(id: string | null) {
      this.selectedArtboardId = id
      if (id) {
        try {
          const map = JSON.parse(localStorage.getItem('dc.last-board') ?? '{}')
          map[this.currentProjectKey ?? ''] = id
          localStorage.setItem('dc.last-board', JSON.stringify(map))
        } catch {
          /* 忽略 */
        }
      }
    },
    isMulti(id: string): boolean {
      return this.multi.includes(id)
    },
    toggleMulti(id: string) {
      this.multi = this.multi.includes(id)
        ? this.multi.filter((x) => x !== id)
        : [...this.multi, id]
    },
    setMulti(ids: string[]) {
      this.multi = ids
    },
    clearMulti() {
      this.multi = []
    },
    /** 恢复项目上次的画板选中（刷新后迭代流保持连续） */
    restoreFor(projectId: string | null): string | null {
      if (!projectId) return null
      try {
        const map = JSON.parse(localStorage.getItem('dc.last-board') ?? '{}')
        return map[projectId] ?? null
      } catch {
        return null
      }
    },
    setProjectKey(key: string | null) {
      this.currentProjectKey = key
    },
    /**
     * @description 切换画板内点选工具；离开编辑模式时清掉检查选中（待保存修改保留，仍可保存或放弃）。
     * @param t - 目标工具，null 为关闭点选
     */
    setTool(t: FrameTool) {
      this.tool = t
      if (t !== 'edit') this.inspect = null
    },
    /**
     * @description 记录编辑模式下选中的元素；bridge 应用修改后的刷新上报只更新同一画板。
     * @param artboardId - 元素所在画板
     * @param meta - bridge 上报的元素信息
     * @param refresh - 是否为应用修改后的刷新（选中已被清除时忽略，避免“复活”）
     */
    setInspect(artboardId: string, meta: InspectMeta, refresh = false) {
      if (refresh && this.inspect?.artboardId !== artboardId) return
      this.inspect = { artboardId, meta }
    },
    clearInspect() {
      this.inspect = null
    },
    /**
     * @description 合并一处待保存修改（样式按属性覆盖；空字符串表示移除该内联样式）。
     * @param artboardId - 画板 id
     * @param dcId - 元素稳定编号
     * @param patch - 要合并的样式与文字
     */
    setEdit(artboardId: string, dcId: string, patch: { styles?: Record<string, string>; text?: string }) {
      const board = (this.edits[artboardId] ??= {})
      const cur = (board[dcId] ??= { styles: {} })
      if (patch.styles) Object.assign(cur.styles, patch.styles)
      if (patch.text !== undefined) cur.text = patch.text
    },
    clearEdits(artboardId: string) {
      delete this.edits[artboardId]
    },
    /**
     * @description 画板上待保存修改涉及的元素数。
     * @param artboardId - 画板 id
     * @returns 元素数，0 表示没有未保存修改
     */
    editCount(artboardId: string): number {
      return Object.keys(this.edits[artboardId] ?? {}).length
    },
    setContainerSize(w: number, h: number) {
      this.containerSize.w = w
      this.containerSize.h = h
    },
    startGenerating(artboardId: string) {
      this.generating.push({ artboardId, html: '' })
    },
    setStreamingHtml(artboardId: string, html: string) {
      const g = this.generating.find((x) => x.artboardId === artboardId)
      if (g) g.html = html
    },
    stopGenerating(artboardId?: string) {
      this.generating = artboardId
        ? this.generating.filter((g) => g.artboardId !== artboardId)
        : []
    },
    fireEsc() {
      this.escSignal++
      this.inspect = null
    },
    setDesignStyle(id: string) {
      this.designStyleId = id
    },
    toggleDeepThink() {
      this.deepThink = !this.deepThink
    },
    setGuides(v: number[], h: number[]) {
      this.guides.v = v
      this.guides.h = h
    },
    clearGuides() {
      this.guides.v = []
      this.guides.h = []
    },
  },
})
