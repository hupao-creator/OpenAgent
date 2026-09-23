import type {
  RendererAppState, RendererBartThreadRecord, RendererStateMutation, RendererThreadRecord
} from '../../shared/renderer-state-contracts'
import { projectBartVisualOperations, type BartVisualOperation } from './bart-visual-operation'

const visualOperationCache = new WeakMap<RendererBartThreadRecord, readonly BartVisualOperation[]>()
export function bartVisualOperations(thread: RendererBartThreadRecord): readonly BartVisualOperation[] {
  let operations = visualOperationCache.get(thread)
  if (!operations) {
    operations = projectBartVisualOperations(thread.transcript)
    visualOperationCache.set(thread, operations)
  }
  return operations
}

export function sameVisualOperations(left: readonly BartVisualOperation[], right: readonly BartVisualOperation[]): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right)
}

/** Text-only Bart patches cannot affect the Agent layout. Still inspect every
 * accepted patch synchronously: a layout-changing A → B → A must not coalesce. */
export function overviewTransitionChanged(
  current: RendererAppState, next: RendererAppState, mutation: RendererStateMutation
): boolean {
  if (mutation.effect || mutation.reports) return true
  if (mutation.threads?.upserts.some((thread) => !isBartThread(thread))) return true
  if (mutation.threads?.removedIds.some((id) => current.threads.some(
    (thread) => thread.id === id && !isBartThread(thread)
  ))) return true
  if (mutation.threads?.order) return true
  if (!mutation.threads) return false
  const before = current.threads.find(isBartThread)
  const after = next.threads.find(isBartThread)
  return !sameVisualOperations(before ? bartVisualOperations(before) : [], after ? bartVisualOperations(after) : [])
}

function isBartThread(thread: RendererThreadRecord): thread is RendererBartThreadRecord {
  return thread.bart === true
}
