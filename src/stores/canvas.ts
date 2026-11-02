import { defineStore } from 'pinia'
import type { Artboard, Viewport } from '@/types'

export const MIN_ZOOM = 0.15
export const MAX_ZOOM = 3

export const useCanvasStore = defineStore('canvas', {
  state: () => ({
    viewport: { x: 0, y: 0, zoom: 1 } as Viewport,
    containerSize: { w: 0, h: 0 },
    selectedArtboardId: null as string | null,
    selectMode: true,
    /** 正在生成的画板与流式 HTML（多方案并行时有多条） */
    generating: [] as Array<{ artboardId: string; html: string }>,
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
    setSelectMode(v: boolean) {
      this.selectMode = v
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
