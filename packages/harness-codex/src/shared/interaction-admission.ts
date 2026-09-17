import { isPublicInteraction } from '@openagent/contracts'
import { toPublicInteraction } from './public-interactions.js'
import { assertCodexInteraction } from './state.js'
import type { CodexInteraction } from './types.js'

/** Per-request policy owned by Codex, independent of retained Thread history. */
export const MAX_CODEX_INTERACTION_JSON_BYTES = 8 * 1024 * 1024

const utf8Encoder = new TextEncoder()

/** Validate both payloads before registering a native request or publishing it. */
export function assertCodexInteractionAdmission(value: unknown): asserts value is CodexInteraction {
  assertCodexInteraction(value)
  // Bound the full private payload before pretty-printing an MCP schema or
  // expanding native identifiers into the public projection.
  assertJsonByteLimit(value, 'private')
  const projected = toPublicInteraction(value)
  if (!isPublicInteraction(projected)) {
    throw new Error('Codex interaction 无法映射为有效的公共交互')
  }
  assertJsonByteLimit(projected, 'public')
}

function assertJsonByteLimit(value: object, payload: 'private' | 'public'): void {
  const json = JSON.stringify(value)
  // UTF-8 cannot be shorter than JSON's UTF-16 length; avoid another large
  // allocation for already oversized ASCII or escaped payloads.
  if (json.length > MAX_CODEX_INTERACTION_JSON_BYTES ||
      utf8Encoder.encode(json).byteLength > MAX_CODEX_INTERACTION_JSON_BYTES) {
    throw new Error(`Codex interaction ${payload} JSON 超过 8 MiB 准入上限`)
  }
}
