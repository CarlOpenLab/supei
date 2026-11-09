import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySearchReplace, parseSearchReplace } from './searchReplace.ts'

test('parseSearchReplace：单个块', () => {
  const raw = `<<<<<<< SEARCH
<p>old</p>
=======
<p>new</p>
>>>>>>> REPLACE`
  assert.deepEqual(parseSearchReplace(raw), [{ search: '<p>old</p>', replace: '<p>new</p>' }])
})

test('parseSearchReplace：多个块 + 前后夹带说明文字', () => {
  const raw = `Here are the changes:
<<<<<<< SEARCH
a
=======
b
>>>>>>> REPLACE

<<<<<<< SEARCH
c
=======
d
>>>>>>> REPLACE`
  const blocks = parseSearchReplace(raw)
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { search: 'a', replace: 'b' })
  assert.deepEqual(blocks[1], { search: 'c', replace: 'd' })
})

test('parseSearchReplace：整块 wrapped 在代码围栏里', () => {
  const raw = '\`\`\`diff\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n\`\`\`'
  assert.deepEqual(parseSearchReplace(raw), [{ search: 'x', replace: 'y' }])
})

test('parseSearchReplace：空 SEARCH 块（纯插入）也保留，由应用方决定跳过', () => {
  const raw = `<<<<<<< SEARCH
=======
y
>>>>>>> REPLACE`
  assert.deepEqual(parseSearchReplace(raw), [{ search: '', replace: 'y' }])
})

test('parseSearchReplace：没有标记时返回空数组', () => {
  assert.deepEqual(parseSearchReplace('随便什么说明文字，没有标记'), [])
})

test('applySearchReplace：精确匹配替换', () => {
  const html = '<div><p>old text</p><p>keep</p></div>'
  const out = applySearchReplace(html, [{ search: '<p>old text</p>', replace: '<p>new text</p>' }])
  assert.equal(out, '<div><p>new text</p><p>keep</p></div>')
})

test('applySearchReplace：精确子串匹配保留原缩进（模型 search 未带缩进时）', () => {
  const html = '<div>\n  <p>old</p>\n  <p>keep</p>\n</div>'
  const out = applySearchReplace(html, [{ search: '<p>old</p>', replace: '<p>new</p>' }])
  assert.equal(out, '<div>\n  <p>new</p>\n  <p>keep</p>\n</div>')
})

test('applySearchReplace：宽松匹配容忍多行缩进差异，replace 保留模型给的行', () => {
  const html = '<div>\n  <p>old</p>\n</div>'
  const out = applySearchReplace(html, [
    { search: '<div>\n        <p>old</p>\n</div>', replace: '<div>\n    <p>new</p>\n</div>' },
  ])
  assert.equal(out, '<div>\n    <p>new</p>\n</div>')
})

test('applySearchReplace：多个块按顺序生效（重复内容各替换一次）', () => {
  const html = '<li>a</li><li>a</li>'
  const out = applySearchReplace(html, [
    { search: '<li>a</li>', replace: '<li>1</li>' },
    { search: '<li>a</li>', replace: '<li>2</li>' },
  ])
  assert.equal(out, '<li>1</li><li>2</li>')
})

test('applySearchReplace：空 SEARCH 的块被静默跳过', () => {
  const html = '<p>hi</p>'
  const out = applySearchReplace(html, [{ search: '', replace: '<b>x</b>' }])
  assert.equal(out, '<p>hi</p>')
})

test('applySearchReplace：找不到目标时抛错并带块序号', () => {
  assert.throws(
    () =>
      applySearchReplace('<p>a</p>', [
        { search: '<p>a</p>', replace: '<p>b</p>' },
        { search: 'MISSING', replace: 'zzz' },
      ]),
    /第 2 个修改块/,
  )
})
