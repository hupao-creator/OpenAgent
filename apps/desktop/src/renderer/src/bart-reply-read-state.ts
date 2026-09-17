import { useSyncExternalStore } from 'react'

/**
 * Local read record for Bart final replies. It outlives the Dock mount so a
 * restart does not resurrect an answer the user already read, and it stores
 * identity only — never a copy of the answer text.
 */
const STORAGE_KEY = 'openagent.bart.reply-read'
const MAX_ENTRIES = 256

const EMPTY: ReadonlySet<string> = new Set()

let snapshot: ReadonlySet<string> | undefined
const listeners = new Set<() => void>()

/** Isolation key: one Bart thread on one Harness for one reply identity. */
export function bartReplyReadKey(
  threadId: string,
  harnessId: string,
  replyId: string
): string {
  return JSON.stringify([threadId, harnessId, replyId])
}

export function bartReplyReadSnapshot(): ReadonlySet<string> {
  snapshot ??= read()
  return snapshot
}

export function isBartReplyRead(key: string | undefined): boolean {
  return key !== undefined && bartReplyReadSnapshot().has(key)
}

export function markBartReplyRead(key: string | undefined): void {
  if (key === undefined) return
  const current = bartReplyReadSnapshot()
  if (current.has(key)) return
  const ordered = [...current, key].slice(-MAX_ENTRIES)
  snapshot = new Set(ordered)
  write(ordered)
  for (const listener of listeners) listener()
}

export function useBartReplyRead(key: string | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isBartReplyRead(key),
    () => false
  )
}

/** Test seam: drop the cached snapshot so the next read starts from storage. */
export function resetBartReplyReadState(): void {
  snapshot = undefined
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function read(): ReadonlySet<string> {
  try {
    const raw = storage()?.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY
    // A damaged record degrades to "nothing read" instead of failing the Dock.
    return new Set(
      parsed.filter((entry): entry is string => typeof entry === 'string').slice(-MAX_ENTRIES)
    )
  } catch {
    return EMPTY
  }
}

function write(keys: readonly string[]): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // A full or unavailable store keeps the in-memory record for this session.
  }
}
