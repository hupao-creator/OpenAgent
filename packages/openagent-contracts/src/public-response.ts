import { z } from 'zod'
import { isJsonValue } from './agent-core/values.js'
import { MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS } from './harness-plugin.js'

const nonblank = z.string().refine(value => Boolean(value.trim()))
const responseAnswer = z.union([z.string(), z.array(z.string())])
/** JSON-representable public wire structure; runtime normalization stays below. */
export const HarnessRespondRequestShapeSchema = z.strictObject({
  interactionId: z.string(),
  actionId: z.string(),
  answers: z.record(z.string(), responseAnswer).optional(),
  /** Opaque feedback; the target Plugin owns action semantics. */
  message: z.string().optional()
}, { error: 'Agent interaction response 包含未知字段' })
export type HarnessRespondRequest = Readonly<z.infer<typeof HarnessRespondRequestShapeSchema>>
const responseAnswerEntries = z.array(z.tuple([nonblank, responseAnswer]))
// Validate entries rather than z.record: literal __proto__ keys must also be checked.
export const PublicResponseAnswersSchema = z.custom<Record<string, z.infer<typeof responseAnswer>>>(
  value => isJsonValue(value) && typeof value === 'object' && value !== null && !Array.isArray(value) &&
    responseAnswerEntries.safeParse(Object.entries(value)).success,
  'answers 必须为 object，且值为字符串或字符串数组'
).transform(value => structuredClone(value))
export const PublicResponseMessageSchema = z.string().refine(value =>
  value.length <= MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS && !value.includes('\0'), 'Agent interaction response message 无效')
  .transform(value => value === '' ? undefined : value).optional()
export const HarnessRespondRequestSchema = z.custom<unknown>(isJsonValue, 'Agent interaction response 必须是对象').pipe(HarnessRespondRequestShapeSchema.extend({
  interactionId: nonblank, actionId: nonblank,
  answers: PublicResponseAnswersSchema.optional(), message: PublicResponseMessageSchema
}))
/** Structural validation only; pending interaction/action authorization remains in Core. */
export function parseHarnessRespondRequest(value: unknown): HarnessRespondRequest {
  const result = HarnessRespondRequestSchema.parse(value)
  return { interactionId: result.interactionId, actionId: result.actionId,
    ...(result.answers === undefined ? {} : { answers: result.answers }),
    ...(result.message === undefined ? {} : { message: result.message }) }
}
