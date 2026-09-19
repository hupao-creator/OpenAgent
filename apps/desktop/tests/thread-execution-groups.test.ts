import { describe, expect, it } from 'vitest'
import { partitionExecutionRows, threadExecutionRunIds } from '@openagent/plugin-kit/renderer'

type Item = { readonly id: string; readonly kind: string }
const execution = (item: Item): boolean => item.kind === 'reasoning' || item.kind === 'activity'
const project = (items: readonly Item[]) => items.map(item => ({
  ...item, kind: execution(item) ? 'work' : item.kind
}))
const groupedIds = (items: readonly Item[]) => partitionExecutionRows(project(items), threadExecutionRunIds(items, execution))
  .map(run => run.kind === 'row' ? [run.row.id] : run.rows.map(row => row.id))

describe('adjacent execution runs', () => {
  it.each([
    ['reasoning', 'activity', 'reasoning', 'activity'],
    ['reasoning', 'reasoning'],
    ['activity', 'activity'],
    ['reasoning'],
    ['activity']
  ])('groups %j without reordering or mutation', (...kinds) => {
    const items = kinds.map((kind, index) => Object.freeze({ id: String(index), kind }))
    Object.freeze(items)
    expect(groupedIds(items)).toEqual([items.map(item => item.id)])
    expect(items.map(item => item.kind)).toEqual(kinds)
  })

  it.each(['assistant', 'user-message', 'interaction', 'error', 'notice', 'plan', 'usage', 'context-compaction'])
    ('only preserves the %s boundary while it is rendered', (kind) => {
      const items = [{ id: 'r', kind: 'reasoning' }, { id: 'boundary', kind }, { id: 'a', kind: 'activity' }]
      const runIds = threadExecutionRunIds(items, execution)
      expect(groupedIds(items)).toEqual([['r'], ['boundary'], ['a']])
      const runs = partitionExecutionRows(project(items).filter(item => item.id !== 'boundary'), runIds)
      expect(runs.map(run => run.kind === 'execution' ? run.rows.map(row => row.id) : [])).toEqual([['r', 'a']])
    })

  it('does not swallow attention rows even when the native run includes them', () => {
    const items = ['reasoning', 'activity', 'reasoning'].map((kind, i) => ({ id: String(i), kind }))
    const rows = project(items).map(row => row.id === '1' ? { ...row, kind: 'attention' } : row)
    const runs = partitionExecutionRows(rows, threadExecutionRunIds(items, execution))
    expect(runs.map(run => run.kind)).toEqual(['execution', 'row', 'execution'])
    expect(runs[1]).toEqual({ kind: 'row', row: rows[1] })
  })

  it('keeps the first rendered row identity while appending and updating work', () => {
    const first = [{ id: 'r1', kind: 'reasoning' }]
    const next = [...first, { id: 'a1', kind: 'activity' }, { id: 'r2', kind: 'reasoning' }]
    const before = partitionExecutionRows(project(first), threadExecutionRunIds(first, execution))
    const after = partitionExecutionRows(project(next), threadExecutionRunIds(next, execution))
    expect(before[0]).toMatchObject({ kind: 'execution', id: 'r1' })
    expect(after[0]).toMatchObject({ kind: 'execution', id: 'r1' })
  })

  it('does not merge arbitrary work or mutate caller-owned nodes', () => {
    const rows = Object.freeze([
      Object.freeze({ id: 'a', kind: 'work', node: {} }),
      Object.freeze({ id: 'commentary', kind: 'work', node: {} }),
      Object.freeze({ id: 'b', kind: 'work', node: {} })
    ])
    const runs = partitionExecutionRows(rows, new Map([['a', 'a'], ['b', 'b']]))
    expect(runs.map(run => run.kind)).toEqual(['execution', 'row', 'execution'])
    expect(runs[1]).toEqual({ kind: 'row', row: rows[1] })
  })
})
