import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  branchPosition,
  branchTitle,
  captureRootOf,
  findFreeSpot,
  manualBranchTitle,
} from './boardBranch.ts'

const board = (x: number, y: number, width = 800, height = 600) => ({ x, y, width, height })
const link = (id: string, parent?: string, capture?: unknown) => ({ id, parent, capture })

test('branchPosition 把新画板放在源画板右侧，并留出间距', () => {
  assert.deepEqual(branchPosition(board(0, 0), [], 60), { x: 860, y: 0 })
})

test('branchPosition 在右侧被占用时向下找空位', () => {
  const occupied = [board(0, 0), board(860, 0)]
  assert.deepEqual(branchPosition(board(0, 0), occupied, 60), { x: 860, y: 648 })
})

test('findFreeSpot 跳过重叠画板，返回不重叠的位置', () => {
  const occupied = [board(100, 0)]
  assert.deepEqual(findFreeSpot(100, 0, 800, 600, occupied), { x: 100, y: 648 })
})

test('branchTitle 用提示首行命名，并去重', () => {
  assert.equal(branchTitle('落地页', [], '把导航改成深色\n其余不变'), '把导航改成深色')
  assert.equal(branchTitle('落地页', ['把导航改成深色'], '把导航改成深色'), '把导航改成深色 2')
})

test('branchTitle 没有提示时回退到「源标题 · 改版」并去重', () => {
  assert.equal(branchTitle('落地页', []), '落地页 · 改版')
  assert.equal(branchTitle('落地页 · 改版', ['落地页 · 改版']), '落地页 · 改版 2')
})

test('branchTitle 截断过长提示', () => {
  assert.equal(
    branchTitle('落地页', [], '把顶部导航的背景改成深色并增加一个搜索框'),
    '把顶部导航的背景改成深色并增加一个搜',
  )
})

test('manualBranchTitle 用「源标题 · 手动修改」并去重', () => {
  assert.equal(manualBranchTitle('落地页', []), '落地页 · 手动修改')
  assert.equal(manualBranchTitle('落地页', ['落地页 · 手动修改']), '落地页 · 手动修改 2')
})

test('manualBranchTitle 从改版标题回到根标题', () => {
  assert.equal(manualBranchTitle('落地页 · 改版 2', []), '落地页 · 手动修改')
})

test('captureRootOf 沿父链找到带 capture 的根画板', () => {
  const root = link('a', undefined, { repoDir: '/repo' })
  const mid = link('b', 'a')
  const leaf = link('c', 'b')
  const all = new Map([root, mid, leaf].map((b) => [b.id, b]))
  assert.equal(captureRootOf(leaf, (id) => all.get(id)), root)
})

test('captureRootOf 在子画板也带 capture 时仍返回最上层来源', () => {
  const root = link('a', undefined, { repoDir: '/repo' })
  const leaf = link('b', 'a', { repoDir: '/repo' })
  const all = new Map([root, leaf].map((b) => [b.id, b]))
  assert.equal(captureRootOf(leaf, (id) => all.get(id)), root)
})

test('captureRootOf 没有捕获来源时返回 undefined', () => {
  const root = link('a')
  const leaf = link('b', 'a')
  const all = new Map([root, leaf].map((b) => [b.id, b]))
  assert.equal(captureRootOf(leaf, (id) => all.get(id)), undefined)
})
