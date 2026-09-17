import fc from 'fast-check'
import { expect, it } from 'vitest'
import { threadDirectoryTag, threadTagKey, type ThreadPublicObservation } from '@openagent/contracts'
import type { RendererReport } from '../../src/shared/renderer-state-contracts'
import {
  selectOverviewItems,
  tagKey,
  type OverviewView
} from '../../src/renderer/src/conversation-overview-layout'
import { check } from './check'

const threadIds = ['t0', 't1', 't2', 't3'] as const
const executionIds = ['e0', 'e1'] as const
/** `'  '` and `''` normalize to the empty key, which can never be selected. */
const tagPool = ['alpha', 'Beta', '德', '  ', ''] as const
const cwdPool = [
  '/work/alpha',
  '/work/beta/',
  'beta',
  '/tmp/openagent-1/alpha',
  'C:\\work\\beta',
  ''
] as const

const observe = (executionId: string | null): ThreadPublicObservation => ({
  latestExecution: executionId === null
    ? null
    : { executionId, status: 'completed', startedAt: 1, finishedAt: 2 },
  backgroundWork: null
})

interface OverviewThread {
  readonly thread: {
    readonly id: string
    readonly createdAt: number
    readonly archived: boolean
    readonly observation: ThreadPublicObservation
    readonly tags: readonly string[]
    readonly cwd: string
  }
}

const threadSpec = fc.record({
  archived: fc.boolean(),
  cwd: fc.constantFrom(...cwdPool),
  tags: fc.uniqueArray(fc.constantFrom(...tagPool), { maxLength: 2 }),
  executionId: fc.option(fc.constantFrom(...executionIds), { nil: null }),
  createdAt: fc.integer({ min: 0, max: 3 })
})

const reportSpec = fc.record({
  archived: fc.boolean(),
  tags: fc.uniqueArray(fc.constantFrom(...tagPool), { maxLength: 2 }),
  refs: fc.array(fc.record({
    threadId: fc.constantFrom(...threadIds),
    executionId: fc.constantFrom(...executionIds)
  }), { maxLength: 3 }),
  createdAt: fc.integer({ min: 0, max: 3 })
})

/**
 * A committed world: ids are positional and unique, and a Report never carries
 * two different Executions for one Thread, as the reference parser guarantees.
 */
const world = fc.record({
  threads: fc.array(threadSpec, { maxLength: 4 }),
  reports: fc.array(reportSpec, { maxLength: 4 })
}).map(({ threads, reports }) => ({
  threads: threads.map((spec, index): OverviewThread => ({
    thread: {
      id: `t${index}`,
      createdAt: spec.createdAt,
      archived: spec.archived,
      observation: observe(spec.executionId),
      tags: spec.tags,
      cwd: spec.cwd
    }
  })),
  reports: reports.map((spec, index): RendererReport => ({
    id: `r${index}`,
    title: `报告 ${index}`,
    tags: spec.tags,
    relatedExecutions: spec.refs.filter((link, position) =>
      spec.refs.findIndex(candidate => candidate.threadId === link.threadId) === position),
    createdAt: spec.createdAt,
    updatedAt: spec.createdAt,
    archived: spec.archived,
    previewText: ''
  }))
}))

const view = fc.constantFrom<OverviewView>('default', 'archived')
const selectedTags = fc.uniqueArray(fc.constantFrom(...tagPool), { maxLength: 2 })

/** Independent statement of the documented tag filter, over the shared identity. */
function tagFilter(itemTags: readonly string[], selected: readonly string[]): boolean {
  const keys = new Set(selected.map(threadTagKey).filter(Boolean))
  return !keys.size || itemTags.some(tag => keys.has(threadTagKey(tag)))
}

const byCreatedAt = <T>(items: readonly T[], createdAt: (item: T) => number): T[] =>
  [...items].sort((left, right) => createdAt(left) - createdAt(right))

