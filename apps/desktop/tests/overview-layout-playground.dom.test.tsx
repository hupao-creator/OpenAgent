// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { OverviewLayoutPlayground } from '../playgrounds/overview-motion/src/OverviewLayoutPlayground'
import { parseLayoutCase } from '../playgrounds/overview-motion/src/layout-cases'

afterEach(cleanup)
const mount = () => render(<StrictMode><OverviewLayoutPlayground /></StrictMode>)
const positions = () => [...document.querySelectorAll<HTMLElement>('[data-layout-id]')].map(p => ({ id: p.dataset.layoutId, col: p.dataset.col, row: p.dataset.row }))

it('shows the 24-member result and closes a deleted slot through ordered straight moves', () => {
  mount()
  expect(screen.getByLabelText('布局宽高')).toHaveTextContent('1488 × 1280')
  const initial = positions()
  expect(initial).toHaveLength(24)
  expect(new Set(initial.map(p => p.col)).size).toBe(4)
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByLabelText('移动成员数')).toHaveTextContent('0')
  expect(positions().filter(p => p.id !== '25')).toEqual(initial)
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(positions().filter(p => p.col !== '0')).toEqual(initial.filter(p => p.col !== '0'))
  expect(screen.getByLabelText('移动顺序')).toHaveTextContent('05 → 09 → 13 → 17 → 21 → 25')
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  expect(positions()).toHaveLength(25)
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('replays the one-member shift and exposes the exact moved identity', () => {
  mount()
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '1' } })
  expect(screen.getByLabelText('移动成员数')).toHaveTextContent('1')
  expect(screen.getByText('移动成员：A')).toBeInTheDocument()
  expect(document.querySelector('[data-layout-id="B"]')).toHaveAttribute('data-col', '1')
  expect(document.querySelector('[data-layout-id="B"]')).toHaveAttribute('data-row', '0')
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByLabelText('布局宽高')).toHaveTextContent('360 × 632')
})

it('shows the aspect-first scenario even though the old three-column layout needed no shifts', () => {
  mount()
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '3' } })
  expect(screen.getByLabelText('布局宽高')).toHaveTextContent('1488 × 1280')
  expect(Number(screen.getByLabelText('移动成员数').textContent)).toBeGreaterThan(0)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByText('合法方案 · 搜索尚未完成')).toBeInTheDocument()
  expect(screen.getByLabelText('总位移距离')).toHaveTextContent('6153.8')
  expect(Number(screen.getByLabelText('候选搜索计步').textContent)).toBeGreaterThan(0)
})

it('measures total pixel travel and keeps already optimal offset layouts in place', () => {
  mount()
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '4' } })
  expect(screen.getByLabelText('移动成员数')).toHaveTextContent('4')
  expect(screen.getByLabelText('总位移距离')).toHaveTextContent('1299.3')
  expect(screen.getByText('搜索已完成 · 浮点结果，未认证精确最优')).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '2' } })
  expect(screen.getByLabelText('总位移距离')).toHaveTextContent('0.0')
  expect(positions()[0]).toMatchObject({ col: '1', row: '1' })
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(screen.getByLabelText('总位移距离')).toHaveTextContent('0.0')
  expect(positions().every(p => p.col === '2')).toBe(true)
})

it('imports the exact generated PBT counterexample and keeps the last result on invalid input', () => {
  mount()
  const testCase = { version: 1, name: 'Shrunk case', geometry: { columnWidth: 360, rowHeight: 200, gap: 16 }, previous: [],
    steps: [{ label: '新增 A', members: [{ id: 'A', cols: 1, rows: 1 }] },
      { label: '删除 A', members: [] }] }
  const json = JSON.stringify({ counterexample: [testCase] })
  fireEvent.change(screen.getByLabelText('场景 JSON'), { target: { value: json } })
  fireEvent.click(screen.getByRole('button', { name: '载入 JSON' }))
  expect(positions()).toEqual([{ id: 'A', col: '0', row: '0' }])
  fireEvent.click(screen.getByRole('button', { name: '下一步' }))
  expect(positions()).toEqual([])
  expect(screen.getByLabelText('布局比例')).toHaveTextContent('—')
  fireEvent.change(screen.getByLabelText('场景 JSON'), { target: { value: '{}' } })
  fireEvent.click(screen.getByRole('button', { name: '载入 JSON' }))
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(positions()).toEqual([])
  expect(parseLayoutCase(json)).toEqual(testCase)
})

it('generates repeatable sequences and allows a manual branch after replaying backwards', () => {
  mount()
  fireEvent.change(screen.getByLabelText('随机种子'), { target: { value: '1234' } })
  fireEvent.click(screen.getByRole('button', { name: '生成序列' }))
  const initial = positions()
  fireEvent.click(screen.getByRole('button', { name: '生成序列' }))
  expect(positions()).toEqual(initial)
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '0' } })
  fireEvent.click(screen.getByRole('button', { name: '新增 1×1' }))
  expect(positions()).toHaveLength(25)
  fireEvent.click(screen.getByRole('button', { name: '上一步' }))
  fireEvent.click(screen.getByRole('button', { name: '选择卡片 01' }))
  fireEvent.click(screen.getByRole('button', { name: '移除' }))
  expect(positions()).toHaveLength(23)
  expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled()
})


it('fills the removed middle card and exposes a straight-motion scrubber', () => {
  mount()
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '5' } })
  expect(screen.getByLabelText('移动顺序')).toHaveTextContent('09')
  expect(screen.getByLabelText('总位移距离')).toHaveTextContent('376.0')
  expect(positions().find(p => p.id === '09')).toMatchObject({ col: '1', row: '2' })
  fireEvent.change(screen.getByLabelText('移动进度'), { target: { value: '0.5' } })
  expect(positions().find(p => p.id === '09')).toMatchObject({ col: '0.5', row: '2' })
  expect(screen.getByLabelText('布局宽高')).toHaveTextContent('1488 × 1280')
  fireEvent.change(screen.getByLabelText('布局场景'), { target: { value: '6' } })
  expect(screen.getByLabelText('移动进度')).toHaveValue('1')
  expect(screen.getByLabelText('移动顺序')).toHaveTextContent('A → B')
  fireEvent.change(screen.getByLabelText('移动进度'), { target: { value: '0.25' } })
  expect(positions().find(p => p.id === 'A')).toMatchObject({ col: '0', row: '0.5' })
  expect(positions().find(p => p.id === 'B')).toMatchObject({ col: '1', row: '0' })
})
