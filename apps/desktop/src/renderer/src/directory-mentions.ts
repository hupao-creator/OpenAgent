import type { AgentInputPart } from '@openagent/contracts'
import type { KnownDirectory } from '../../shared/known-directory'

export interface DirectoryMention extends KnownDirectory {
  readonly start: number
  readonly end: number
}

export interface MentionQuery {
  readonly start: number
  readonly end: number
  readonly query: string
}

export function directoryMentionQuery(text: string, start: number, end = start): MentionQuery | undefined {
  if (start !== end) return undefined
  const before = text.slice(0, start)
  const match = /(?:^|\s)@([^\s@"]*)$/u.exec(before)
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : undefined
}

/** Preserve references outside an edit; editing a reference makes it ordinary text. */
export function reconcileDirectoryMentions(
  previous: string, next: string, mentions: readonly DirectoryMention[]
): readonly DirectoryMention[] {
  if (previous === next) return mentions
  let start = 0
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++
  let oldEnd = previous.length, newEnd = next.length
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--; newEnd--
  }
  const delta = newEnd - oldEnd
  return mentions.flatMap(mention => {
    if (mention.end <= start) return [mention]
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    // A boundary insertion/deletion can share the reference's leading @,
    // making the common prefix appear to end inside an unchanged reference.
    if (delta !== 0 && (oldEnd === start || newEnd === start) && mention.start + delta >= 0 &&
      next.slice(mention.start + delta, mention.end + delta) === previous.slice(mention.start, mention.end)) {
      return [{ ...mention, start: mention.start + delta, end: mention.end + delta }]
    }
    return []
  })
}

export function insertDirectoryMention(
  text: string, mentions: readonly DirectoryMention[], query: MentionQuery, directory: KnownDirectory
): { text: string; mentions: readonly DirectoryMention[]; caret: number } {
  // Full paths keep same-named directories distinguishable in the draft too.
  const label = `@${JSON.stringify(directory.path)}`
  const next = text.slice(0, query.start) + label + ' ' + text.slice(query.end)
  const retained = reconcileDirectoryMentions(text, next, mentions)
  return {
    text: next,
    mentions: [...retained, { ...directory, start: query.start, end: query.start + label.length }]
      .sort((a, b) => a.start - b.start),
    caret: query.start + label.length + 1
  }
}

export function directoryMentionParts(text: string, mentions: readonly DirectoryMention[]): AgentInputPart[] {
  const parts: AgentInputPart[] = []
  let cursor = 0
  for (const mention of mentions) {
    if (mention.start < cursor || text.slice(mention.start, mention.end) !== `@${JSON.stringify(mention.path)}`) continue
    const before = text.slice(cursor, mention.start)
    if (before) parts.push({ kind: 'text', text: before })
    parts.push({ kind: 'mention', name: mention.name, path: mention.path, pathType: 'directory' })
    cursor = mention.end
  }
  const after = text.slice(cursor)
  if (after) parts.push({ kind: 'text', text: after })
  // Keep the existing text-only wire format, trimming only the outer draft.
  if (parts[0]?.kind === 'text') parts[0].text = parts[0].text.trimStart()
  const last = parts.at(-1)
  if (last?.kind === 'text') last.text = last.text.trimEnd()
  return parts.filter(part => part.kind !== 'text' || part.text.length > 0)
}
