import type { HarnessOverviewThreadInput, OverviewLayoutContext } from '@openagent/contracts/renderer'
import type { RendererReport } from '../../../src/shared/renderer-state-contracts'
import { deriveOverviewItems, overviewLayoutSnapshot, selectOverviewItems } from '../../../src/renderer/src/conversation-overview-layout'
import { projectHarnessOverviewThread } from '../../../src/renderer/src/harness-composition'
import { fakeSnapshots } from '../../single-thread/src/fake-snapshots'

export interface MotionFrame {
  readonly threads: readonly HarnessOverviewThreadInput[]
  readonly reports: readonly RendererReport[]
  readonly nextId: number
  readonly selectedTag: string
}

export const motionTagSelections = {
  'filter-all': '',
  'filter-frontend': '前端',
  'filter-backend': '后端',
  'filter-testing': '测试',
  'filter-empty': '空结果'
} as const

export const motionActions = {
  add: '新增卡片',
  remove: '移除首张',
  question: '展开提问',
  complete: '完成并收起',
  reorder: '反转顺序',
  burst: '连续变化 ×4',
  fill: '扩展至 18 张',
  compact: '保留一张',
  report: '生成收纳报告',
  'remove-report': '移除报告',
  cut: '立即切幕',
  'filter-all': '筛选：全部',
  'filter-frontend': '筛选：前端',
  'filter-backend': '筛选：后端',
  'filter-testing': '筛选：测试',
  'filter-empty': '筛选：空结果'
} as const
export type MotionAction = keyof typeof motionActions

export const motionScenarios: readonly {
  id: string; title: string; description: string; count: number; steps: readonly MotionAction[]
}[] = [
  { id: 'filters', title: '标签切换', description: '在画布上方选择动效候选，再点击标签或自动播放。覆盖不同集合、交叉标签、空结果与返回全部；可慢放和连续切换。', count: 8, steps: ['filter-frontend', 'filter-testing', 'filter-backend', 'filter-empty', 'filter-backend', 'filter-frontend', 'filter-all'] },
  { id: 'packing', title: '紧凑布局', description: '24 张真实卡片按各自占地紧凑排布。反转数据顺序保留格位，展开、收起和增删按直线依次移动。', count: 24, steps: ['reorder', 'question', 'complete', 'remove', 'add'] },
  { id: 'lifecycle', title: '入场与退场', description: '新卡入场、旧卡退场，观察邻居如何依次让位。', count: 3, steps: ['add', 'add', 'remove', 'reorder'] },
  { id: 'resize', title: '展开与收起', description: '提问展开为组合卡片，完成后收起，观察换形与重排。', count: 4, steps: ['question', 'complete', 'question', 'complete'] },
  { id: 'queue', title: '连续变化', description: '同一批次提交四次尺寸变化，检查中间节拍是否完整播放。', count: 4, steps: ['burst', 'add', 'burst', 'remove'] },
  { id: 'camera', title: '自动取景', description: '所有卡片使用同一 Canvas。滚轮缩放、自由拖动，离开后返回观察视角恢复与延迟取景。', count: 1, steps: ['fill', 'question', 'compact', 'fill'] },
  { id: 'report', title: '报告收纳', description: '报告接替关联任务，移除报告后任务重新入场。', count: 4, steps: ['report', 'remove-report', 'report', 'remove-report'] },
  { id: 'cut', title: '切幕中断', description: '连续变化后立即切幕，检查旧场景动画是否清理。', count: 4, steps: ['burst', 'cut', 'add', 'question'] }
]

const titles = ['梳理搜索交互', '实现项目筛选', '验证键盘导航', '检查空结果提示', '补齐筛选测试', '整理交付说明']
const harnesses = ['claude', 'codex']
type Phase = 'running' | 'question' | 'completed'

function sampleThread(index: number, phase: Phase = 'running'): HarnessOverviewThreadInput {
  const harness = harnesses[(index - 1) % harnesses.length]!
  const fixture = fakeSnapshots.find(scene => scene.harness === harness && scene.scenario === phase)!
  const thread = fixture.state.threads[0]!
  if (thread.bart) throw new Error('Motion fixtures must contain an Agent Thread')
  // Only public identity and tag metadata change. Frozen Harness-owned payloads are reused as authored.
  return { thread: { ...thread, id: `motion-thread-${index}`, title: `${String(index).padStart(2, '0')} · ${titles[(index - 1) % titles.length]}`,
    createdAt: 1_789_000_000_000 + index, archived: false,
    tags: ['模拟', index % 2 ? '前端' : '后端', ...(index % 3 === 0 ? ['测试'] : [])], cwd: '/demo/overview-motion' } }
}

