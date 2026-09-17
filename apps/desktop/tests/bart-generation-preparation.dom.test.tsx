// @vitest-environment jsdom
import { useStore } from 'zustand'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartThreadGenerations, type BartGenerationWork } from '../src/renderer/src/components/BartThreadGeneration'
import { createOverviewOrchestrationStore } from '../src/renderer/src/overview-orchestration-store'
import { getBartSpatialRegistry } from '../src/renderer/src/bart-motion/registry'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion'
import type { PreparedMotionCard } from '../src/renderer/src/bart-motion/card-assets'
import type { MotionProgram, MotionRect } from '../src/renderer/src/bart-motion/worker-types'

const mocks = vi.hoisted(() => ({ sample: vi.fn(), capture: vi.fn(), surface: vi.fn() }))
vi.mock('../src/renderer/src/bart-motion/card-assets', async importOriginal => ({
  ...await importOriginal<typeof import('../src/renderer/src/bart-motion/card-assets')>(),
  prewarmMotionCards: async () => '', captureMotionCard: mocks.sample
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

const id = 'preparation-target', secondId = 'preparation-second'
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
  registry.registerThreadCard(secondId, null)
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

function fixture({ liquid = false }: { liquid?: boolean } = {}) {
  const root = document.createElement('main')
  root.className = 'app-shell'
  const scrollMarkup = '<div class="thread-overview-scroll">' +
    '<article><strong>Initial title</strong><span class="thread-state idle">Idle</span></article></div>'
  root.innerHTML = '<section><header class="thread-overview-header"></header>' +
    (liquid ? `<div class="overview-liquid-substrate">${scrollMarkup}</div>` : scrollMarkup) + '</section>' +
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
  const samples: { text: string | null; disposed: boolean }[] = []
  const captures: { text: string | null; bitmap: ImageBitmap }[] = []
  const runs: { program: MotionProgram; finish: () => void; release: ReturnType<typeof vi.fn>; landCharacter: ReturnType<typeof vi.fn> }[] = []
  const hooks: { capture?: () => Promise<void> | void; load?: () => Promise<void> | void;
    borrow?: () => Promise<void> | void; start?: () => Promise<void> | void; land?: () => Promise<void> | void } = {}
  mocks.sample.mockImplementation((element: HTMLElement, origin: { x: number; y: number }) => {
    const bounds = element.getBoundingClientRect()
    const rect = { x: bounds.x - origin.x, y: bounds.y - origin.y, width: bounds.width, height: bounds.height }
    const sample = { text: element.textContent, disposed: false }
    samples.push(sample)
    return { prepare: () => mocks.capture(sample.text, rect), dispose: () => { sample.disposed = true } }
  })
  mocks.capture.mockImplementation(async (text: string | null, rect: MotionRect): Promise<PreparedMotionCard> => {
    const bitmap = { width: 360, height: 200, close: vi.fn() } as unknown as ImageBitmap
    captures.push({ text, bitmap })
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
      const release = vi.fn(), landCharacter = vi.fn(async () => { await hooks.land?.() })
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
  return { root, rootRect, card, toolbar, cardRect, toolbarRect, work, store, samples, captures, runs, hooks, surface,
    start() { store.enqueue(work); return render(<Generations />, { container: root.querySelector('.generation-host')! }) },
    canvas: () => root.querySelector<HTMLCanvasElement>('canvas')!,
    ready: () => (performance.getEntriesByName('bart-generation-ready').at(-1) as PerformanceMark | undefined)?.detail,
    async finish() { await act(async () => { runs.at(-1)!.finish() }); await advance() }
  }
}

describe('generation preparation separates sampled content from live geometry', () => {
  it.each(['capture', 'load', 'borrow', 'start'] as const)('keeps its sampled input when metadata changes during %s', async boundary => {
    const f = fixture()
    f.hooks[boundary] = () => {
      f.card.querySelector('strong')!.textContent = 'Generated title'
      f.card.querySelector('span')!.className = 'thread-state running'
      f.toolbar.textContent = 'All · New tag'
    }
    f.start(); await advance()
    expect(f.ready()).toBeDefined()
    expect(f.canvas().hidden).toBe(false)
    expect(f.store.getState()).toMatchObject({ works: [f.work], hiddenIds: [id] })
    expect(f.work.controller.signal.aborted).toBe(false)
    expect(f.captures.map(capture => capture.text)).toEqual(['Initial titleIdle'])
    expect(f.runs).toHaveLength(1)
    expect(f.surface.resetPreparation).not.toHaveBeenCalled()
    expect(f.captures[0].bitmap.close).not.toHaveBeenCalled()
    expect(f.samples.every(sample => sample.disposed)).toBe(true)
    await f.finish()
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.canvas().hidden).toBe(true)
    expect(f.card.style.visibility).toBe('')
    expect(f.card.textContent).toContain('Generated title')
    expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
    expect(f.runs[0].release).toHaveBeenCalledTimes(1)
    expect(performance.getEntriesByName('bart-generation-skipped')).toHaveLength(0)
  })

  it('samples every card before asynchronous encoding starts', async () => {
    const f = fixture(), second = f.card.cloneNode(true) as HTMLElement
    second.querySelector('strong')!.textContent = 'Second original'
    f.card.parentElement!.append(second)
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, 80, 360, 200))
    getBartSpatialRegistry().registerThreadCard(secondId, second)
    f.work.targets = [...f.work.targets, { ...f.work.targets[0]!, id: secondId }]
    f.hooks.capture = () => { second.querySelector('strong')!.textContent = 'Second updated' }
    f.start(); await advance()
    expect(f.captures.map(capture => capture.text)).toEqual(['Initial titleIdle', 'Second originalIdle'])
    expect(f.ready().cards).toHaveLength(2)
    await f.finish()
    expect(second.textContent).toContain('Second updated')
    expect(f.samples.every(sample => sample.disposed)).toBe(true)
  })

  it.each(['position', 'toolbar'] as const)('remeasures changed %s before the single visible flight', async change => {
    const f = fixture()
    f.hooks.capture = () => {
      delete f.hooks.capture
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

  it.each(['load', 'borrow', 'start'] as const)('still rejects stale geometry after %s', async boundary => {
    const f = fixture()
    f.hooks[boundary] = () => {
      delete f.hooks[boundary]
      f.cardRect.mockReturnValue(new DOMRect(40, 100, 360, 200))
    }
    f.start(); await advance(41)
    expect(f.captures).toHaveLength(2)
    expect(f.ready().cards[0]).toMatchObject({ x: 40, y: 100 })
    expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
    if (boundary === 'start') expect(f.runs[0].release).toHaveBeenCalledTimes(1)
    await f.finish()
  })

  it('finds the toolbar across the liquid glass substrate', async () => {
    // 液体玻璃路径把滚动容器塞进了衬底，工具条不再是一级之隔的兄弟。
    const f = fixture({ liquid: true })
    f.start(); await advance()
    expect(f.ready()).toBeDefined()
    expect(f.ready().viewport.y).toBe(42)
    await f.finish()
  })

  it('retries when a previously absent toolbar mounts', async () => {
    const f = fixture()
    f.toolbar.remove()
    f.hooks.capture = () => { delete f.hooks.capture; f.card.parentElement!.before(f.toolbar) }
    f.start(); await advance(41)
    expect(f.captures).toHaveLength(2)
    expect(f.ready().viewport.y).toBe(42)
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

  it('waits for lazy content before sampling, but not for later business work', async () => {
    const f = fixture()
    f.card.querySelector('strong')!.setAttribute('aria-busy', 'true')
    f.start(); await advance(81)
    expect(f.samples).toHaveLength(0)
    f.card.querySelector('strong')!.removeAttribute('aria-busy')
    f.hooks.capture = () => { f.card.querySelector('strong')!.setAttribute('aria-busy', 'true') }
    await advance(41)
    expect(f.captures).toHaveLength(1)
    expect(f.ready()).toBeDefined()
    await f.finish()
  })

  it('starts one program while content changes throughout the async preparation boundaries', async () => {
    const f = fixture()
    let revision = 0
    for (const boundary of ['capture', 'load', 'borrow', 'start'] as const) {
      f.hooks[boundary] = async () => {
        for (let chunk = 0; chunk < 3; chunk++) {
          f.card.querySelector('strong')!.textContent = `Revision ${++revision}`
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
    }
    f.start(); await advance(1500)
    expect(revision).toBe(12)
    expect(f.ready()).toBeDefined()
    expect(f.captures.map(capture => capture.text)).toEqual(['Initial titleIdle'])
    expect(f.runs).toHaveLength(1)
    expect(f.surface.resetPreparation).not.toHaveBeenCalled()
    await f.finish()
    expect(f.card.textContent).toContain('Revision 12')
  })

  it('uses the original seal deadline for continuously changing geometry', async () => {
    const f = fixture()
    f.hooks.capture = () => { f.cardRect.mockReturnValue(new DOMRect(40 + f.captures.length, 100, 360, 200)) }
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
    expect(f.samples.every(sample => sample.disposed)).toBe(true)
  })

  it.each(['cancel', 'delete', 'scene-cut'] as const)('does not retry after %s during the retry pause', async reason => {
    const f = fixture()
    f.hooks.capture = () => { f.cardRect.mockReturnValue(new DOMRect(40, 100, 360, 200)) }
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
      if (f.captures.length === 1) f.cardRect.mockReturnValue(new DOMRect(40, 100, 360, 200))
      else return late.promise
    }
    f.start(); await advance(2001)
    expect(f.captures).toHaveLength(2)
    expect(f.store.getState().works).toHaveLength(0)
    expect(f.samples.every(sample => sample.disposed)).toBe(true)
    await act(async () => late.resolve())
    expect(f.surface.load).not.toHaveBeenCalled()
    expect(f.runs).toHaveLength(0)
    f.captures.forEach(capture => expect(capture.bitmap.close).toHaveBeenCalledTimes(1))
  })

  it.each(['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)'])(
    'interrupts preparation when %s changes', async query => {
      const media = new Map<string, EventTarget>()
      vi.stubGlobal('matchMedia', (value: string) => {
        if (!media.has(value)) media.set(value, new EventTarget())
        return media.get(value)
      })
      const f = fixture(), gate = deferred<void>()
      f.hooks.capture = () => gate.promise
      f.start(); await advance()
      await act(async () => { media.get(query)!.dispatchEvent(new Event('change')) })
      await advance()
      expect(f.samples.every(sample => sample.disposed)).toBe(true)
      expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
      await act(async () => gate.resolve())
      expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
      expect(f.surface.load).not.toHaveBeenCalled()
    })

  it('keeps capture errors terminal instead of repeatedly retrying a broken resource', async () => {
    const f = fixture()
    mocks.capture.mockRejectedValue(new Error('Snapshot decoder failed'))
    f.start(); await advance(100)
    expect(mocks.capture).toHaveBeenCalledTimes(1)
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.ready()).toBeUndefined()
    expect(f.samples.every(sample => sample.disposed)).toBe(true)
  })
})

describe('generation playback survives live card updates', () => {
  it('finishes the visible reveal and landing before handing off the latest content', async () => {
    const f = fixture()
    const landed = deferred<void>()
    f.hooks.land = () => landed.promise
    f.start(); await advance()
    expect(f.canvas().hidden).toBe(false)
    const initialOrigin = f.ready().origin
    for (const text of ['First streamed chunk', 'More streamed content', 'Latest streamed content']) {
      f.card.querySelector('strong')!.textContent = text
      f.card.querySelector('span')!.className = 'thread-state running'
      await advance(100)
      expect(f.store.getState()).toMatchObject({ works: [f.work], hiddenIds: [id] })
      expect(f.canvas().dataset.generationState).toBe('playing')
      expect(f.canvas().hidden).toBe(false)
      expect(f.card.style.visibility).toBe('hidden')
      expect(f.work.controller.signal.aborted).toBe(false)
      expect(f.captures[0].bitmap.close).not.toHaveBeenCalled()
    }
    await f.finish()
    expect(f.canvas().dataset.generationState).toBe('waiting-host')
    expect(f.store.getState().works).toHaveLength(1)
    expect(f.runs[0].landCharacter).toHaveBeenCalledTimes(1)
    f.card.querySelector('strong')!.textContent = 'Latest content during landing'
    await advance(100)
    expect(f.canvas().hidden).toBe(false)
    await act(async () => landed.resolve())
    expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
    expect(f.ready().origin).toBe(initialOrigin)
    expect(f.captures).toHaveLength(1)
    expect(f.runs).toHaveLength(1)
    expect(f.card.style.visibility).toBe('')
    expect(f.card.textContent).toContain('Latest content during landing')
    expect(f.canvas().hidden).toBe(true)
    expect(f.runs[0].release).toHaveBeenCalledTimes(1)
    expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
    expect(performance.getEntriesByName('bart-generation-skipped')).toHaveLength(0)
    expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  })

  it.each(['cancel', 'delete', 'scene-cut', 'resize', 'theme', 'reduced-motion'] as const)(
    'still interrupts visible playback on %s', async reason => {
      const media = new Map<string, EventTarget>()
      vi.stubGlobal('matchMedia', (query: string) => {
        if (!media.has(query)) media.set(query, new EventTarget())
        return media.get(query)
      })
      let resize = () => {}
      vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resize = callback }
        observe() {} disconnect() {}
      })
      const f = fixture()
      f.start(); await advance()
      expect(f.canvas().hidden).toBe(false)
      await act(async () => {
        if (reason === 'cancel') f.work.controller.abort()
        if (reason === 'delete') { getBartSpatialRegistry().registerThreadCard(id, null); f.card.remove() }
        if (reason === 'scene-cut') getOverviewMotionCoordinator().cutScene()
        if (reason === 'resize') { f.rootRect.mockReturnValue(new DOMRect(0, 0, 1100, 800)); resize() }
        if (reason === 'theme') media.get('(prefers-color-scheme: dark)')!.dispatchEvent(new Event('change'))
        if (reason === 'reduced-motion') media.get('(prefers-reduced-motion: reduce)')!.dispatchEvent(new Event('change'))
      })
      await advance()
      expect(f.store.getState()).toMatchObject({ works: [], hiddenIds: [] })
      expect(f.canvas().hidden).toBe(true)
      expect(f.card.style.visibility).toBe('')
      expect(f.runs[0].landCharacter).not.toHaveBeenCalled()
      expect(f.runs[0].release).toHaveBeenCalledTimes(1)
      expect(f.captures[0].bitmap.close).toHaveBeenCalledTimes(1)
      expect(getOverviewMotionCoordinator().stageBusy).toBe(false)
  })
})
