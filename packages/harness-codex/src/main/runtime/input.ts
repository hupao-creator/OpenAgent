import type { AgentInput } from '@openagent/contracts'

export type CodexWireInput =
  | { readonly type: 'text'; readonly text: string; readonly text_elements: readonly unknown[] }
  | {
      readonly type: 'image'
      readonly url: string
      readonly detail?: 'auto' | 'low' | 'high' | 'original'
    }
  | {
      readonly type: 'localImage'
      readonly path: string
      readonly detail?: 'auto' | 'low' | 'high' | 'original'
    }
  | { readonly type: 'audio'; readonly url: string }
  | { readonly type: 'localAudio'; readonly path: string }
  | { readonly type: 'skill'; readonly name: string; readonly path: string }
  | { readonly type: 'mention'; readonly name: string; readonly path: string }

export function toCodexWireInput(input: AgentInput): CodexWireInput[] {
  return input.parts.map((part): CodexWireInput => {
    if (part.kind === 'text') {
      return { type: 'text', text: part.text, text_elements: [] }
    }
    if (part.kind === 'mention') return { type: 'mention', name: part.name, path: part.path }
    if (part.kind === 'skill') return { type: 'skill', name: part.name, path: part.path }
    if (part.kind === 'image') {
      return optional(
        { type: 'localImage' as const, path: part.file.path },
        'detail',
        part.detail
      )
    }
    if (part.kind === 'image-url') {
      return optional({ type: 'image' as const, url: part.url }, 'detail', part.detail)
    }
    if (part.kind === 'audio') return { type: 'localAudio', path: part.file.path }
    if (part.kind === 'audio-url') return { type: 'audio', url: part.url }
    return { type: 'mention', name: part.file.name, path: part.file.path }
  })
}

function optional<Base extends object, Key extends string, Value>(
  base: Base,
  key: Key,
  value: Value | undefined
): Base & Partial<Record<Key, Value>> {
  return value === undefined ? base : { ...base, [key]: value }
}
