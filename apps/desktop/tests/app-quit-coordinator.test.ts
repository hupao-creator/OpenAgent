import { describe, expect, it, vi } from 'vitest'
import {
  AppQuitCoordinator,
  type AppQuitPhase
} from '../src/main/app-quit-coordinator'

function beforeQuitEvent() {
  return { preventDefault: vi.fn<() => void>() }
}

async function drainMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('AppQuitCoordinator', () => {
  it('reports a synchronous drain throw without skipping the deferred quit', async () => {
    const failure = new Error('synchronous drain failed')
    const report = vi.fn()
    const quit = vi.fn()
    const coordinator = new AppQuitCoordinator({
      drain: () => { throw failure },
      quit,
      schedule: callback => setImmediate(callback),
      onDrainError: report
    })
    coordinator.handleBeforeQuit(beforeQuitEvent())
    expect(quit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    expect(report).toHaveBeenCalledWith(failure)
  })

  it('falls back to a later turn when scheduling throws and quits at most once', async () => {
    const failure = new Error('scheduler failed after enqueue')
    const report = vi.fn()
    const quit = vi.fn()
    let scheduled!: () => void
    const coordinator = new AppQuitCoordinator({
      drain: () => undefined,
      quit,
      schedule: callback => { scheduled = callback; throw failure },
      onDrainError: report
    })
    coordinator.handleBeforeQuit(beforeQuitEvent())
    await drainMicrotasks()
    expect(quit).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce())
    scheduled()
    expect(quit).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(failure)
  })

  it('reports a throwing native quit callback without rejecting the transition', async () => {
    const failure = new Error('native quit failed')
    const report = vi.fn()
    let scheduled!: () => void
    const coordinator = new AppQuitCoordinator({
      drain: () => undefined,
      quit: () => { throw failure },
      schedule: callback => { scheduled = callback },
      onDrainError: report
    })
    coordinator.handleBeforeQuit(beforeQuitEvent())
    await drainMicrotasks()
    expect(() => scheduled()).not.toThrow()
    expect(report).toHaveBeenCalledWith(failure)
    expect(coordinator.phase).toBe('ready')
  })

  it('crosses an event-loop turn after a synchronously settled drain', async () => {
    const drain = vi.fn(() => undefined)
    const quit = vi.fn()
    const scheduled: Array<() => void> = []
    const phases: AppQuitPhase[] = []
    const coordinator = new AppQuitCoordinator({
      drain,
      quit,
      schedule: callback => { scheduled.push(callback) },
      onPhaseChange: phase => { phases.push(phase) }
    })

    const first = beforeQuitEvent()
    coordinator.handleBeforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(coordinator.phase).toBe('draining')
    expect(quit).not.toHaveBeenCalled()

    await drainMicrotasks()
    expect(drain).toHaveBeenCalledOnce()
    expect(coordinator.phase).toBe('ready')
    expect(scheduled).toHaveLength(1)
    expect(quit).not.toHaveBeenCalled()

    scheduled[0]()
    expect(quit).toHaveBeenCalledOnce()
    expect(phases).toEqual(['draining', 'ready'])
  })

  it('keeps every repeated quit request blocked while the drain is pending', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const drain = vi.fn(() => gate)
    const scheduled: Array<() => void> = []
    const coordinator = new AppQuitCoordinator({
      drain,
      quit: vi.fn(),
      schedule: callback => { scheduled.push(callback) }
    })

    const first = beforeQuitEvent()
    const repeated = beforeQuitEvent()
    coordinator.handleBeforeQuit(first)
    coordinator.handleBeforeQuit(repeated)

    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(drain).toHaveBeenCalledOnce()
    expect(scheduled).toEqual([])

    release()
    await drainMicrotasks()
    expect(scheduled).toHaveLength(1)
  })

  it('allows only the ready pass through to Electron', async () => {
    const scheduled: Array<() => void> = []
    const coordinator = new AppQuitCoordinator({
      drain: () => undefined,
      quit: vi.fn(),
      schedule: callback => { scheduled.push(callback) }
    })
    coordinator.handleBeforeQuit(beforeQuitEvent())
    await drainMicrotasks()

    const readyPass = beforeQuitEvent()
    coordinator.handleBeforeQuit(readyPass)
    expect(readyPass.preventDefault).not.toHaveBeenCalled()
    expect(coordinator.phase).toBe('ready')
  })

  it('reports a rejected drain and still schedules the clean final pass', async () => {
    const failure = new Error('fixture drain failed')
    const onDrainError = vi.fn()
    const scheduled: Array<() => void> = []
    const coordinator = new AppQuitCoordinator({
      drain: async () => { throw failure },
      quit: vi.fn(),
      schedule: callback => { scheduled.push(callback) },
      onDrainError
    })

    coordinator.handleBeforeQuit(beforeQuitEvent())
    await drainMicrotasks()

    expect(onDrainError).toHaveBeenCalledWith(failure)
    expect(coordinator.phase).toBe('ready')
    expect(scheduled).toHaveLength(1)
  })

  it('isolates throwing diagnostics from the ready transition', async () => {
    const scheduled: Array<() => void> = []
    const coordinator = new AppQuitCoordinator({
      drain: async () => { throw new Error('fixture drain failed') },
      quit: vi.fn(),
      schedule: callback => { scheduled.push(callback) },
      onDrainError: () => { throw new Error('fixture reporter failed') },
      onPhaseChange: () => { throw new Error('fixture phase reporter failed') }
    })

    coordinator.handleBeforeQuit(beforeQuitEvent())
    await drainMicrotasks()

    expect(coordinator.phase).toBe('ready')
    expect(scheduled).toHaveLength(1)
  })
})
