import { defineStore } from 'pinia'
import type { Artboard, CaptureSource, ChatMessage, ChatRole, ElementContext, LiveSource, PlanPayload, Project, Version } from '@/types'
import * as db from '@/services/db'
import { uid } from '@/utils/id'

export interface NewArtboardInput {
  title: string
  width: number
  height: number
  x: number
  y: number
  parent?: string
  kind?: Artboard['kind']
  live?: LiveSource
  capture?: CaptureSource
}

/** 深拷贝画板快照为新画板：新 id、级联偏移（+48）、刷新时间戳；title/parent 等由调用方覆盖。 */
function cloneArtboard(snap: Artboard, projectId: string, overrides: Partial<Artboard>): Artboard {
  return {
    ...JSON.parse(JSON.stringify(snap)),
    id: uid('board'),
    projectId,
    x: snap.x + 48,
    y: snap.y + 48,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    projects: [] as Project[],
    currentProjectId: null as string | null,
    artboards: [] as Artboard[],
    messages: [] as ChatMessage[],
    loaded: false,
  }),
  getters: {
    currentProject(state): Project | null {
      return state.projects.find((p) => p.id === state.currentProjectId) ?? null
    },
  },
  actions: {
    async loadProjects() {
      this.projects = await db.loadProjects()
      this.loaded = true
    },

    async openProject(id: string) {
      this.currentProjectId = id
      ;[this.artboards, this.messages] = await Promise.all([
        db.loadArtboards(id),
        db.loadMessages(id),
      ])
    },

    async closeProject() {
      this.currentProjectId = null
      this.artboards = []
      this.messages = []
    },

    async createProject(name?: string): Promise<Project> {
      const now = Date.now()
      const project: Project = {
        id: uid('proj'),
        name: name?.trim() || '未命名项目',
        createdAt: now,
        updatedAt: now,
      }
      this.projects.unshift(project)
      await db.putProject(project)
      return project
    },

    async renameProject(id: string, name: string) {
      const p = this.projects.find((x) => x.id === id)
      if (!p) return
      p.name = name.trim() || p.name
      p.updatedAt = Date.now()
      await db.putProject(p)
    },

    async deleteProject(id: string) {
      await db.deleteProjectData(id)
      this.projects = this.projects.filter((p) => p.id !== id)
      if (this.currentProjectId === id) await this.closeProject()
    },

    async createArtboard(input: NewArtboardInput): Promise<Artboard> {
      const now = Date.now()
      const board: Artboard = {
        id: uid('board'),
        projectId: this.currentProjectId!,
        title: input.title || '未命名画板',
        kind: input.kind,
        live: input.live,
        capture: input.capture,
        parent: input.parent,
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
        versions: [],
        currentVersionId: null,
        createdAt: now,
        updatedAt: now,
      }
      this.artboards.push(board)
      await db.putArtboard(board)
      return board
    },

    findArtboard(id: string | null): Artboard | null {
      return this.artboards.find((b) => b.id === id) ?? null
    },

    /** 仅更新内存位置（拖拽过程），落盘用 persistArtboard */
    moveArtboard(id: string, x: number, y: number) {
      const b = this.findArtboard(id)
      if (!b) return
      b.x = Math.round(x)
      b.y = Math.round(y)
    },

    async persistArtboard(id: string) {
      const b = this.findArtboard(id)
      if (!b) return
      b.updatedAt = Date.now()
      await db.putArtboard(b)
    },

    async duplicateArtboard(id: string): Promise<Artboard | null> {
      const src = this.findArtboard(id)
      if (!src) return null
      const copy = cloneArtboard(src, src.projectId, { title: `${src.title} 副本`, parent: src.id })
      this.artboards.push(copy)
      await db.putArtboard(copy)
      return copy
    },

    /** 从剪贴板快照粘贴画板（含全部版本），连续粘贴自动级联偏移 */
    async pasteArtboard(snap: Artboard): Promise<Artboard> {
      const copy = cloneArtboard(snap, this.currentProjectId!, { parent: undefined })
      this.artboards.push(copy)
      await db.putArtboard(copy)
      return copy
    },

    async removeArtboard(id: string) {
      await db.deleteArtboard(id)
      this.artboards = this.artboards.filter((b) => b.id !== id)
    },

    async addVersion(
      artboardId: string,
      html: string,
      extra: { sourceMessageId?: string; demoSeed?: number } = {},
    ): Promise<Version> {
      const b = this.findArtboard(artboardId)
      if (!b) throw new Error('画板不存在')
      const version: Version = {
        id: uid('ver'),
        html,
        createdAt: Date.now(),
        sourceMessageId: extra.sourceMessageId,
        demoSeed: extra.demoSeed,
      }
      b.versions.push(version)
      b.currentVersionId = version.id
      b.updatedAt = Date.now()
      await db.putArtboard(b)
      return version
    },

    async setCurrentVersion(artboardId: string, versionId: string) {
      const b = this.findArtboard(artboardId)
      if (!b || !b.versions.some((v) => v.id === versionId)) return
      b.currentVersionId = versionId
      await db.putArtboard(b)
    },

    async addMessage(input: {
      artboardId: string | null
      role: ChatRole
      content: string
      elementContext?: ElementContext | null
      versionId?: string | null
      status?: 'ok' | 'error' | 'aborted'
      plan?: PlanPayload | null
    }): Promise<ChatMessage> {
      const msg: ChatMessage = {
        id: uid('msg'),
        projectId: this.currentProjectId!,
        artboardId: input.artboardId,
        role: input.role,
        content: input.content,
        elementContext: input.elementContext ?? null,
        versionId: input.versionId ?? null,
        status: input.status ?? 'ok',
        plan: input.plan ?? null,
        createdAt: Date.now(),
      }
      this.messages.push(msg)
      await db.putMessage(msg)
      return msg
    },

    async updateMessage(id: string, patch: Partial<Pick<ChatMessage, 'content' | 'status' | 'plan'>>) {
      const m = this.messages.find((x) => x.id === id)
      if (!m) return
      Object.assign(m, patch)
      await db.putMessage(m)
    },

    currentVersionOf(board: Artboard): Version | null {
      return board.versions.find((v) => v.id === board.currentVersionId) ?? null
    },
  },
})
