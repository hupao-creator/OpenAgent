// @vitest-environment jsdom
import { useStore } from 'zustand'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartThreadGenerations, type BartGenerationWork } from '../src/renderer/src/components/BartThreadGeneration'
import { createOverviewOrchestrationStore } from '../src/renderer/src/overview-orchestration-store'
import { getBartSpatialRegistry } from '../src/renderer/src/bart-motion/registry'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'
import type { PreparedMotionCard } from '../src/renderer/src/bart-motion/card-assets'
import type { MotionProgram } from '../src/renderer/src/bart-motion/worker-types'

const mocks = vi.hoisted(() => ({ capture: vi.fn(), surface: vi.fn() }))
vi.mock('../src/renderer/src/bart-motion/card-assets', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/bart-motion/card-assets')>(),
  prewarmMotionCards: async () => '', prepareMotionCard: mocks.capture
}))
vi.mock('../src/renderer/src/bart-motion/worker-client', () => ({ createMotionSurface: mocks.surface }))
vi.mock('../src/renderer/src/bart-motion/CharacterCanvas', () => {
  const actor = { id: 'generation-resident', ready: async () => {}, description: () => ({ layout: 'mark' }) }
  return { residentCharacter: () => actor }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}

const id = 'preparation-target'
const offscreenDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'transferControlToOffscreen')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const startedAt = Date.now()
  vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - startedAt)
  vi.stubGlobal('Worker', class {})
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', { configurable: true, value: vi.fn() })
  performance.clearMarks()
})
afterEach(async () => {
  cleanup()
  await act(async () => {})
  const registry = getBartSpatialRegistry()
  registry.registerThreadCard(id, null)
  registry.registerDock(null)
  registry.registerScrollContainer(null)
  registry.setRoot(null)
  document.body.replaceChildren()
  if (offscreenDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen', offscreenDescriptor)
  else Reflect.deleteProperty(HTMLCanvasElement.prototype, 'transferControlToOffscreen')
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers()
})

async function advance(milliseconds = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds) })
}

function fixture() {
  const root = document.createElement('main')
  root.className = 'app-shell'
  root.innerHTML = '<section><header class="thread-overview-header"></header><div class="thread-overview-scroll">' +
    '<article><strong>Initial title</strong><span class="thread-state idle">Idle</span></article></div></section>' +
    '<div class="bart-dock"><svg class="bart-logo"></svg></div><div class="generation-host"></div>'
  document.body.append(root)
  const card = root.querySelector('article')!, dock = root.querySelector<HTMLElement>('.bart-dock')!
  const scroll = root.querySelector<HTMLElement>('.thread-overview-scroll')!, toolbar = root.querySelector('header')!
  Object.assign(dock.firstChild!, { getScreenCTM: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) })
  const rootRect = vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 800))
  vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(new DOMRect(600, 600, 128, 128))
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 700))
  const cardRect = vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 80, 360, 200))
  const toolbarRect = vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 900, 42))
  const registry = getBartSpatialRegistry()
  registry.setRoot(root); registry.registerDock(dock); registry.registerScrollContainer(scroll); registry.registerThreadCard(id, card)
  const work: BartGenerationWork = { key: 1, controller: new AbortController(), targets: [{ id, kind: 'report',
    createdAt: 1, title: 'Initial title', metaText: '', cwdText: '', bodyText: '' }] }
  const store = createOverviewOrchestrationStore()
  const captures: { text: string | null; bitmap: ImageBitmap }[] = []
  const runs: { program: MotionProgram; finish: () => void; release: ReturnType<typeof vi.fn>; landCharacter: ReturnType<typeof vi.fn> }[] = []
  const hooks: { capture?: () => Promise<void> | void; load?: () => Promise<void> | void;
    borrow?: () => Promise<void> | void; start?: () => Promise<void> | void } = {}
  mocks.capture.mockImplementation(async (element: HTMLElement, origin: { x: number; y: number }): Promise<PreparedMotionCard> => {
    const bounds = element.getBoundingClientRect()
    const rect = { x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height }
    const bitmap = { width: 360, height: 200, close: vi.fn() } as unknown as ImageBitmap
    captures.push({ text: element.textContent, bitmap })
    const assetId = `snapshot-${captures.length}`
    await hooks.capture?.()
    return { rect, duration: 200, assets: [{ id: assetId, bitmap }], textures: [{ id: assetId, rect, from: 0 }], caret: [] }
  })
  const surface = {
    ready: Promise.resolve(), resize: vi.fn(), dispose: vi.fn(), resetPreparation: vi.fn(),
    load: vi.fn(async () => { await hooks.load?.() }),
    borrowCharacter: vi.fn(async () => { await hooks.borrow?.() }),
    play: vi.fn((program: MotionProgram) => {
      const done = deferred<void>()
      const release = vi.fn(), landCharacter = vi.fn(async () => {})
      runs.push({ program, finish: () => done.resolve(), release, landCharacter })
      return { started: Promise.resolve(hooks.start?.()).then(() => performance.timeOrigin + performance.now()),
        performed: done.promise, release, landCharacter }
    })
  }
  mocks.surface.mockReturnValue(surface)
  function Generations() {
    const works = useStore(store, state => state.works)
    return <BartThreadGenerations overviewOpen threads={[]} works={works} orchestration={store} onWorkConsumed={store.consumeWork} />
  }
  return { root, rootRect, card, toolbar, cardRect, toolbarRect, work, store, captures, runs, hooks, surface,
    start() { store.enqueue(work); return render(<Generations />, { container: root.querySelector('.generation-host')! }) },
    canvas: () => root.querySelector<HTMLCanvasElement>('canvas')!,
    ready: () => (performance.getEntriesByName('bart-generation-ready').at(-1) as PerformanceMark | undefined)?.detail,
    async finish() { await act(async () => { runs.at(-1)!.finish() }); await advance() }
  }
}

