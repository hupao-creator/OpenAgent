// Shared case DATA for pure PBT and the development playground. Production
// layout never imports fast-check, this generator, or a browser replay driver.
import fc from 'fast-check'
import type { LayoutGeometry, LayoutMember, LayoutPlacement } from '../../src/renderer/src/overview-layout'

export interface OverviewLayoutCase {
  readonly version: 1
  readonly name: string
  readonly geometry: LayoutGeometry
  readonly previous: readonly LayoutPlacement[]
  readonly steps: readonly { readonly label: string; readonly members: readonly LayoutMember[] }[]
}

const change = fc.record({ kind: fc.constantFrom('add', 'remove', 'resize', 'noop'), target: fc.nat(20), cols: fc.integer({ min: 1, max: 2 }), rows: fc.integer({ min: 1, max: 2 }) })

export function overviewLayoutCaseArbitrary(maxCommands = 15): fc.Arbitrary<OverviewLayoutCase> {
  return fc.array(change, { minLength: 1, maxLength: maxCommands }).map(operations => {
    let members: LayoutMember[] = []
    return { version: 1, name: '生成的变更序列', geometry: { columnWidth: 360, rowHeight: 200, gap: 16 }, previous: [],
      steps: operations.map((op, index) => {
        const id = members[op.target % members.length]?.id
        let label = '保持布局'
        if (op.kind === 'add' && members.length < 6) {
          const id = `card-${index}`
          members = [...members, { id, cols: op.cols, rows: op.rows }]
          label = `新增 ${id} · ${op.cols}×${op.rows}`
        }
        if (op.kind === 'remove' && id) { members = members.filter(p => p.id !== id); label = `移除 ${id}` }
        if (op.kind === 'resize' && id) {
          members = members.map(p => p.id === id ? { ...p, cols: op.cols, rows: op.rows } : p)
          label = `${id} → ${op.cols}×${op.rows}`
        }
        return { label, members }
      }) }
  })
}
