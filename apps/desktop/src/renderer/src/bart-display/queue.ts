import type { PublicExecution } from '@openagent/contracts'
import type { BartDockRole } from '../bart-role'
import { DEFAULT_BART_DISPLAY_TIMING, releaseDelay, validateDisplayTiming, type BartDisplayTiming } from './state-rules'

export interface BartDisplayItem {
  readonly sequence: number
  readonly role: BartDockRole
}
export interface BartDisplayInput {
  readonly scope: string
  readonly status: PublicExecution['status'] | null
  readonly items: readonly BartDisplayItem[]
  /** Latest snapshot is for hydration/recovery, not reconstructing live history. */
  readonly latest: BartDisplayItem
  readonly reset?: boolean
}
export interface BartDisplaySnapshot {
  /** A presentation lease: acknowledgements from replaced renders are ignored. */
  readonly token: number
  readonly item: BartDisplayItem
}
export interface BartDisplayClock {
  now(): number
  schedule(callback: () => void, ms: number): () => void
}
const systemClock: BartDisplayClock = {
  now: () => performance.now(),
  schedule: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) }
}
export const IDLE_DISPLAY_ITEM: BartDisplayItem = { sequence: -1, role: { kind: 'idle' } }
export const RUNNING_DISPLAY_ITEM: BartDisplayItem = { sequence: 0, role: { kind: 'running' } }

/** Transient, React/DOM/storage-independent presentation consumer. */
export class BartDisplayQueue {
  private scope: string | undefined
  private status: BartDisplayInput['status'] = null
  private pending: BartDisplayItem[] = []
  private latest = IDLE_DISPLAY_ITEM
  private highSequence = -1
  private presenting = false
  private shownAt: number | undefined
  private cancelTimer: (() => void) | undefined
  private timerGeneration = 0
  private disposed = false
  private timing = DEFAULT_BART_DISPLAY_TIMING
  private snapshot: BartDisplaySnapshot = { token: 0, item: IDLE_DISPLAY_ITEM }
  private readonly listeners = new Set<() => void>()

  constructor(private readonly clock: BartDisplayClock = systemClock) {}

  getSnapshot = (): BartDisplaySnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    if (!this.disposed) this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  receive(input: BartDisplayInput): void {
    if (this.disposed) return
    const changed = this.scope !== input.scope
    if (changed || input.reset) {
      this.cancel()
      this.scope = input.scope
      this.pending = []
      this.highSequence = -1
      this.latest = IDLE_DISPLAY_ITEM
      this.status = null
      this.select(IDLE_DISPLAY_ITEM)
    }
    if (input.reset) {
      this.status = input.status
      this.latest = input.status === 'running' ? input.latest : IDLE_DISPLAY_ITEM
      this.highSequence = input.latest.sequence
      this.select(this.latest)
      return
    }
    // Once terminal, late events cannot reopen an execution. waiting-for-user
    // may resume, but its discarded sequence is still remembered.
    if (!changed && (this.status === 'completed' || this.status === 'failed' || this.status === 'interrupted')) return
    if (input.status !== 'running' && input.status !== 'completed') {
      this.status = input.status
      this.highSequence = Math.max(this.highSequence, input.latest.sequence,
        ...input.items.map(item => item.sequence))
      if (this.pending.length || !sameItem(this.snapshot.item, IDLE_DISPLAY_ITEM)) this.synchronize(IDLE_DISPLAY_ITEM)
      this.latest = IDLE_DISPLAY_ITEM
      return
    }
    this.status = input.status
    for (const item of input.items) this.accept(item)
    // Snapshot updates remain useful for initial state and legacy direct
    // mounters. Sequence fencing prevents older commits undoing live input.
    if (input.status === 'running') this.accept(input.latest)
    if (this.snapshot.item.role.kind === 'idle' && input.status === 'running') {
      this.latest = RUNNING_DISPLAY_ITEM
      this.select(this.latest)
    }
    if (input.status === 'completed') {
      this.latest = IDLE_DISPLAY_ITEM
      if (this.snapshot.item.sequence <= 0 && !this.pending.length) this.select(IDLE_DISPLAY_ITEM)
    }
    if (!this.presenting && (this.pending.length || !sameItem(this.snapshot.item, this.latest))) this.synchronize(this.latest)
    this.schedule()
  }

