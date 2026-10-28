import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Artboard, ChatMessage, Project } from '@/types'

interface DCDB extends DBSchema {
  projects: { key: string; value: Project }
  artboards: { key: string; value: Artboard; indexes: { 'by-project': string } }
  messages: { key: string; value: ChatMessage; indexes: { 'by-project': string } }
}

let dbPromise: Promise<IDBPDatabase<DCDB>> | null = null

/**
 * IndexedDB 用 structured clone，无法克隆 Pinia 的 reactive Proxy。
 * 所有写入统一转成纯 JSON 对象。
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function getDb() {
  if (!dbPromise) {
    dbPromise = openDB<DCDB>('design-canvas', 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('artboards')) {
          const store = db.createObjectStore('artboards', { keyPath: 'id' })
          store.createIndex('by-project', 'projectId')
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' })
          store.createIndex('by-project', 'projectId')
        }
      },
    })
  }
  return dbPromise
}

export async function loadProjects(): Promise<Project[]> {
  const db = await getDb()
  const all = await db.getAll('projects')
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function putProject(project: Project): Promise<void> {
  const db = await getDb()
  await db.put('projects', plain(project))
}

export async function deleteProjectData(projectId: string): Promise<void> {
  const db = await getDb()
  const boards = await db.getAllFromIndex('artboards', 'by-project', projectId)
  const msgs = await db.getAllFromIndex('messages', 'by-project', projectId)
  const tx = db.transaction(['projects', 'artboards', 'messages'], 'readwrite')
  await Promise.all([
    tx.objectStore('projects').delete(projectId),
    ...boards.map((b) => tx.objectStore('artboards').delete(b.id)),
    ...msgs.map((m) => tx.objectStore('messages').delete(m.id)),
    tx.done,
  ])
}

export async function loadArtboards(projectId: string): Promise<Artboard[]> {
  const db = await getDb()
  const all = await db.getAllFromIndex('artboards', 'by-project', projectId)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function loadMessages(projectId: string): Promise<ChatMessage[]> {
  const db = await getDb()
  const all = await db.getAllFromIndex('messages', 'by-project', projectId)
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export async function putArtboard(artboard: Artboard): Promise<void> {
  const db = await getDb()
  await db.put('artboards', plain(artboard))
}

export async function deleteArtboard(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('artboards', id)
}

export async function putMessage(msg: ChatMessage): Promise<void> {
  const db = await getDb()
  await db.put('messages', plain(msg))
}
