import type { Artboard } from '@/types'

export interface ViewerBoard {
  title: string
  html: string
}

/**
 * 整项目导出：全部画板最新版 → 单文件交互式预览页。
 * 画板 HTML 以 JSON（< 转义 \u003c）嵌入，viewer 自身零依赖；
 * 接收方双击打开即可翻页浏览，或直接取各画板源码交给开发。
 */
export function buildProjectViewerHtml(projectTitle: string, boards: Artboard[]): string {
  const items: ViewerBoard[] = boards
    .map((b) => {
      const cur = b.versions.find((v) => v.id === b.currentVersionId) ?? b.versions[b.versions.length - 1]
      return { title: b.title, html: cur?.html ?? '' }
    })
    .filter((b) => b.html.length > 100)
  const payload = JSON.stringify(items).replace(/</g, '\\u003c')
  const safeTitle = escapeHtml(projectTitle || '未命名项目')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>${safeTitle} · 原型预览</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column;
    background: #0a0a0a; color: rgba(255,255,255,.95);
    font-family: 'Inter', -apple-system, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,.07);
    background: #0d0d0d; flex: none;
  }
  header .mark {
    width: 20px; height: 20px; border-radius: 6px;
    background: linear-gradient(135deg, #1677ff 10%, #ff6b47 110%);
  }
  header h1 { font-size: 14px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  header .count {
    margin-left: auto; font-family: ui-monospace, Consolas, monospace;
    font-size: 11px; color: rgba(255,255,255,.38); letter-spacing: .08em;
  }
  main { flex: 1; display: flex; min-height: 0; }
  nav {
    width: 224px; flex: none; overflow-y: auto;
    border-right: 1px solid rgba(255,255,255,.07); background: #0d0d0d;
    padding: 10px 8px; display: flex; flex-direction: column; gap: 2px;
  }
  nav button {
    display: flex; align-items: center; gap: 9px;
    border: none; background: transparent; color: rgba(255,255,255,.85);
    font-size: 13px; text-align: left; padding: 9px 10px; border-radius: 8px;
    cursor: pointer; font-family: inherit; transition: background .12s ease;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  nav button:hover { background: rgba(255,255,255,.05); }
  nav button.on { background: rgba(22,119,255,.14); color: #c79bf5; }
  nav button .idx {
    font-family: ui-monospace, Consolas, monospace; font-size: 11px;
    color: rgba(255,255,255,.35); flex: none; width: 20px;
  }
  .stage { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .stage iframe { flex: 1; border: 0; background: #fff; width: 100%; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,.38); font-size: 13px; }
  [hidden] { display: none !important; }
  footer {
    padding: 8px 18px; border-top: 1px solid rgba(255,255,255,.07);
    font-size: 11px; color: rgba(255,255,255,.35); text-align: center; flex: none;
  }
  footer kbd {
    font-family: ui-monospace, Consolas, monospace; font-size: 10px;
    padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.08); color: rgba(255,255,255,.6);
  }
  ::-webkit-scrollbar { width: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 4px; }
</style>
</head>
<body>
<header>
  <span class="mark"></span>
  <h1>${safeTitle}</h1>
  <span class="count" id="count"></span>
</header>
<main>
  <nav id="nav"></nav>
  <div class="stage"><iframe id="frame" sandbox="allow-same-origin allow-scripts" title="画板预览"></iframe><div class="empty" id="empty" hidden>该项目暂无可预览的画板</div></div>
</main>
<footer>← <kbd>→</kbd> 切换画板 · 由 AI 原型画布导出，画板源码可直接交给正式开发</footer>
<script id="dc-data" type="application/json">${payload}</script>
<script>
(function () {
  var data = [];
  try { data = JSON.parse(document.getElementById('dc-data').textContent); } catch (e) {}
  var nav = document.getElementById('nav');
  var frame = document.getElementById('frame');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var cur = 0;
  if (!data.length) { nav.remove(); empty.hidden = false; count.textContent = '0 画板'; return; }
  count.textContent = data.length + ' 画板';
  data.forEach(function (b, i) {
    var btn = document.createElement('button');
    btn.innerHTML = '<span class="idx">' + String(i + 1).padStart(2, '0') + '</span>' + escapeText(b.title || ('画板 ' + (i + 1)));
    btn.onclick = function () { show(i); };
    nav.appendChild(btn);
  });
  function show(i) {
    cur = i;
    frame.srcdoc = data[i].html;
    var btns = nav.querySelectorAll('button');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('on', k === i);
  }
  function escapeText(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' && cur < data.length - 1) show(cur + 1);
    if (e.key === 'ArrowLeft' && cur > 0) show(cur - 1);
  });
  show(0);
})();
</script>
</body>
</html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

/** 触发浏览器下载 */
export function downloadViewer(filename: string, html: string) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