describe('generation preparation follows live cards before takeoff', () => {
  it.each(['capture', 'load', 'borrow', 'start'] as const)('retains pending work when metadata changes during %s', async boundary => {
    const f = fixture()
    f.hooks[boundary] = () => {
      delete f.hooks[boundary]
      f.card.querySelector('strong')!.textContent = 'Generated title'
      f.toolbar.textContent = 'All · New tag'
    }
    f.start()
    await advance()
    expect(f.ready()).toBeUndefined()
    expect(f.canvas().hidden).toBe(true)
    expect(f.store.getState()).toMatchObject({ works: [f.work], hiddenIds: [id] })
    expect(f.work.controller.signal.aborted).toBe(false)
    expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
    await advance(41)
    expect(f.ready()).toBeDefined()
    expect(f.canvas().hidden).toBe(false)
    expect(f.captures.map(capture => capture.text)).toEqual(['Initial titleIdle', 'Generated titleIdle'])
    expect(f.runs.at(-1)!.program.textures[0].id).toBe('snapshot-2')
    expect(performance.getEntriesByName('bart-generation-ready')).toHaveLength(1)
    expect(performance.getEntriesByName('bart-generation-skipped')).toHaveLength(0)
    if (boundary === 'start') expect(f.runs[0].release).toHaveBeenCalledTimes(1)
    await f.finish()
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.canvas().hidden).toBe(true)
    expect(f.card.style.visibility).toBe('')
    expect(f.surface.resetPreparation).toHaveBeenCalled()
    f.captures.forEach(capture => expect(capture.bitmap.close).toHaveBeenCalledTimes(1))
    f.runs.forEach(run => expect(run.release).toHaveBeenCalledTimes(1))
  })

  it.each(['status', 'position', 'toolbar'] as const)('remeasures a changed %s before the single visible flight', async change => {
    const f = fixture()
    f.hooks.capture = () => {
      delete f.hooks.capture
      if (change === 'status') f.card.querySelector('span')!.className = 'thread-state running'
      if (change === 'position') f.cardRect.mockReturnValue(new DOMRect(40, 100, 360, 200))
      if (change === 'toolbar') f.toolbarRect.mockReturnValue(new DOMRect(0, 0, 900, 92))
    }
    f.start(); await advance(41)
    expect(f.captures).toHaveLength(2)
    expect(f.runs).toHaveLength(1)
    expect(f.ready().cards[0]).toMatchObject(change === 'position' ? { x: 40, y: 100 } : { x: 20, y: 80 })
    expect(f.ready().viewport.y).toBe(change === 'toolbar' ? 92 : 42)
    await f.finish()
  })

  it('does not restart for tag text outside an unchanged card or for rolling time labels', async () => {
    const f = fixture()
    f.card.insertAdjacentHTML('beforeend', '<span class="thread-card-rolling-number">1</span>')
    f.hooks.capture = () => {
      f.toolbar.textContent = 'All · New tag'
      f.card.querySelector('.thread-card-rolling-number')!.textContent = '2'
    }
    f.start(); await advance()
    expect(f.captures).toHaveLength(1)
    expect(f.ready()).toBeDefined()
    await f.finish()
  })

  it('resizes the hidden surface when the root changes before takeoff', async () => {
    const f = fixture()
    f.hooks.capture = () => { delete f.hooks.capture; f.rootRect.mockReturnValue(new DOMRect(0, 0, 1100, 850)) }
    f.start(); await advance(41)
    expect(f.captures).toHaveLength(2)
    expect(f.ready()).toBeDefined()
    expect(f.surface.resize).toHaveBeenLastCalledWith(1100, 850)
    await f.finish()
  })

  it('waits for lazy card content before recapturing a stale snapshot', async () => {
    const f = fixture()
    f.hooks.capture = () => { delete f.hooks.capture; f.card.querySelector('strong')!.setAttribute('aria-busy', 'true') }
    f.start(); await advance(81)
    expect(f.captures).toHaveLength(1)
    expect(f.ready()).toBeUndefined()
    f.card.querySelector('strong')!.removeAttribute('aria-busy')
    await advance(41)
    expect(f.captures).toHaveLength(2)
    expect(f.ready()).toBeDefined()
    await f.finish()
  })

  it('uses the original seal deadline for continuously changing content', async () => {
    const f = fixture()
    f.hooks.capture = () => { f.card.querySelector('strong')!.textContent = `Revision ${f.captures.length}` }
    f.start(); await advance(1999)
    expect(f.captures.length).toBeGreaterThan(1)
    expect(f.store.getState().works).toHaveLength(1)
    await advance(2)
    expect(f.ready()).toBeUndefined()
    expect(f.runs).toHaveLength(0)
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.canvas().hidden).toBe(true)
    expect(f.card.inert).not.toBe(true)
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
    f.captures.forEach(capture => expect(capture.bitmap.close).toHaveBeenCalledTimes(1))
  })

  it.each(['cancel', 'delete', 'scene-cut'] as const)('does not retry after %s during the retry pause', async reason => {
    const f = fixture()
    f.hooks.capture = () => { f.card.querySelector('strong')!.textContent = 'Latest title' }
    f.start(); await advance()
    await act(async () => {
      if (reason === 'cancel') f.work.controller.abort()
      if (reason === 'delete') { getBartSpatialRegistry().registerThreadCard(id, null); f.card.remove() }
      if (reason === 'scene-cut') getOverviewMotionCoordinator().cutScene()
    })
    await advance(100)
    expect(f.captures).toHaveLength(1)
    expect(f.runs).toHaveLength(0)
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.canvas().hidden).toBe(true)
  })

  it('closes a late snapshot after the retry budget expires without uploading or replaying it', async () => {
    const f = fixture(), late = deferred<void>()
    f.hooks.capture = () => {
      if (f.captures.length === 1) f.card.querySelector('strong')!.textContent = 'Generated title'
      else return late.promise
    }
    f.start(); await advance(2001)
    expect(f.captures).toHaveLength(2)
    expect(f.store.getState().works).toHaveLength(0)
    await act(async () => late.resolve())
    expect(f.surface.load).not.toHaveBeenCalled()
    expect(f.runs).toHaveLength(0)
    f.captures.forEach(capture => expect(capture.bitmap.close).toHaveBeenCalledTimes(1))
  })

  it('keeps capture errors terminal instead of repeatedly retrying a broken resource', async () => {
    const f = fixture()
    mocks.capture.mockRejectedValue(new Error('Snapshot decoder failed'))
    f.start(); await advance(100)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.ready()).toBeUndefined()
  })

  it('hands off updated content without replaying an already visible animation', async () => {
    const f = fixture()
    f.start(); await advance()
    expect(f.canvas().hidden).toBe(false)
    f.card.querySelector('strong')!.textContent = 'New business content after takeoff'
    await advance(100)
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.captures).toHaveLength(1)
    expect(f.runs).toHaveLength(1)
    expect(f.card.style.visibility).toBe('')
    expect(f.canvas().hidden).toBe(true)
  })
})