  setPresenting(value: boolean): void {
    if (this.disposed || value === this.presenting) return
    this.presenting = value
    this.synchronize(this.latest)
  }

  setTiming(timing: BartDisplayTiming): void {
    validateDisplayTiming(timing)
    if (Object.keys(this.timing).every(key => {
      const kind = key as keyof BartDisplayTiming
      return this.timing[kind].minimumDisplayMs === timing[kind].minimumDisplayMs
    })) return
    this.timing = structuredClone(timing)
    this.schedule()
  }

  /** Call after the consumer actually presents this lease, not on enqueue. */
  presented(token: number): void {
    if (this.disposed || !this.presenting || token !== this.snapshot.token || this.shownAt !== undefined) return
    this.shownAt = this.clock.now()
    this.schedule()
  }

  /** Explicit catch-up, e.g. a dedicated animation briefly takes ownership. */
  synchronize(item: BartDisplayItem = this.latest): void {
    if (this.disposed) return
    this.pending = []
    this.latest = item
    this.highSequence = Math.max(this.highSequence, item.sequence)
    this.select(item)
  }

  dispose(): void {
    this.cancel()
    this.disposed = true
    this.pending = []
    this.listeners.clear()
  }

  private accept(item: BartDisplayItem): void {
    if (item.sequence < this.highSequence || item.role.kind === 'idle') return
    if (item.sequence === this.highSequence) {
      const current = this.snapshot.item
      if (current.sequence === item.sequence) {
        if (olderReasoning(item, current)) return
        if (!sameItem(current, item)) {
          this.latest = item
          this.snapshot = { ...this.snapshot, item }
          this.notify()
        }
      } else {
        const index = this.pending.findIndex(entry => entry.sequence === item.sequence)
        if (index >= 0 && !olderReasoning(item, this.pending[index])) this.latest = this.pending[index] = item
      }
      return
    }
    this.highSequence = item.sequence
    this.latest = item
    // Initial generic waiting is not a historical semantic item.
    if (!this.presenting || (this.snapshot.item.role.kind === 'idle' || this.snapshot.item.sequence <= 0) && !this.pending.length) this.select(item)
    else this.pending.push(item)
  }

  private select(item: BartDisplayItem): void {
    this.cancel()
    this.shownAt = undefined
    this.snapshot = { token: this.snapshot.token + 1, item }
    this.notify()
  }

  private schedule(): void {
    this.cancel()
    if (this.disposed || !this.presenting || this.shownAt === undefined ||
      !this.pending.length && this.status !== 'completed' || this.snapshot.item.role.kind === 'idle') return
    const generation = this.timerGeneration
    const delay = releaseDelay(this.snapshot.item.role, this.clock.now() - this.shownAt, this.timing)
    // Long legal durations must not overflow the platform's 32-bit timeout.
    this.cancelTimer = this.clock.schedule(() => {
      if (generation !== this.timerGeneration || this.disposed) return
      const remaining = releaseDelay(this.snapshot.item.role, this.clock.now() - this.shownAt!, this.timing)
      if (remaining > 0) { this.schedule(); return }
      const next = this.pending.shift()
      if (next) this.select(next)
      else if (this.status === 'completed') this.select(IDLE_DISPLAY_ITEM)
    }, Math.min(delay, 2_147_483_647))
  }

  private cancel(): void {
    this.timerGeneration += 1
    this.cancelTimer?.()
    this.cancelTimer = undefined
  }

  private notify(): void { for (const listener of this.listeners) listener() }
}

function sameItem(left: BartDisplayItem, right: BartDisplayItem): boolean {
  if (left === right) return true
  // Reasoning can move its source window even if the displayed tail is equal.
  return JSON.stringify(left) === JSON.stringify(right)
}

function olderReasoning(next: BartDisplayItem, current: BartDisplayItem): boolean {
  if (next.role.kind !== 'reasoning' || current.role.kind !== 'reasoning') return false
  const end = (role: Extract<BartDockRole, { kind: 'reasoning' }>) =>
    (role.sourceOffset ?? 0) + (role.sourceText ?? role.text).length
  return end(next.role) < end(current.role)
}
