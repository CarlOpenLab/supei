/**
 * 内置演示模式：不调用网络，用一段预设的高质量 HTML 模拟「流式生成」，
 * 用于无 API Key 时体验完整流程，也用于端到端自测。
 * 迭代走与真实模型一致的 SEARCH/REPLACE diff 协议。
 */

export const DEMO_PALETTES = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#0ea5e9']

function soft(hex: string): string {
  return hex + '18'
}

function rootLine(accent: string): string {
  return `  :root { --accent: ${accent}; --accent-soft: ${soft(accent)}; --ink: #18181b; --muted: #71717a; --bg: #fafafa; }`
}

function badgeLine(seed: number): string {
  const text = seed === 0 ? '全新发布 · v1.0' : `已按反馈调整 · 第 ${seed} 轮`
  return `    <div class="badge">${text}</div>`
}

function demoHtml(seed: number): string {
  const accent = DEMO_PALETTES[seed % DEMO_PALETTES.length]
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Aurora 数据看板 — 产品主页</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
${rootLine(accent)}
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: var(--ink); background: var(--bg); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 20px 48px; background: #fff; border-bottom: 1px solid #e4e4e7; position: sticky; top: 0; z-index: 10; }
  .logo { font-weight: 700; font-size: 18px; letter-spacing: -0.5px; }
  .logo span { color: var(--accent); }
  nav a { color: var(--muted); text-decoration: none; margin-left: 28px; font-size: 14px; }
  nav a:hover { color: var(--ink); }
  .hero { text-align: center; padding: 88px 24px 64px; }
  .badge { display: inline-block; background: var(--accent-soft); color: var(--accent); font-size: 13px; font-weight: 600; padding: 5px 14px; border-radius: 999px; margin-bottom: 24px; }
  h1 { font-size: 46px; line-height: 1.15; letter-spacing: -1.5px; max-width: 640px; margin: 0 auto; }
  h1 em { font-style: normal; color: var(--accent); }
  .sub { color: var(--muted); font-size: 17px; max-width: 520px; margin: 18px auto 36px; line-height: 1.7; }
  .cta-row { display: flex; gap: 14px; justify-content: center; }
  .btn { padding: 12px 28px; border-radius: 10px; font-size: 15px; font-weight: 600; border: none; cursor: pointer; }
  .btn-primary { background: var(--accent); color: #fff; box-shadow: 0 6px 16px var(--accent-soft); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-ghost { background: #fff; color: var(--ink); border: 1px solid #d4d4d8; }
  .stats { display: flex; justify-content: center; gap: 72px; margin: 64px auto 0; }
  .stat b { font-size: 28px; letter-spacing: -1px; }
  .stat p { color: var(--muted); font-size: 13px; margin-top: 4px; }
  .features { max-width: 960px; margin: 96px auto; padding: 0 24px; }
  .features h2 { text-align: center; font-size: 28px; letter-spacing: -0.5px; margin-bottom: 40px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
  .card { background: #fff; border: 1px solid #e4e4e7; border-radius: 14px; padding: 26px; transition: box-shadow .2s, transform .2s; }
  .card:hover { box-shadow: 0 12px 28px rgba(0,0,0,0.07); transform: translateY(-2px); }
  .card .icon { width: 40px; height: 40px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 18px; font-weight: 700; margin-bottom: 16px; }
  .card h3 { font-size: 16px; margin-bottom: 8px; }
  .card p { color: var(--muted); font-size: 13.5px; line-height: 1.7; }
  footer { border-top: 1px solid #e4e4e7; padding: 32px 48px; color: var(--muted); font-size: 13px; display: flex; justify-content: space-between; background: #fff; }
</style>
</head>
<body>
  <header>
    <div class="logo">Aurora<span>.</span></div>
    <nav>
      <a href="#">产品</a><a href="#">定价</a><a href="#">文档</a><a href="#">登录</a>
    </nav>
  </header>
  <section class="hero">
${badgeLine(seed)}
    <h1>让业务数据，<em>一目了然</em></h1>
    <p class="sub">Aurora 帮助团队在 5 分钟内连接数据源，搭建可共享的实时看板，不再等待周报。</p>
    <div class="cta-row">
      <button class="btn btn-primary">免费开始使用</button>
      <button class="btn btn-ghost">预约演示</button>
    </div>
    <div class="stats">
      <div class="stat"><b>12,000+</b><p>活跃团队</p></div>
      <div class="stat"><b>99.99%</b><p>服务可用性</p></div>
      <div class="stat"><b>5 分钟</b><p>平均搭建耗时</p></div>
    </div>
  </section>
  <section class="features">
    <h2>为什么选择 Aurora</h2>
    <div class="grid">
      <div class="card"><div class="icon">⚡</div><h3>极速接入</h3><p>内置 40+ 数据源连接器，拖拽即可完成配置，无需编写任何 SQL。</p></div>
      <div class="card"><div class="icon">实时</div><h3>实时刷新</h3><p>数据变更秒级推送到所有看板，团队看到的永远是最新状态。</p></div>
      <div class="card"><div class="icon">协同</div><h3>一键共享</h3><p>链接分享与细粒度权限控制，让业务、运营、管理层看同一份数据。</p></div>
    </div>
  </section>
  <footer>
    <div>© 2026 Aurora Analytics</div>
    <div>服务条款 · 隐私政策</div>
  </footer>
</body>
</html>`
}

/** 把演示 HTML 切成小块，模拟流式输出。 */
export async function* streamDemo(seed: number, signal?: AbortSignal): AsyncGenerator<string> {
  const html = demoHtml(seed)
  const chunkSize = 180
  for (let i = 0; i < html.length; i += chunkSize) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    yield html.slice(i, i + chunkSize)
    await new Promise((r) => setTimeout(r, 40))
  }
}

/**
 * 演示模式的迭代：输出 SEARCH/REPLACE 块（与真实模型同一协议）。
 * fromSeed 是画板当前版本对应的 seed，toSeed 是迭代目标。
 */
export async function* streamDemoDiff(
  fromSeed: number,
  toSeed: number,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const oldAccent = DEMO_PALETTES[fromSeed % DEMO_PALETTES.length]
  const newAccent = DEMO_PALETTES[toSeed % DEMO_PALETTES.length]
  const text = [
    [
      '<<<<<<< SEARCH',
      rootLine(oldAccent),
      '=======',
      rootLine(newAccent),
      '>>>>>>> REPLACE',
    ].join('\n'),
    [
      '<<<<<<< SEARCH',
      badgeLine(fromSeed),
      '=======',
      badgeLine(toSeed),
      '>>>>>>> REPLACE',
    ].join('\n'),
  ].join('\n\n')
  const chunkSize = 120
  for (let i = 0; i < text.length; i += chunkSize) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    yield text.slice(i, i + chunkSize)
    await new Promise((r) => setTimeout(r, 45))
  }
}
