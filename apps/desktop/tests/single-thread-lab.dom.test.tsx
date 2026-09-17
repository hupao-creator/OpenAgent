// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { fakeSnapshots } from '../playgrounds/single-thread/src/fake-snapshots'
import { SingleThreadLab } from '../playgrounds/single-thread/src/SingleThreadLab'
import { parseSnapshot } from '../playgrounds/single-thread/src/snapshots'
import { AppI18nProvider } from '../src/renderer/src/i18n'
import { createInitialRendererState } from '../src/shared/renderer-state'

const state = {
  ...createInitialRendererState('/workspace'), revision: 42,
  reports: [{ id: 'report', title: '真实快照接口测试', tags: [], relatedExecutions: [{ threadId: 'deleted', executionId: 'deleted-execution' }],
    createdAt: 1, updatedAt: 2, archived: false, previewText: 'Renderer-safe text' }]
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/') })

it('validates renderer snapshots without rebuilding state and rejects Main-only Report HTML', () => {
  expect(parseSnapshot(state)).toBe(state)
  expect(() => parseSnapshot({ ...state, reports: [{ ...state.reports[0], html: '<script>bad()</script>' }] })).toThrow()
  expect(() => parseSnapshot({ ...state, revision: -1 })).toThrow()
})

it('renders every bundled fake scene without fetching real captures', async () => {
  const fetch = vi.fn(() => { throw new Error('Lab must work offline') })
  vi.stubGlobal('fetch', fetch)
  expect(fakeSnapshots).toHaveLength(31)
  for (const scene of fakeSnapshots) {
    window.history.replaceState(null, '', `/?kind=${scene.harness === 'report' ? 'report' : 'agent'}&harness=${scene.harness}&case=${scene.scenario}`)
    render(<AppI18nProvider locale="zh-CN"><SingleThreadLab /></AppI18nProvider>)
    await waitFor(() => expect(document.querySelectorAll('[data-overview-card-id]')).toHaveLength(1))
    expect(document.querySelector('.single-lab-grid')).toHaveAttribute('data-snapshot', scene.snapshot)
    cleanup()
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('renders Claude questions and keeps submitted fake snapshots immutable', async () => {
  window.history.replaceState(null, '', '/?kind=agent&harness=claude&case=question')
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1400)
  const before = JSON.stringify(fakeSnapshots)
  const user = userEvent.setup()
  render(<AppI18nProvider locale="zh-CN"><SingleThreadLab /></AppI18nProvider>)
  await screen.findAllByText('搜索需要覆盖哪些内容？')
  await user.click(screen.getByRole('button', { name: '项目名称' }))
  await user.click(screen.getByRole('button', { name: '提交回答' }))
  expect(document.querySelector('output')).toHaveTextContent('记录回应')
  await user.click(screen.getByRole('button', { name: '重置交互' }))
  expect(screen.getByRole('button', { name: '提交回答' })).toBeDisabled()
  await user.click(screen.getByRole('button', { name: 'Report Thread' }))
  await screen.findByText('搜索功能已完成，已验证项目名称与描述筛选、空结果和权限交互。')
  await user.click(screen.getByRole('button', { name: '归档报告：搜索功能交付报告' }))
  expect(document.querySelector('[data-report-id]')).toHaveAttribute('data-report-archived', 'false')
  expect(document.querySelector('output')).toHaveTextContent('快照保持不变')
  await user.click(screen.getByRole('button', { name: '关联已删除' }))
  await waitFor(() => expect(document.querySelector('li.missing button')).toBeDisabled())
  expect(JSON.stringify(fakeSnapshots)).toBe(before)
})

it('rejects corrupt catalog selectors and duplicate scenes before fetching captures', async () => {
  const { parseScenarioCatalog } = await import('../playgrounds/single-thread/src/scenarios')
  const entry = { harness: 'claude', scenario: 'question', threadId: 'id', snapshot: 'a'.repeat(64) }
  expect(parseScenarioCatalog({ cases: [entry] }).cases).toHaveLength(1)
  expect(() => parseScenarioCatalog({ cases: [entry, entry] })).toThrow()
  expect(() => parseScenarioCatalog({ cases: [{ ...entry, snapshot: '../state' }] })).toThrow()
  expect(() => parseScenarioCatalog({ cases: [{ ...entry, scenario: 'invented' }] })).toThrow()
})

it('freezes nested snapshot records so preview code cannot alter their source', () => {
  const captured = parseSnapshot(structuredClone(state))
  expect(() => { Object.assign(captured.reports[0]!, { title: 'changed' }) }).toThrow()
  expect(() => { Array.prototype.push.call(captured.reports, captured.reports[0]!) }).toThrow()
})
