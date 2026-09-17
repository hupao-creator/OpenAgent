import { describe, expect, it } from 'vitest'
import type { AgentThreadRecord } from '@openagent/contracts'
import type { RendererReport } from '../src/shared/renderer-state-contracts'
import { selectOverviewItems } from '../src/renderer/src/conversation-overview-layout'

const thread = (executionId = 'e1', status: 'running' | 'completed' | 'failed' | 'interrupted' = 'completed', archived = false) => ({
  thread: {
    id: 't', archived, harnessId: 'codex', revision: 1, sessionState: null,
    observation: { latestExecution: { executionId, status, startedAt: 1, finishedAt: 2 }, backgroundWork: null },
    title: 'T', tags: ['thread-tag', 'shared'], cwd: '/work/project', settings: {}, createdAt: 1, updatedAt: 2
  } as AgentThreadRecord
})
const report = (executionId = 'e1', archived = false, id = 'r'): RendererReport => ({
  id, archived, title: id, tags: ['report-tag', 'shared'], createdAt: 2, updatedAt: 3, previewText: '',
  relatedExecutions: [{ threadId: 't', executionId }]
})
const ids = (result: ReturnType<typeof selectOverviewItems>) => [
  ...result.threads.map(input => input.thread.id), ...result.reports.map(value => value.id)
]

describe('Issue #83 candidate-first execution coverage', () => {
  it('keeps completed work by default, and merges only a visible report covering latest', () => {
    expect(ids(selectOverviewItems([thread()], [], 'default'))).toEqual(['t'])
    expect(ids(selectOverviewItems([thread()], [report()], 'default'))).toEqual(['r'])
    expect(ids(selectOverviewItems([thread('e2')], [report()], 'default'))).toEqual(['t', 'r'])
    expect(ids(selectOverviewItems([thread('e2', 'running')], [report()], 'default'))).toEqual(['t', 'r'])
    expect(ids(selectOverviewItems([thread('e2')], [report(), report('e2', false, 'r2')], 'default'))).toEqual(['r', 'r2'])
  })
  it('recomputes on successful relation replacement, removal and report deletion', () => {
    expect(ids(selectOverviewItems([thread()], [report('e1')], 'default'))).toEqual(['r'])
    expect(ids(selectOverviewItems([thread()], [report('older')], 'default'))).toEqual(['t', 'r'])
    expect(ids(selectOverviewItems([thread()], [{ ...report(), relatedExecutions: [] }], 'default'))).toEqual(['t', 'r'])
    expect(ids(selectOverviewItems([thread()], [], 'default'))).toEqual(['t'])
  })
  it('filters tags before merging and counts only remaining independent cards', () => {
    expect(ids(selectOverviewItems([thread()], [report()], 'default', ['thread-tag']))).toEqual(['t'])
    expect(ids(selectOverviewItems([thread()], [report()], 'default', ['report-tag']))).toEqual(['r'])
    expect(selectOverviewItems([thread()], [report()], 'default', ['shared']).count).toBe(1)
    expect(selectOverviewItems([thread()], [report()], 'default', ['missing']).count).toBe(0)
  })
  it('filters committed per-object flags, including independently restored Agents', () => {
    expect(ids(selectOverviewItems([thread()], [report('e1', true)], 'default'))).toEqual(['t'])
    expect(ids(selectOverviewItems([thread()], [report('e1', true)], 'archived'))).toEqual(['r'])
    expect(ids(selectOverviewItems([thread('e1', 'completed', true)], [report('e1', true)], 'archived'))).toEqual(['r'])
    expect(ids(selectOverviewItems([thread('e1', 'failed', true)], [], 'default'))).toEqual([])
    expect(ids(selectOverviewItems([thread('e1', 'failed', true)], [], 'archived'))).toEqual(['t'])
    expect(ids(selectOverviewItems([thread('e1', 'completed', true)], [report()], 'default'))).toEqual(['r'])
  })
  it('keeps an unarchived interrupted Agent in Default and only archives what Core archived', () => {
    expect(ids(selectOverviewItems([thread('e2', 'interrupted')], [report()], 'default'))).toEqual(['t', 'r'])
    expect(ids(selectOverviewItems([thread('e2', 'interrupted')], [report()], 'archived'))).toEqual([])
    expect(ids(selectOverviewItems([thread('e2', 'interrupted', true)], [], 'default'))).toEqual([])
    expect(ids(selectOverviewItems([thread('e2', 'interrupted', true)], [], 'archived'))).toEqual(['t'])
    // Archive membership is the committed flag alone: a failure archives in Core
    // before any view reads it, so an unarchived failure stays visible until then.
    expect(ids(selectOverviewItems([thread('e2', 'failed')], [], 'default'))).toEqual(['t'])
    expect(ids(selectOverviewItems([thread('e2', 'failed', true)], [], 'archived'))).toEqual(['t'])
  })
  it('background work neither prevents completed coverage nor changes archive membership', () => {
    const completed = thread()
    completed.thread = { ...completed.thread, observation: { ...completed.thread.observation, backgroundWork: { status: 'running' } } }
    expect(ids(selectOverviewItems([completed], [report()], 'default'))).toEqual(['r'])
    const failed = thread('e2', 'failed', true)
    failed.thread = { ...failed.thread, observation: { ...failed.thread.observation, backgroundWork: { status: 'running' } } }
    expect(ids(selectOverviewItems([failed], [report()], 'archived'))).toEqual(['t'])
  })
})
