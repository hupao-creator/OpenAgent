import { z } from 'zod'
import type { OverviewLayoutCase } from '../../../tests/property/overview-layout-cases'

const unit = (id: string) => ({ id, cols: 1, rows: 1 })
const cards = Array.from({ length: 24 }, (_, i) => unit(String(i + 1).padStart(2, '0')))
const geometry = { columnWidth: 360, rowHeight: 200, gap: 16 }
const trio = ['A', 'B', 'C'].map((id, col) => ({ ...unit(id), col, row: 0 }))

export const layoutCases: readonly OverviewLayoutCase[] = [
  { version: 1, name: '24 张卡片 · 横向自由扩展', geometry, previous: [], steps: [
    { label: '首次排布 24 张普通卡片', members: cards },
    { label: '新增 25，保留旧成员位置', members: [...cards, unit('25')] },
    { label: '移除 01，优先恢复紧凑比例', members: [...cards.slice(1), unit('25')] },
    { label: '02 展开为 2×2', members: [...cards.slice(1).map(p => p.id === '02' ? { ...p, cols: 2, rows: 2 } : p), unit('25')] }
  ] },
  { version: 1, name: '一次 shift · 给扩大的 A 让位', geometry, previous: trio, steps: [
    { label: '横排的 A 展开为 3×1：移动 A，保留 B、C', members: trio.map(p => p.id === 'A' ? { ...p, cols: 3 } : p) },
    { label: 'A 收起，重新选择紧凑比例', members: trio }
  ] },
  { version: 1, name: '相同比例 · 保留历史位置', geometry,
    previous: Array.from({ length: 6 }, (_, i) => ({ ...unit(String(i + 1)), col: i % 2 + 1, row: Math.floor(i / 2) + 1 })), steps: [
      { label: '成员位于原点右下方', members: Array.from({ length: 6 }, (_, i) => unit(String(i + 1))) },
      { label: '移除第一列，旧位置仍有最优比例', members: ['2', '4', '6'].map(unit) },
      { label: '新增 7，重新比较比例和总位移', members: ['2', '4', '6', '7'].map(unit) }
  ] },
  { version: 1, name: '比例优先 · 三列变四列', geometry,
    previous: cards.map((p, i) => ({ ...p, col: i % 3, row: Math.floor(i / 3) })),
    steps: [{ label: '3×8 → 4×6：比例优先，再缩短总位移', members: cards }]
  },
  { version: 1, name: '总距离优先 · 四张一起短移', geometry,
    previous: [[4, 0], [5, 1], [2, 2], [3, 3]].map(([col, row], i) => ({ ...unit(String(i + 1)), col: col!, row: row! })),
    steps: [{ label: '四张均沿安全直线移动，比最好的三张移动方案更短', members: ['1', '2', '3', '4'].map(unit) }]
  },
  { version: 1, name: '删除 10 · 不留内部空洞', geometry,
    previous: cards.map((p, i) => ({ ...p, col: i % 4, row: Math.floor(i / 4) })),
    steps: [{ label: '删除 10 后，09 直线补位，将空缺移到边缘', members: cards.filter(p => p.id !== '10') }]
  },
  { version: 1, name: '直线受阻 · 先腾空再落位', geometry,
    previous: ['A', 'B'].map((id, col) => ({ ...unit(id), col, row: 0 })),
    steps: [{ label: 'A 先向下移动，B 再向左移动；禁止斜穿 A', members: ['A', 'B'].map(unit) }]
  }
]

// Replay input has resource bounds for an interactive browser. These are not
// bounds on production layout width; the solver itself has a work budget.
const span = z.number().int().min(1).max(16)
const member = z.object({ id: z.string().min(1).max(100), cols: span, rows: span })
const schema = z.object({
  version: z.literal(1), name: z.string().max(200),
  geometry: z.object({ columnWidth: z.number().min(1).max(2000), rowHeight: z.number().min(1).max(2000), gap: z.number().min(0).max(100) }),
  previous: z.array(member.extend({ col: z.number().int().min(0).max(1000), row: z.number().int().min(0).max(1000) })).max(100),
  steps: z.array(z.object({ label: z.string().max(200), members: z.array(member).max(100) })).min(1).max(200)
})

export function parseLayoutCase(text: string): OverviewLayoutCase {
  const value: unknown = JSON.parse(text)
  // fc.check emits a full counterexample object. The sequence family stores a
  // complete case as its first argument, so it is replayable without a seed.
  const candidate = typeof value === 'object' && value !== null && 'counterexample' in value && Array.isArray(value.counterexample)
    ? value.counterexample[0] : value
  return schema.parse(candidate)
}
