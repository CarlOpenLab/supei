import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractHtml,
  insertIntoHead,
  looksLikeCompleteHtml,
  SANDBOX_CSP,
  withBoardCSP,
} from './htmlExtract.ts'

const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><style>body{color:#111}</style></head>
<body><pre>\`\`\`js
console.log(1)
\`\`\`</pre></body>
</html>`

test('extractHtml：完整文档原样保留，正文里的代码块不被误伤', () => {
  const out = extractHtml(doc)
  assert.ok(out.startsWith('<!DOCTYPE html>'))
  assert.ok(out.endsWith('</html>'))
  assert.ok(out.includes('console.log(1)'))
})

test('extractHtml：剥开头 code 围栏，截掉 </html> 之后的说明与尾围栏', () => {
  const raw = '说明文字\n```html\n<!DOCTYPE html>\n<html><body>hi</body></html>\n```\n结尾说明'
  const out = extractHtml(raw)
  assert.equal(out, '<!DOCTYPE html>\n<html><body>hi</body></html>')
})

test('extractHtml：流式未完成时保留正文中的围栏，只剥当前结尾的裸围栏', () => {
  const partial =
    '```html\n<!DOCTYPE html>\n<html><body><pre>```js\nconsole.log(2)\n```</pre></body>\n结尾裸围栏```'
  const out = extractHtml(partial)
  assert.ok(out.includes('console.log(2)'), '正文中的围栏不得被吞')
  assert.ok(!out.endsWith('```'))
})

test('extractHtml：从 <!doctype 或 <html 起截取，丢弃前缀说明', () => {
  const out = extractHtml('好的，这是页面：\n<html><head></head></html>')
  assert.ok(out.startsWith('<html>'))
})

test('looksLikeCompleteHtml', () => {
  assert.equal(looksLikeCompleteHtml(doc), true)
  assert.equal(looksLikeCompleteHtml('<html><body>'), false)
})

test('insertIntoHead：插到 <head> 开头（含属性写法）', () => {
  const out = insertIntoHead('<html>\n<head lang="en">\n<style></style>\n</head></html>', '<meta x>')
  assert.equal(out, '<html>\n<head lang="en">\n<meta x>\n<style></style>\n</head></html>')
})

test('insertIntoHead：无 head 退回 <html> 开头；无 html 前置', () => {
  assert.equal(insertIntoHead('<html><body></body></html>', '<meta x>'), '<html>\n<meta x><body></body></html>')
  assert.ok(insertIntoHead('<div>hi</div>', '<meta x>').startsWith('<meta x>'))
})

test('withBoardCSP：注入 sandbox CSP meta，且出现在正文样式之前', () => {
  const out = withBoardCSP(doc)
  assert.ok(out.includes(SANDBOX_CSP))
  assert.ok(out.indexOf(SANDBOX_CSP) < out.indexOf('<style>body'))
})
