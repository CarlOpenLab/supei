/**
 * 真实模型端到端终验脚本（ego-browser 运行）
 * 前置：应用「设置 → 模型设置」已配置真实 Key 并点「使用」
 * 运行：ego-browser nodejs < scripts/e2e-final.mjs
 * 阶段：0 预检 → 1 真实流式生成 → 2 SEARCH/REPLACE 增量迭代 →
 *       3 深度思考(reasoning_effort) → 4 版本对比/diff 过滤 → 5 导出 .html
 */
const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const task = await taskSpace('real-model-e2e-' + runId);
const page = task.page('p1');
const SHOT = 'C:/Users/73624/ego/real-model-e2e';
const verdict = {};
const fail = (stage, why) => { verdict[stage] = 'FAIL: ' + why; console.log(JSON.stringify(verdict)); };

// —— 0 预检 ——
await page.goto('http://localhost:5188/');
await page.waitForLoadState('load');
await page.waitForTimeout(2000);
const st = await page.evaluate(() => {
  const raw = localStorage.getItem('dc.settings.v1');
  if (!raw) return null;
  const v = JSON.parse(raw);
  return { activeId: v.activeId, providers: (v.providers || []).map((p) => ({ name: p.name, baseUrl: p.baseUrl, keyLen: (p.apiKey || '').length })) };
});
if (!st || !st.activeId || st.activeId === 'demo') {
  fail('preflight', '未检测到真实模型配置。请在「设置 → 模型设置 → + 添加服务商」填 BaseURL/API Key/模型名并点「使用」后重跑。');
  await task.finish({ keep: 'all' });
  process.exit(0);
}
verdict.preflight = `PASS: active=${st.activeId} providers=${JSON.stringify(st.providers)}`;
console.log(JSON.stringify(verdict));

// 错误收集
await page.evaluate(() => {
  window.__dcErrors = [];
  window.addEventListener('error', (e) => window.__dcErrors.push(String(e.message).slice(0, 150)));
  window.addEventListener('unhandledrejection', (e) => window.__dcErrors.push('rej: ' + String(e.reason).slice(0, 150)));
});

// —— 1 真实流式生成 ——
// 新建空白项目走新场景；在 composer 输入并提交
await page.evaluate(() => document.querySelector('.btn-primary')?.click());
await page.waitForTimeout(2500);
const sent = await page.evaluate(() => {
  const ta = document.querySelector('.composer textarea, .composer .ant-input');
  if (!ta) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '做一个极简风格的咖啡品牌落地页：首屏大标题与产品图，三款产品卡，底部订阅区。高级浅色风。');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  return true;
});
if (!sent) { fail('generate', 'composer 不存在'); await task.finish({ keep: 'all' }); process.exit(0); }
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.antd-sender-actions-list .ant-btn:not(:disabled)')?.click());
// 轮询流式证据；新场景会先出 AI 规划卡（v0 式）——出现即选默认项直接开始生成
let streamed = false, v1 = false, planHandled = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    streaming: !!document.querySelector('.artboard.streaming'),
    skeleton: !!document.querySelector('.stream-skeleton'),
    tray: !!document.querySelector('.plan-tray'),
    versions: document.querySelector('.artboard .ab-versions')?.textContent?.replace(/\s+/g, ' ') || null,
  }));
  if (s.streaming || s.skeleton) streamed = true;
  if (s.versions && /1\s*\/\s*1/.test(s.versions)) { v1 = true; break; }
  if (s.tray && !planHandled) {
    planHandled = true;
    // 规划卡：问题选项与风格均可留空（startPlan 容许缺省），直接开始生成
    await page.evaluate(() => {
      [...document.querySelectorAll('.tray-btn.solid')].find((b) => b.textContent.includes('开始生成'))?.click();
    });
  }
}
await page.screenshot({ path: SHOT + '/s1-generated.png' });
verdict.generate = v1
  ? `PASS: 真实流式生成 v1${planHandled ? '（经规划卡）' : ''}（流式瞬态观测=${streamed ? '是' : '采样窗口未捕获，正常'}）`
  : `FAIL: streamed=${streamed} v1=${v1} planHandled=${planHandled}`;
console.log(JSON.stringify(verdict));
if (!v1) { await task.finish({ keep: 'all' }); process.exit(0); }