it('A Thread is hidden exactly when a visible Report covers its current Execution', () => {
  check('A Thread is hidden exactly when a visible Report covers its current Execution', fc.property(
    world, view, selectedTags, fc.boolean(),
    (state, current, selected, merge) => {
      const result = selectOverviewItems(state.threads, state.reports, current, selected, merge)
      const archived = current === 'archived'
      const visibleReports = byCreatedAt(state.reports.filter(report =>
        report.archived === archived && tagFilter(report.tags, selected)), report => report.createdAt)
      expect(result.reports.map(report => report.id)).toEqual(visibleReports.map(report => report.id))

      const covers = (entry: OverviewThread): boolean => visibleReports.some(report =>
        report.relatedExecutions.some(link => link.threadId === entry.thread.id &&
          link.executionId === entry.thread.observation.latestExecution?.executionId))
      const isCandidate = (entry: OverviewThread): boolean =>
        entry.thread.archived === archived &&
        tagFilter([threadDirectoryTag(entry.thread), ...entry.thread.tags], selected)
      const expected = byCreatedAt(state.threads.filter(entry =>
        isCandidate(entry) && !(merge && covers(entry))), entry => entry.thread.createdAt)

      expect(result.threads.map(entry => entry.thread.id)).toEqual(expected.map(entry => entry.thread.id))
      // Selection returns the caller's own records, never layout-local copies.
      for (const entry of result.threads) expect(state.threads).toContain(entry)
      // The biconditional is checked against every input, not only the candidates.
      const visible = new Set(result.threads.map(entry => entry.thread.id))
      for (const entry of state.threads) {
        expect(visible.has(entry.thread.id)).toBe(isCandidate(entry) && !(merge && covers(entry)))
      }
      expect(result.count).toBe(result.threads.length + result.reports.length)
    }
  ))
})

it('A Report that fails the view or tag filter never hides a Thread', () => {
  check('A Report that fails the view or tag filter never hides a Thread', fc.property(
    // The Report's own view is drawn independently of the Thread's, so the
    // view leg of this property is exercised rather than assumed away.
    fc.boolean(), fc.boolean(), fc.constantFrom(...tagPool), fc.uniqueArray(fc.constantFrom(...tagPool), { maxLength: 2 }),
    fc.option(fc.constantFrom(...executionIds), { nil: null }), fc.option(fc.constantFrom(...cwdPool), { nil: null }),
    view, fc.boolean(),
    (threadArchived, reportArchived, reportTag, selected, executionId, cwd, current, merge) => {
      const archived = current === 'archived'
      const entry: OverviewThread = {
        thread: {
          id: 't0',
          createdAt: 1,
          archived: threadArchived,
          observation: observe(executionId),
          tags: [],
          cwd: cwd ?? '',
        }
      }
      const covering: RendererReport = {
        id: 'r0',
        title: '报告',
        tags: [reportTag],
        relatedExecutions: executionId === null ? [] : [{ threadId: 't0', executionId }],
        createdAt: 1,
        updatedAt: 1,
        archived: reportArchived,
        previewText: ''
      }
      // A Report with no reference to this Execution cannot cover it, however visible it is.
      const covers = executionId !== null && covering.archived === archived && tagFilter(covering.tags, selected)
      const threadIsCandidate = entry.thread.archived === archived &&
        tagFilter([threadDirectoryTag(entry.thread), ...entry.thread.tags], selected)
      const result = selectOverviewItems([entry], [covering], current, selected, merge)
      // Coverage requires a Report that survived the same filters as the Thread.
      expect(result.threads.map(item => item.thread.id)).toEqual(
        threadIsCandidate && !(merge && covers) ? ['t0'] : [])
      expect(result.count).toBe(result.threads.length + result.reports.length)
    }
  ))
})

it('Disabling merge restores every filtered candidate', () => {
  check('Disabling merge restores every filtered candidate', fc.property(
    world, view, selectedTags,
    (state, current, selected) => {
      const merged = selectOverviewItems(state.threads, state.reports, current, selected, true)
      const whole = selectOverviewItems(state.threads, state.reports, current, selected, false)
      const candidates = state.threads.filter(entry =>
        entry.thread.archived === (current === 'archived') &&
        tagFilter([threadDirectoryTag(entry.thread), ...entry.thread.tags], selected))
      expect(whole.threads.map(entry => entry.thread.id))
        .toEqual(byCreatedAt(candidates, entry => entry.thread.createdAt).map(entry => entry.thread.id))
      // Merging only removes covered candidates: the result is the same list,
      // in the same relative order, with the caller's own records.
      const kept = new Set(merged.threads.map(entry => entry.thread.id))
      expect(merged.threads).toEqual(whole.threads.filter(entry => kept.has(entry.thread.id)))
      for (const entry of merged.threads) expect(whole.threads).toContain(entry)
      expect(merged.reports.map(report => report.id)).toEqual(whole.reports.map(report => report.id))
      expect(whole.count).toBe(whole.threads.length + whole.reports.length)
      expect(merged.count).toBe(merged.threads.length + merged.reports.length)
    }
  ))
})

