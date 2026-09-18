// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_TRANSITION_CLASS, predictsDark, runThemeTransition, waitForSchemeFlip
} from '../src/renderer/src/theme-transition'

/** jsdom ships no View Transition API, so the suite installs and removes its own. */
const installViewTransitionApi = (value: unknown): void => {
  Object.defineProperty(document, 'startViewTransition', { value, configurable: true, writable: true })
}
const removeViewTransitionApi = (): void => { Reflect.deleteProperty(document, 'startViewTransition') }

class FakeQuery {
  matches: boolean
  private readonly listeners = new Set<() => void>()

  constructor(matches: boolean) { this.matches = matches }

  addEventListener = (_type: 'change', listener: () => void): void => { this.listeners.add(listener) }
  removeEventListener = (_type: 'change', listener: () => void): void => { this.listeners.delete(listener) }

  set(matches: boolean): void {
    this.matches = matches
    for (const listener of [...this.listeners]) listener()
  }

  get listenerCount(): number { return this.listeners.size }
}

const asQuery = (query: FakeQuery): MediaQueryList => query as unknown as MediaQueryList

function installMatchMedia(schemeDark: boolean) {
  const scheme = new FakeQuery(schemeDark)
  window.matchMedia = (() => scheme) as unknown as typeof window.matchMedia
  return { scheme }
}

function installViewTransition() {
  const queued: Array<() => void | Promise<void>> = []
  const settles: Array<() => void> = []
  const skipTransition = vi.fn()
  const startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    queued.push(callback)
    return {
      finished: new Promise<unknown>((resolve) => { settles.push(() => resolve(undefined)) }),
      skipTransition
    }
  })
  installViewTransitionApi(startViewTransition)
  return {
    startViewTransition,
    skipTransition,
    /** Runs the callback the browser would run after capturing the old frame. */
    run: async (): Promise<void> => { await queued.shift()?.() },
    finish: (): void => { for (const settle of settles.splice(0)) settle() }
  }
}

const transitioning = (): boolean => document.documentElement.classList.contains(THEME_TRANSITION_CLASS)

afterEach(() => {
  vi.useRealTimers()
  document.documentElement.classList.remove(THEME_TRANSITION_CLASS)
  removeViewTransitionApi()
})

describe('appearance blur fade transition', () => {
  it('resolves the scheme a preference implies and defers to the OS for system', () => {
    expect(predictsDark('dark')).toBe(true)
    expect(predictsDark('light')).toBe(false)
    expect(predictsDark('system')).toBeNull()
  })

  it('reports an already flipped scheme without listening', async () => {
    const { scheme } = installMatchMedia(true)
    await expect(waitForSchemeFlip(asQuery(scheme), false)).resolves.toBe(true)
    expect(scheme.listenerCount).toBe(0)
  })

  it('resolves on the flip and stops listening', async () => {
    const { scheme } = installMatchMedia(false)
    const flip = waitForSchemeFlip(asQuery(scheme), false, 1000)
    scheme.set(true)
    await expect(flip).resolves.toBe(true)
    expect(scheme.listenerCount).toBe(0)
  })

  it('reports no flip when the scheme never changes', async () => {
    vi.useFakeTimers()
    const { scheme } = installMatchMedia(false)
    const flip = waitForSchemeFlip(asQuery(scheme), false, 100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(flip).resolves.toBe(false)
    expect(scheme.listenerCount).toBe(0)
  })

  it('applies without a transition when the preference leaves the scheme alone', async () => {
    installMatchMedia(true)
    const viewTransition = installViewTransition()
    const apply = vi.fn(async () => undefined)
    await runThemeTransition('dark', apply)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(viewTransition.startViewTransition).not.toHaveBeenCalled()
    expect(transitioning()).toBe(false)

    // The same branch decides the light preference against a light scheme.
    installMatchMedia(false)
    const second = vi.fn(async () => undefined)
    await runThemeTransition('light', second)
    expect(second).toHaveBeenCalledTimes(1)
    expect(viewTransition.startViewTransition).not.toHaveBeenCalled()
    expect(transitioning()).toBe(false)
  })

  it('applies without a transition when the API is absent', async () => {
    installMatchMedia(false)
    removeViewTransitionApi()
    const apply = vi.fn(async () => undefined)
    await runThemeTransition('dark', apply)
    expect(apply).toHaveBeenCalledTimes(1)
    expect(transitioning()).toBe(false)
  })

  it('blurs the swap only once the resolved scheme has changed', async () => {
    const { scheme } = installMatchMedia(false)
    const viewTransition = installViewTransition()
    const apply = vi.fn(async () => { scheme.set(true) })
    const applied = runThemeTransition('dark', apply)

    expect(viewTransition.startViewTransition).toHaveBeenCalledTimes(1)
    expect(transitioning()).toBe(false)

    await viewTransition.run()
    // The mutation is settled, but the frame must stay blurred until the
    // transition ends or the class would leave the window stuck.
    await applied
    expect(apply).toHaveBeenCalledTimes(1)
    expect(transitioning()).toBe(true)

    viewTransition.finish()
    await Promise.resolve()
    expect(transitioning()).toBe(false)
  })

  it('blurs an OS-decided change once the scheme follows it', async () => {
    const { scheme } = installMatchMedia(false)
    const viewTransition = installViewTransition()
    const apply = vi.fn(async () => { scheme.set(true) })
    const applied = runThemeTransition('system', apply)

    await viewTransition.run()
    await applied
    expect(viewTransition.skipTransition).not.toHaveBeenCalled()
    expect(transitioning()).toBe(true)
  })

  it('skips the default cross-fade when an OS-decided preference holds the scheme', async () => {
    vi.useFakeTimers()
    const { scheme } = installMatchMedia(false)
    const viewTransition = installViewTransition()
    const apply = vi.fn(async () => undefined)
    const applied = runThemeTransition('system', apply)

    const running = viewTransition.run()
    await vi.advanceTimersByTimeAsync(200)
    await running
    await applied
    expect(apply).toHaveBeenCalledTimes(1)
    expect(transitioning()).toBe(false)
    expect(scheme.listenerCount).toBe(0)
    // Chromium would otherwise dissolve the two identical frames on its own.
    expect(viewTransition.skipTransition).toHaveBeenCalledTimes(1)
  })

  it('surfaces a failed mutation and drops the blur', async () => {
    const { scheme } = installMatchMedia(false)
    const viewTransition = installViewTransition()
    const failure = new Error('mutation rejected')
    const applied = runThemeTransition('dark', async () => {
      scheme.set(true)
      throw failure
    })
    const running = viewTransition.run()
    await expect(running).rejects.toThrow(failure)
    await expect(applied).rejects.toThrow(failure)
    viewTransition.finish()
    await Promise.resolve()
    // The mutation failed before a frame was captured, so the blur is never
    // attached and the no-op skip path must not swallow the rejection.
    expect(transitioning()).toBe(false)
    expect(viewTransition.skipTransition).not.toHaveBeenCalled()
  })
})
