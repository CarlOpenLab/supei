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

/** 渲染方式变更时递增：让旧算法持久化的缩略图失效 */
const RENDER_VERSION = 'r5:'

export function getThumb(
  cacheKey: string,
  html: string,
  w: number,
  h: number,
): Promise<string | null> {
  const key = RENDER_VERSION + cacheKey
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

const XHTML = 'http://www.w3.org/1999/xhtml'
const ROOT_ID = 'dc-thumb-root'

/**
 * @description foreignObject 里没有 html 根元素：把样式表中的 html / :root 选择器改指向外层容器，
 * 否则页面背景、color-scheme、html.dark 一类规则全部失效（深色页面会变成白底空白缩略图）。
 * @param css - 样式表文本
 * @returns 改写后的样式表文本
 */
function retargetRoot(css: string): string {
  // 左侧允许 :is( / :where( 的括号，但不能是 url( 里的路径
  return css.replace(/(^|[\s,{}>+~]|(?<!url)\()(html|:root)(?=[\s,{.:#[>+~)]|$)/g, `$1#${ROOT_ID}`)
}

function generate(key: string, html: string, w: number, h: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      // 外层容器代替 html 根元素：继承它的 class / data-* 等属性与内联样式
      const root = doc.createElementNS(XHTML, 'div')
      for (const a of doc.documentElement.attributes) {
        if (a.name !== 'id' && a.name !== 'style' && !a.name.startsWith('xmlns')) root.setAttribute(a.name, a.value)
      }
      root.id = ROOT_ID
      root.setAttribute(
        'style',
        `width:${w}px;height:${h}px;overflow:hidden;${doc.documentElement.getAttribute('style') ?? ''}`,
      )
      // 根元素的默认值：白底 + 随配色方案变化的 CanvasText 文字色（页面自己的 html 规则在后面，会覆盖）
      const rootDefaults = doc.createElementNS(XHTML, 'style')
      rootDefaults.textContent = `#${ROOT_ID}{background:#fff;color:CanvasText}`
      root.append(rootDefaults)
      for (const s of doc.head.querySelectorAll('style, link[rel="stylesheet"]')) {
        if (s.tagName === 'STYLE') s.textContent = retargetRoot(s.textContent ?? '')
        root.append(s)
      }
      root.append(doc.body)
      // 页面样式表对整份 SVG 生效：外层 <svg> 用内联样式挡住 svg { opacity / width … } 一类图标规则
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
        `style="display:block;width:${w}px;height:${h}px;margin:0;opacity:1;transform:none;filter:none">` +
        `<foreignObject width="100%" height="100%">` +
        new XMLSerializer().serializeToString(root) +
        `</foreignObject></svg>`
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
