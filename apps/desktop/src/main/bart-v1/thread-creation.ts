import type { JsonObject, JsonValue } from '@openagent/contracts'
import { isHarnessId, type HarnessId } from '../../shared/harnesses'
import { cloneBoundedJsonObject } from './json'

export const THREAD_CREATION_LIMITS = {
  schemaBytes: 64 * 1024,
  optionsBytes: 64 * 1024,
  promptCharacters: 1_000_000,
  cwdCharacters: 4_096
} as const

/** A settings description only: native validation stays in resolveThreadSettings. */
export interface ThreadSettingsDescriptionSource<Id extends string> {
  readonly id: Id
  readonly displayName: string
  describe(input: { readonly cwd: string; readonly signal: AbortSignal }): Promise<JsonObject>
}

export type ThreadSettingsDescriptionComposition = Readonly<
  Record<string, ThreadSettingsDescriptionSource<string>>
>

export interface ThreadCreationDescription {
  readonly instructions: string
  readonly inputSchema: JsonObject
  readonly targetHarnessIds: readonly HarnessId[]
}

export interface ThreadCreationRequest {
  readonly prompt: string
  readonly cwd?: string
  readonly worktree?: boolean
  readonly harnessId: HarnessId
  readonly options: JsonObject
}

/** Settings discovery failed; an already-open Handle may keep its schema. */
export class ThreadSettingsRefreshUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ThreadSettingsRefreshUnavailableError'
  }
}

export async function describeThreadCreation(input: {
  readonly composition: ThreadSettingsDescriptionComposition
  readonly targetHarnessIds: readonly HarnessId[]
  readonly cwd: string
  readonly signal: AbortSignal
}): Promise<ThreadCreationDescription> {
  input.signal.throwIfAborted()
  if (!input.targetHarnessIds.length) throw new Error('Bart 至少需要一个 Target Harness')
  if (new Set(input.targetHarnessIds).size !== input.targetHarnessIds.length) {
    throw new Error('Bart Target Harness 不能重复')
  }
  const settled = await Promise.allSettled(input.targetHarnessIds.map(async harnessId => {
    const source = input.composition[harnessId]
    if (!source || source.id !== harnessId) {
      throw new Error(`Harness settings key ${harnessId} does not match its source`)
    }
    const described = await source.describe({ cwd: input.cwd, signal: input.signal })
    input.signal.throwIfAborted()
    const optionsSchema = cloneBoundedJsonObject(
      described, `${harnessId} settings schema`, THREAD_CREATION_LIMITS.schemaBytes
    )
    if (optionsSchema.type !== 'object') throw new Error('Harness settings schema must describe an object')
    return {
      harnessId,
      displayName: source.displayName,
      optionsSchema,
      instructions: 'Use the creation options in this Harness options schema. Omitted fields use the configured Thread defaults.'
    }
  }))
  input.signal.throwIfAborted()
  const failures = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  // Invalid Plugin schemas must fail even if another source is unavailable.
  // Only acquisition failures can reuse an already-installed generation.
  const failed = failures.find(result => !(result.reason instanceof ThreadSettingsRefreshUnavailableError)) ?? failures[0]
  if (failed) throw failed.reason
  const descriptions = settled.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  const promptSchema: JsonObject = {
    type: 'string',
    minLength: 1,
    maxLength: THREAD_CREATION_LIMITS.promptCharacters,
    pattern: '\\S',
    description: 'A self-contained first task with all necessary context and expected results.'
  }
  const cwdSchema: JsonObject = {
    type: 'string',
    minLength: 1,
    maxLength: THREAD_CREATION_LIMITS.cwdCharacters,
    description: `An existing absolute execution directory required by the task. Omit for an isolated temporary workspace. Do not use the Bart workspace ${input.cwd}.`
  }
  const worktreeSchema: JsonObject = {
    type: 'boolean',
    description: 'Create an isolated Git worktree from cwd. Requires an explicit Git workspace cwd.'
  }
  const variants: JsonValue[] = descriptions.map((description) => ({
    type: 'object',
    properties: {
      prompt: promptSchema,
      cwd: cwdSchema,
      worktree: worktreeSchema,
      harnessId: {
        type: 'string',
        const: description.harnessId
      },
      options: description.optionsSchema
    },
    required: ['prompt', 'harnessId', 'options'],
    additionalProperties: false
  }))

  return {
    instructions: descriptions
      .map((description) => `## ${description.displayName} (${description.harnessId})\n${description.instructions}`)
      .join('\n\n'),
    inputSchema: {
      // MCP requires an object root. Declare its fields as well: native tool
      // adapters can close the root with additionalProperties: false.
      type: 'object',
      properties: {
        prompt: promptSchema,
        cwd: cwdSchema,
        worktree: worktreeSchema,
        harnessId: { type: 'string', enum: descriptions.map(description => description.harnessId) },
        options: { type: 'object' }
      },
      required: ['prompt', 'harnessId', 'options'],
      additionalProperties: false,
      oneOf: variants
    },
    targetHarnessIds: descriptions.map((description) => description.harnessId)
  }
}

export function parseThreadCreationRequest(
  value: JsonValue
): ThreadCreationRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const allowed = new Set(['prompt', 'cwd', 'worktree', 'harnessId', 'options'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return null

  if (typeof value.prompt !== 'string') return null
  const prompt = value.prompt.trim()
  if (!prompt || prompt.length > THREAD_CREATION_LIMITS.promptCharacters) return null
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return null
  const cwd = typeof value.cwd === 'string' ? value.cwd.trim() : undefined
  if (
    value.cwd !== undefined &&
    (!cwd || cwd.length > THREAD_CREATION_LIMITS.cwdCharacters)
  ) return null
  if (value.worktree !== undefined && typeof value.worktree !== 'boolean') return null
  if (value.worktree === true && cwd === undefined) return null
  if (!isHarnessId(value.harnessId) || value.options === undefined) return null

  let options: JsonObject
  try {
    options = cloneBoundedJsonObject(
      value.options,
      `${value.harnessId} Thread settings`,
      THREAD_CREATION_LIMITS.optionsBytes
    )
  } catch {
    return null
  }
  return {
    prompt,
    ...(cwd === undefined ? {} : { cwd }),
    ...(value.worktree === undefined ? {} : { worktree: value.worktree }),
    harnessId: value.harnessId,
    options
  }
}
