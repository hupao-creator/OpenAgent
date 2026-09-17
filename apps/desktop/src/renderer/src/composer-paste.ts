/**
 * Pure paste handling helpers so the clipboard extraction algorithm is testable
 * without a DOM. `extractPastePayload` mirrors the parts of ClipboardEvent that
 * matter: items/files plus the plain-text payload.
 */

export interface ClipboardLike<TFile = unknown> {
  items?: {
    [Symbol.iterator](): IterableIterator<{
      kind: string
      getAsFile(): TFile | null
    }>
  } | null
  files?: ArrayLike<TFile> | null
  getData?: (format: string) => string
}

interface PasteExtraction<TFile> {
  /** File items pasted with the event; empty when the paste is pure text. */
  files: TFile[]
  /** Plain-text payload, when present alongside files. */
  text: string | null
  /** True when the caller must preventDefault because files were pasted. */
  shouldPreventDefault: boolean
}

/** Input 与 textarea 共有的 selection surface；未支持选择的 input 允许返回 null。 */
export interface TextSelectionLike {
  value: string
  selectionStart: number | null
  selectionEnd: number | null
  setSelectionRange(start: number, end: number): void
  dispatchEvent(event: Event): boolean
}

export function extractPastePayload<TFile>(
  event: { clipboardData?: ClipboardLike<TFile> | null }
): PasteExtraction<TFile> {
  const clipboard = event.clipboardData
  const files: TFile[] = []
  const items = clipboard?.items
  if (items) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (!files.length && clipboard?.files) {
    for (const file of Array.from(clipboard.files)) files.push(file)
  }
  if (!files.length) return { files: [], text: null, shouldPreventDefault: false }
  const text = clipboard?.getData ? (clipboard.getData('text/plain') || null) : null
  return { files, text, shouldPreventDefault: true }
}

/**
 * Re-insert plain text at the current caret when a file paste is intercepted.
 * Dispatches an `input` event so React's controlled textarea sees the change.
 */
export function insertTextAtSelection(
  input: TextSelectionLike,
  text: string
): string {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const value = input.value
  input.value = value.slice(0, start) + text + value.slice(end)
  const cursor = start + text.length
  input.setSelectionRange(cursor, cursor)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return input.value
}
