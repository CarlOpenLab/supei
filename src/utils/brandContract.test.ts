import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  contractPrompt,
  defaultBrandContract,
  hasContract,
  sanitizeToken,
  TOKEN_PREFIX,
  tokensCSS,
} from './brandContract.ts'
import type { BrandContract } from '../types.ts'

const CONTRACT: BrandContract = {
  voice: '克制、纸感。',
  palette: [
    { token: 'primary', color: '#2F5D50' },
    { token: 'bg', color: '#F7F5F0' },
    { token: '无效!!', color: '#333' }, // token 非法 → 该行不出现
    { token: 'no-color', color: '   ' }, // 无色值 → 该行不出现
  ],
  fontDisplay: 'Fraunces',
  fontBody: 'Inter',
  radius: '10px',
  spacing: '8px',
  rules: '不使用蓝紫渐变。',
}

test('sanitizeToken：小写化、去非法字符、折叠连字符', () => {
  assert.equal(sanitizeToken('  Primary  '), 'primary')
  assert.equal(sanitizeToken('品牌 主色'), '')
  assert.equal(sanitizeToken('--A!!-b---c-'), 'a-b-c')
})

test('tokensCSS：逐 token 输出变量，跳过非法行，含字体/圆角/间距', () => {
  const css = tokensCSS(CONTRACT, '官网')
  assert.ok(css.includes(`/* tokens.css — 官网 的品牌契约`))
  assert.ok(css.includes(':root {'))
  assert.ok(css.trimEnd().endsWith('}'))
  assert.ok(css.includes(`${TOKEN_PREFIX}primary: #2F5D50;`))
  assert.ok(css.includes(`${TOKEN_PREFIX}bg: #F7F5F0;`))
  assert.ok(!css.includes('!!!'))
  assert.ok(!css.includes('no-color'))
  assert.ok(css.includes(`${TOKEN_PREFIX}font-display: "Fraunces";`))
  assert.ok(css.includes(`${TOKEN_PREFIX}font-body: "Inter";`))
  assert.ok(css.includes(`${TOKEN_PREFIX}radius: 10px;`))
  assert.ok(css.includes(`${TOKEN_PREFIX}spacing: 8px;`))
})

test('tokensCSS：字体栈原样使用，不加引号；全空契约返回空串', () => {
  const css = tokensCSS({ ...CONTRACT, fontBody: '-apple-system, "PingFang SC", sans-serif' })
  assert.ok(css.includes(`${TOKEN_PREFIX}font-body: -apple-system, "PingFang SC", sans-serif;`))
  const empty: BrandContract = {
    voice: '',
    palette: [],
    fontDisplay: '',
    fontBody: '',
    radius: '',
    spacing: '',
    rules: '',
  }
  assert.equal(tokensCSS(empty), '')
  assert.equal(hasContract(empty), false)
})

test('contractPrompt：包含变量清单、调性、纪律与优先级声明；未启用返回空串', () => {
  const prompt = contractPrompt(CONTRACT)
  assert.ok(prompt.includes('【品牌契约'))
  assert.ok(prompt.includes(`${TOKEN_PREFIX}primary: #2F5D50;`))
  assert.ok(prompt.includes('品牌调性：克制、纸感。'))
  assert.ok(prompt.includes('自定义硬规则'))
  assert.ok(prompt.includes('以本契约为准'))
  assert.equal(contractPrompt(null), '')
  assert.equal(hasContract({ ...CONTRACT, voice: '', palette: [], rules: '' }), true, '只剩字体也算启用')
})

test('defaultBrandContract：给出的种子必须能渲染出 tokens.css 与约束段', () => {
  const c = defaultBrandContract()
  assert.ok(tokensCSS(c).includes('--brand-primary'))
  assert.ok(contractPrompt(c).length > 100)
})