export function createMotionFrame(count: number): MotionFrame {
  return { threads: Array.from({ length: count }, (_, index) => sampleThread(index + 1)), reports: [], nextId: count + 1, selectedTag: '' }
}

function changeFirst(frame: MotionFrame, phase: Phase): MotionFrame {
  const first = frame.threads[0]
  if (!first) return frame
  const index = Number(first.thread.id.replace('motion-thread-', ''))
  const replacement = sampleThread(index, phase)
  return { ...frame, reports: [], threads: [{ ...replacement, thread: { ...replacement.thread,
    createdAt: first.thread.createdAt, revision: first.thread.revision + 1 } }, ...frame.threads.slice(1)] }
}

/** Scenario inputs only; production Overview owns every animation, lease and camera frame. */
export function applyMotionAction(frame: MotionFrame, action: MotionAction): readonly MotionFrame[] {
  switch (action) {
    case 'add': return [{ ...frame, threads: [...frame.threads, sampleThread(frame.nextId)], nextId: frame.nextId + 1 }]
    case 'remove': return [{ ...frame, threads: frame.threads.slice(1), reports: [] }]
    case 'question': return [changeFirst(frame, 'question')]
    case 'complete': return [changeFirst(frame, 'completed')]
    case 'reorder': return [{ ...frame, threads: [...frame.threads].reverse().map((source, index) => ({ thread: {
      ...source.thread, createdAt: 1_789_000_000_000 + index
    } })) }]
    case 'burst': {
      const frames: MotionFrame[] = []
      for (const phase of ['question', 'completed', 'question', 'completed'] as const) {
        frame = changeFirst(frame, phase)
        frames.push(frame)
      }
      return frames
    }
    case 'fill': {
      const count = Math.max(0, 18 - frame.threads.length)
      return [{ ...frame, reports: [], threads: [...frame.threads,
        ...Array.from({ length: count }, (_, index) => sampleThread(frame.nextId + index))], nextId: frame.nextId + count }]
    }
    case 'compact': return [{ ...frame, reports: [], threads: frame.threads.slice(0, 1) }]
    case 'report': {
      const completed = { ...frame, threads: frame.threads.map(source => {
        const index = Number(source.thread.id.replace('motion-thread-', ''))
        const replacement = sampleThread(index, 'completed')
        return { thread: { ...replacement.thread, createdAt: source.thread.createdAt, revision: source.thread.revision + 1 } }
      }) }
      return [{ ...completed, reports: [{ id: 'motion-report', title: '搜索功能交付报告', tags: ['模拟'], archived: false,
        createdAt: 1_789_000_100_000, updatedAt: 1_789_000_100_000,
        previewText: '项目筛选、键盘导航和空结果提示已完成。关联任务由报告统一收纳。',
        relatedExecutions: completed.threads.map(({ thread }) => ({ threadId: thread.id, executionId: thread.observation.latestExecution!.executionId })) }] }]
    }
    case 'remove-report': return [{ ...frame, reports: [] }]
    case 'cut': return [createMotionFrame(2)]
    case 'filter-all':
    case 'filter-frontend':
    case 'filter-backend':
    case 'filter-testing':
    case 'filter-empty': return [{ ...frame, selectedTag: motionTagSelections[action] }]
  }
}

export function motionSceneKey(frame: MotionFrame, epoch: number): string {
  return `playground:${epoch}\u0000${frame.selectedTag}`
}

export function motionTagFilters(frame: MotionFrame) {
  return Object.values(motionTagSelections).filter(Boolean).map(tag => ({
    tag, isCwdTag: false,
    count: selectOverviewItems(frame.threads, frame.reports, 'default', [tag]).count
  }))
}

export function captureMotionLayout(frame: MotionFrame, context: OverviewLayoutContext) {
  const selected = selectOverviewItems(frame.threads.map(source => projectHarnessOverviewThread(source, context.availableCols)), frame.reports, 'default', frame.selectedTag ? [frame.selectedTag] : [])
  return overviewLayoutSnapshot(deriveOverviewItems({ threads: selected.threads, reports: selected.reports, transitionId: null, layoutContext: context }))
}