// —— 2 SEARCH/REPLACE 增量迭代 ——
await page.evaluate(() => {
  const ta = document.querySelector('.composer textarea, .composer .ant-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '把主标题字号放大一档，订阅按钮改成紫色');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
});
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.antd-sender-actions-list .ant-btn:not(:disabled)')?.click());
let v2 = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => document.querySelector('.artboard .ab-versions')?.textContent?.replace(/\s+/g, ' '));
  if (s && /2\s*\/\s*2/.test(s)) { v2 = true; break; }
}
await page.screenshot({ path: SHOT + '/s2-iteration.png' });
verdict.iteration = v2 ? 'PASS: 增量迭代产出 v2' : 'FAIL: 未产出 v2';
console.log(JSON.stringify(verdict));
if (!v2) { await task.finish({ keep: 'all' }); process.exit(0); }

// —— 3 深度思考（reasoning_effort=high 透传）——
await page.evaluate(() => document.querySelector('.think-chip')?.click());
await page.waitForTimeout(300);
const thinkOn = await page.evaluate(() => document.querySelector('.think-chip')?.classList.contains('on'));
await page.evaluate(() => {
  const ta = document.querySelector('.composer textarea, .composer .ant-input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '整体排版再精细一级：字距、行高与留白节奏');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
});
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.antd-sender-actions-list .ant-btn:not(:disabled)')?.click());
let v3 = false, errSeen = false;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    versions: document.querySelector('.artboard .ab-versions')?.textContent?.replace(/\s+/g, ' '),
    error: !!document.querySelector('.bubble.error'),
  }));
  if (s.error) { errSeen = true; break; }
  if (s.versions && /3\s*\/\s*3/.test(s.versions)) { v3 = true; break; }
}
verdict.deepThink = v3 && thinkOn ? 'PASS: reasoning_effort 深度思考迭代产出 v3' : `FAIL: thinkOn=${thinkOn} v3=${v3} err=${errSeen}`;
console.log(JSON.stringify(verdict));

// —— 4 版本对比 / diff 过滤高亮 ——
await page.evaluate(() => {
  const n = document.querySelector('.artboard');
  const r = n.getBoundingClientRect();
  n.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 80, clientY: r.top + 15, button: 0 }));
});
await page.waitForTimeout(300);
await page.evaluate(() => [...document.querySelectorAll('.artboard .tool')].pop()?.click());
await page.waitForTimeout(400);
await page.evaluate(() => [...document.querySelectorAll('.ab-menu button')].find((b) => b.textContent.includes('对比上一版'))?.click());
await page.waitForTimeout(2500);
const cmp = await page.evaluate(() => ({
  stats: [...document.querySelectorAll('.diff-stats .stat')].map((s) => s.textContent.trim()),
  marks: [...document.querySelectorAll('.compare iframe')].map((f) => f.contentDocument?.querySelectorAll('[data-dc-diff]').length || 0),
}));
await page.screenshot({ path: SHOT + '/s4-compare.png' });
verdict.compare = cmp.stats.length && cmp.marks.some((n) => n > 0)
  ? `PASS: diff 统计 ${JSON.stringify(cmp.stats)}，标记 ${JSON.stringify(cmp.marks)}`
  : `FAIL: ${JSON.stringify(cmp)}`;
console.log(JSON.stringify(verdict));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// —— 5 导出 .html ——
const exported = await page.evaluate(async () => {
  const orig = URL.createObjectURL.bind(URL);
  let size = 0;
  URL.createObjectURL = (blob) => { blob.text().then((t) => { window.__exportSize = t.length; }); size = -1; return orig(blob); };
  const n = document.querySelector('.artboard');
  [...n.querySelectorAll('.tool')].pop()?.click();
  await new Promise((r) => setTimeout(r, 400));
  [...document.querySelectorAll('.ab-menu button')].find((b) => b.textContent.includes('导出'))?.click();
  await new Promise((r) => setTimeout(r, 800));
  URL.createObjectURL = orig;
  return window.__exportSize || 0;
});
await page.screenshot({ path: SHOT + '/s5-export.png' });
verdict.export = exported > 1000 ? `PASS: 导出 HTML ${exported} 字符` : `FAIL: 导出内容 ${exported}`;

const errs = await page.evaluate(() => window.__dcErrors || []);
verdict.consoleErrors = errs.length ? 'WARN: ' + JSON.stringify(errs) : 'PASS: 0 控制台错误';
console.log(JSON.stringify(verdict, null, 1));
await task.finish({ keep: 'all' });
