/**
 * 画板缩略图（LOD）：缩放较小时用静态快照替代活 iframe，省合成与绘制开销。
 * 原理：HTML → XHTML 序列化 → SVG foreignObject data-URL → <img>。
 * 生成失败（外部资源/超时）返回 null，调用方回退活 iframe。
 */

const cache = new Map<string, string>()
const MAX_CACHE = 40

// —— IndexedDB 持久层：快照跨会话复用（独立小库，不动主库 schema） ——
let idb: Promise<IDBDatabase> | null = null
function openIdb(): Promise<IDBDatabase> {
  if (!idb) {
    idb = new Promise((resolve, reject) => {
      const req = indexedDB.open('dc-thumbs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('thumbs')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return idb
}
async function idbGet(key: string): Promise<string | null> {
  try {
    const db = await openIdb()
    return await new Promise((resolve) => {
      const r = db.transaction('thumbs').objectStore('thumbs').get(key)
      r.onsuccess = () => resolve((r.result as string) ?? null)
      r.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
async function idbPut(key: string, url: string) {
  try {
    const db = await openIdb()
    db.transaction('thumbs', 'readwrite').objectStore('thumbs').put(url, key)
  } catch {
    /* 持久化失败不影响内存缓存 */
  }
}

export function getThumb(
  key: string,
  html: string,
  w: number,
  h: number,
): Promise<string | null> {
  const hit = cache.get(key)
  if (hit) return Promise.resolve(hit)
  if (!html || html.length < 200 || w < 40 || h < 40) return Promise.resolve(null)
  return idbGet(key).then((persisted) => {
    if (persisted) {
      cache.set(key, persisted)
      return persisted
    }
    return generate(key, html, w, h)
  })
}

function generate(key: string, html: string, w: number, h: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      const styles = [...doc.head.querySelectorAll('style, link[rel="stylesheet"]')]
      const styleXml = styles.map((s) => new XMLSerializer().serializeToString(s)).join('')
      const bodyXml = new XMLSerializer().serializeToString(doc.body)
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
        `<foreignObject width="100%" height="100%">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:#fff">` +
        styleXml +
        bodyXml +
        `</div></foreignObject></svg>`
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
      const img = new Image()
      const timer = setTimeout(() => resolve(null), 2000)
      img.onload = () => {
        clearTimeout(timer)
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string)
        cache.set(key, url)
        void idbPut(key, url)
        resolve(url)
      }
      img.onerror = () => {
        clearTimeout(timer)
        resolve(null)
      }
      img.src = url
    } catch {
      resolve(null)
    }
  })
}
