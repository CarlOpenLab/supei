import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePluginFile } from './parse.ts'

test('parsePluginFile：markdown 风格包（frontmatter + 正文）', () => {
  const md = '---\nname: 北欧极简\n---\n大量留白背景，#E8E4DC，无衬线字体。'
  const entries = parsePluginFile(md, 'nordic.md')
  assert.equal(entries.length, 1)
  assert.deepEqual(entries[0], {
    kind: 'style',
    name: '北欧极简',
    data: { prompt: '大量留白背景，#E8E4DC，无衬线字体。' },
  })
})

test('parsePluginFile：markdown 无 frontmatter 时回退 h1 名称，再回退文件名', () => {
  const withH1 = parsePluginFile('# 粗野主义\n黑色文字，粗边框，超大标题。', 'pack.md')
  assert.equal(withH1[0]?.name, '粗野主义')
  const fallback = parsePluginFile('只是一段指令。', 'pure-black.md')
  assert.equal(fallback[0]?.name, 'pure-black')
  assert.equal((fallback[0]?.data as { prompt: string }).prompt, '只是一段指令。')
})

test('parsePluginFile：旧风格包 JSON（{name, prompt}）与数组形式', () => {
  const one = parsePluginFile('{"name":"玻璃拟态","prompt":"毛玻璃卡片…"}', 'p.json')
  assert.deepEqual(one, [{ kind: 'style', name: '玻璃拟态', data: { prompt: '毛玻璃卡片…' } }])
  const arr = parsePluginFile('[{"name":"A","prompt":"a"},{"name":"B","directive":"b"}]', 'p.json')
  assert.equal(arr.length, 2)
  assert.deepEqual(arr[1], { kind: 'style', name: 'B', data: { prompt: 'b' } })
})

test('parsePluginFile：manifest v2，条目自带 kind（含非法 kind 回退 style、尺寸不再混入 NaN）', () => {
  const manifest = {
    format: 'mygo-design-plugin',
    name: 'demo',
    plugins: [
      { name: '移动页', kind: 'template', width: '390', height: 700 },
      { name: '未知', kind: 'whatever', prompt: 'x' },
      { name: '图标', kind: 'icon', data: { 'arrow-right': 'M1 1L8 8' } },
      { name: '起步', prompt: '. 行驶 1' },
    ],
  }
  const entries = parsePluginFile(JSON.stringify(manifest), 'demo.json')
  assert.equal(entries.length, 4)
  assert.deepEqual(entries[0], { kind: 'template', name: '移动页', data: { width: 390, height: 700 } })
  assert.deepEqual(entries[1], { kind: 'style', name: '未知', data: { prompt: 'x' } })
  assert.deepEqual(entries[2], { kind: 'icon', name: '图标', data: { 'arrow-right': 'M1 1L8 8' } })
  assert.deepEqual(entries[3], { kind: 'style', name: '起步', data: { prompt: '. 行驶 1' } })
})

test('parsePluginFile：缺尺寸时回退默认值', () => {
  const entries = parsePluginFile(
    '{"format":"mygo-design-plugin","name":"t","plugins":[{"name":"页面","kind":"template","width":"abc"}]}',
    't.json',
  )
  assert.deepEqual((entries[0] as { data: { width: number; height: number } }).data, {
    width: 1280,
    height: 800,
  })
})

test('parsePluginFile：manifest 根级 kind 作为条目的默认 kind', () => {
  const entries = parsePluginFile(
    '{"format":"mygo-design-plugin","name":"t","kind":"preset","plugins":[{"name":"起点","prompt":"买菜应用","icon":"zap"}]}',
    't.json',
  )
  assert.deepEqual(entries[0], {
    kind: 'preset',
    name: '起点',
    data: { icon: 'zap', prompt: '买菜应用' },
  })
})
