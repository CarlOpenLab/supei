/**
 * Worker 节拍器：后台标签页的 setTimeout 会被浏览器强节流（最低 1 次/秒甚至冻结），
 * 导致演示流式在切走标签后卡死。Worker 里的计时器不受该节流影响。
 */
let worker: Worker | null = null

function getWorker(): Worker | null {
  if (worker) return worker
  try {
    const src = 'self.onmessage = (e) => { setTimeout(() => postMessage(e.data), e.data.ms) }'
    const blob = new Blob([src], { type: 'text/javascript' })
    worker = new Worker(URL.createObjectURL(blob))
  } catch {
    worker = null
  }
  return worker
}

/** 可跨标签节流存活的 sleep：Worker 计时优先，失败回退 setTimeout。 */
export function sleepUnthrottled(ms: number): Promise<void> {
  const w = getWorker()
  if (!w) return new Promise((r) => setTimeout(r, ms))
  return new Promise((resolve) => {
    const onTick = (e: MessageEvent) => {
      if (e.data?.ms !== ms) return
      w.removeEventListener('message', onTick)
      resolve()
    }
    w.addEventListener('message', onTick)
    w.postMessage({ ms })
  })
}