it('The two archive views partition Threads and Reports', () => {
  check('The two archive views partition Threads and Reports', fc.property(
    world, fc.array(fc.constantFrom(...tagPool), { maxLength: 2 }),
    (state, selected) => {
            const visible = (current: OverviewView) =>
        selectOverviewItems(state.threads, state.reports, current, selected, false)
      const active = visible('default')
      const archived = visible('archived')
      const ids = (entries: readonly OverviewThread[]) => entries.map(entry => entry.thread.id)
      // A Thread or Report appears in exactly one bucket, under either tag selection.
      expect([...ids(active.threads), ...ids(archived.threads)].sort()).toEqual(
        state.threads.filter(entry => !selected.length ||
          tagFilter([threadDirectoryTag(entry.thread), ...entry.thread.tags], selected))
          .map(entry => entry.thread.id).sort())
      expect(new Set([...ids(active.threads), ...ids(archived.threads)]).size)
        .toBe(active.threads.length + archived.threads.length)
      expect([...active.reports, ...archived.reports].map(report => report.id).sort()).toEqual(
        state.reports.filter(report => !selected.length || tagFilter(report.tags, selected))
          .map(report => report.id).sort())
      for (const entry of active.threads) expect(entry.thread.archived).toBe(false)
      for (const entry of archived.threads) expect(entry.thread.archived).toBe(true)
      for (const report of active.reports) expect(report.archived).toBe(false)
      for (const report of archived.reports) expect(report.archived).toBe(true)
      expect(active.count).toBe(active.threads.length + active.reports.length)
      expect(archived.count).toBe(archived.threads.length + archived.reports.length)
    }
  ))
})

it('Overview selection preserves input order among equal timestamps', () => {
  check('Overview selection preserves input order among equal timestamps', fc.property(
    fc.array(threadSpec, { maxLength: 6 }), fc.array(reportSpec, { maxLength: 6 }),
    fc.constantFrom(...executionIds), view,
    (threadSpecs, reportSpecs, executionId, current) => {
      const threads = threadSpecs.map((spec, index): OverviewThread => ({
        thread: {
          id: `t${index}`,
          createdAt: spec.createdAt,
          archived: current === 'archived',
          observation: observe(executionId),
          tags: spec.tags,
          cwd: spec.cwd
        }
      }))
      const reports = reportSpecs.map((spec, index): RendererReport => ({
        id: `r${index}`,
        title: '报告',
        tags: [],
        // No reference at all: ordering must not depend on coverage.
        relatedExecutions: [],
        createdAt: spec.createdAt,
        updatedAt: spec.createdAt,
        archived: current === 'archived',
        previewText: ''
      }))
      const result = selectOverviewItems(threads, reports, current, [], true)
      // Documented stable order: timestamp first, input position for ties.
      const ordered = <T>(items: readonly T[], createdAt: (item: T) => number): number[] =>
        items.map((item, index) => ({ createdAt: createdAt(item), index }))
          .sort((left, right) => left.createdAt - right.createdAt || left.index - right.index)
          .map(({ index }) => index)
      expect(result.threads.map(entry => threads.indexOf(entry)))
        .toEqual(ordered(threads, entry => entry.thread.createdAt))
      expect(result.reports.map(report => reports.indexOf(report)))
        .toEqual(ordered(reports, report => report.createdAt))
    }
  ))
})

it('Thread workspace directories act as tags under the shared identity rule', () => {
  check('Thread workspace directories act as tags under the shared identity rule', fc.property(
    fc.constantFrom(...cwdPool), fc.constantFrom(...tagPool), fc.array(fc.constantFrom(...tagPool), { maxLength: 2 }),
    fc.boolean(),
    (cwd, ownTag, selected, archived) => {
      const entry: OverviewThread = {
        thread: {
          id: 't0',
          createdAt: 1,
          archived,
          observation: observe(null),
          tags: [ownTag],
          cwd
        }
      }
      const directory = threadDirectoryTag(entry.thread)
      const keys = new Set(selected.map(threadTagKey).filter(Boolean))
      const matches = !keys.size || [directory, ownTag].some(tag => tag && keys.has(threadTagKey(tag)))
      const result = selectOverviewItems([entry], [], archived ? 'archived' : 'default', selected, true)
      expect(result.threads.length).toBe(matches ? 1 : 0)
      // The renderer-local identity copy must not drift from the shared contract.
      for (const tag of [directory, ownTag, ...selected]) expect(tagKey(tag)).toBe(threadTagKey(tag))
      // A temporary workspace contributes no directory tag of its own.
      if (cwd.startsWith('/tmp/openagent-1/')) expect(directory).toBe('')
    }
  ))
})
