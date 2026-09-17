import { z } from 'zod'
import { isJsonValue } from './agent-core/values.js'
import type { DeepReadonly } from './harness-plugin.js'

/** String limits use UTF-16 code units, matching JavaScript string.length. */
export const MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS = 20_000

export const PUBLIC_OBSERVATION_LIMITS = Object.freeze({
  identifier: 128,
  summary: 100_000,
  error: 100_000,
  title: 2_000,
  description: 20_000,
  actionLabel: 2_000,
  prompt: MAX_PUBLIC_INTERACTION_PROMPT_CHARACTERS,
  header: 2_000,
  optionValue: 2_000,
  optionLabel: 2_000,
  optionDescription: 10_000
})


// Preserve the boundary's UTF-16 limits independently of Zod string-length semantics.
const text = (maximum: number, allowEmpty = true) => z.string().refine(value =>
  value.length <= maximum && !value.includes('\0') && (allowEmpty || Boolean(value.trim())))
const identifier = z.string().refine(value => value.length <= PUBLIC_OBSERVATION_LIMITS.identifier &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
const unique = <T>(items: readonly T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length
// JSON guard runs first: no getters, non-JSON prototypes, cycles, undefined or sparse arrays.
const json = z.custom<unknown>(isJsonValue, 'Thread public observation 必须是对象')
export const PublicInteractionActionSchema = z.strictObject({
  id: identifier, intent: z.enum(['allow', 'deny', 'submit', 'cancel']),
  label: text(PUBLIC_OBSERVATION_LIMITS.actionLabel, false)
}, { error: 'Public interaction action 包含未知字段' })
export const PublicInteractionOptionSchema = z.strictObject({
  value: text(PUBLIC_OBSERVATION_LIMITS.optionValue, false),
  label: text(PUBLIC_OBSERVATION_LIMITS.optionLabel, false),
  description: text(PUBLIC_OBSERVATION_LIMITS.optionDescription).optional()
}, { error: 'Public interaction question option 包含未知字段' })
export const PublicInteractionQuestionSchema = z.strictObject({
  id: identifier, prompt: text(PUBLIC_OBSERVATION_LIMITS.prompt, false),
  header: text(PUBLIC_OBSERVATION_LIMITS.header).optional(),
  multiple: z.boolean(), allowOther: z.boolean(), secret: z.boolean(),
  options: z.array(PublicInteractionOptionSchema).refine(items => unique(items, item => item.value))
}, { error: 'Public interaction question 包含未知字段' })
export const PublicInteractionSchema = json.pipe(z.strictObject({
  id: identifier, kind: z.enum(['permission', 'question']),
  title: text(PUBLIC_OBSERVATION_LIMITS.title, false),
  description: text(PUBLIC_OBSERVATION_LIMITS.description).optional(),
  actions: z.array(PublicInteractionActionSchema).min(1).refine(items => unique(items, item => item.id)),
  questions: z.array(PublicInteractionQuestionSchema).refine(items => unique(items, item => item.id))
}, { error: 'Public interaction 包含未知字段' }))
const executionBase = {
  executionId: identifier, startedAt: z.number().nonnegative(),
  summary: text(PUBLIC_OBSERVATION_LIMITS.summary).optional()
}
export const PublicExecutionSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...executionBase, status: z.literal('running') }),
  z.strictObject({ ...executionBase, status: z.literal('waiting-for-user'),
    interactions: z.array(PublicInteractionSchema).min(1, 'waiting-for-user interactions 必须是非空数组').refine(items => unique(items, item => item.id), 'waiting-for-user interaction ID 重复') }, { error: 'waiting-for-user 不得携带 terminal 字段' }),
  z.strictObject({ ...executionBase, status: z.enum(['completed', 'interrupted']), finishedAt: z.number() }, { error: 'Public terminal execution 字段无效' }),
  z.strictObject({ ...executionBase, status: z.literal('failed'), finishedAt: z.number(),
    error: text(PUBLIC_OBSERVATION_LIMITS.error).optional() })
]).refine(value => !('finishedAt' in value) || value.finishedAt >= value.startedAt)
export const PublicBackgroundWorkSchema = z.strictObject({ status: z.literal('running') })
export const ThreadPublicObservationSchema = json.pipe(z.strictObject({
  latestExecution: PublicExecutionSchema.nullable(), backgroundWork: PublicBackgroundWorkSchema.nullable()
}))
export type PublicInteractionAction = DeepReadonly<z.infer<typeof PublicInteractionActionSchema>>
export type PublicInteractionOption = DeepReadonly<z.infer<typeof PublicInteractionOptionSchema>>
export type PublicInteractionQuestion = DeepReadonly<z.infer<typeof PublicInteractionQuestionSchema>>
export type PublicInteraction = DeepReadonly<z.infer<typeof PublicInteractionSchema>>
export type PublicExecution = DeepReadonly<z.infer<typeof PublicExecutionSchema>>
export type PublicBackgroundWork = DeepReadonly<z.infer<typeof PublicBackgroundWorkSchema>>
export type ThreadPublicObservation = DeepReadonly<z.infer<typeof ThreadPublicObservationSchema>>

/** Validate and detach the boundary value from Plugin state. */
export function parseThreadPublicObservation(value: unknown): ThreadPublicObservation {
  return ThreadPublicObservationSchema.parse(value)
}
export function isThreadPublicObservation(value: unknown): value is ThreadPublicObservation {
  return ThreadPublicObservationSchema.safeParse(value).success
}
export function isPublicInteraction(value: unknown): value is PublicInteraction {
  return PublicInteractionSchema.safeParse(value).success
}
