import { z } from 'zod'
import type { DeepReadonly } from './harness-plugin.js'
import { isJsonObject, isJsonValue, type JsonObject, type JsonValue } from './agent-core/values.js'
import { PublicResponseAnswersSchema, PublicResponseMessageSchema } from './public-response.js'

/** Command strings count UTF-16 code units, matching String.length (not code points). */
export function commandString(field: string, max: number, allowEmpty = false) {
  return z.string({ error: `无效字段：${field}` }).refine(value =>
    (allowEmpty || value.length > 0) && value.length <= max && !value.includes('\0'),
  `无效字段：${field}`)
}

export const CommandRecordSchema = z.custom<Record<string, unknown>>(value =>
  typeof value === 'object' && value !== null && !Array.isArray(value))

/**
 * The transport historically checks enumerable own unknown keys and own required
 * keys. Zod's ordinary optional/unknown fields do not express those presence rules.
 */
export function commandObjectKeys(keys: readonly string[], label: string, requiredKeys = keys) {
  return CommandRecordSchema.superRefine((value, context) => {
    const unexpected = Object.keys(value).filter(key => !keys.includes(key))
    if (unexpected.length) {
      context.addIssue({ code: 'custom', message: `${label}包含未支持字段：${unexpected.join(', ')}` })
      return
    }
    const missing = requiredKeys.filter(key => !Object.hasOwn(value, key))
    if (missing.length) context.addIssue({ code: 'custom', message: `${label}缺少字段：${missing.join(', ')}` })
  })
}

function closedObject<S extends z.ZodRawShape>(shape: S, label: string, requiredKeys = Object.keys(shape)) {
  // The guard rejects unknown own keys before object parsing; this deliberately
  // keeps inherited/non-enumerable handling identical to the existing boundary.
  return commandObjectKeys(Object.keys(shape), label, requiredKeys).pipe(z.object(shape))
}

/** Unlike opaque JSON, these transport arrays historically preserve sparse holes. */
function commandArray<S extends z.ZodType>(schema: S, min: number, max: number, message: string) {
  return z.custom<unknown[]>(Array.isArray, message)
    .refine(value => value.length >= min && value.length <= max, message)
    .transform((value, context): z.output<S>[] => value.map((item, index) => {
      const result = schema.safeParse(item)
      if (result.success) return result.data
      for (const issue of result.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: [index, ...issue.path] })
      }
      return z.NEVER
    }))
}

/** Serialized limits count UTF-8 bytes, including JSON escaping and envelope keys. */
export function commandJsonSize(max: number, field: string) {
  return z.unknown().superRefine((value, context) => {
    let serialized: string | undefined
    try { serialized = JSON.stringify(value) } catch { /* report below */ }
    if (typeof serialized !== 'string') {
      context.addIssue({ code: 'custom', message: `字段无法序列化：${field}` })
    } else if (new TextEncoder().encode(serialized).byteLength > max) {
      context.addIssue({ code: 'custom', message: `字段过大：${field}` })
    }
  })
}

function opaqueJson(max: number, field: string, message: string) {
  return z.custom<JsonValue>(isJsonValue, message)
    .refine(value => commandJsonSize(max, field).safeParse(value).success, `字段过大：${field}`)
    .transform(value => structuredClone(value))
}

const threadId = commandString('threadId', 128)
const harnessId = z.string({ error: '未知 Harness ID' })
const imageDetail = z.enum(['auto', 'low', 'high', 'original'], { error: 'Image detail 无效' }).optional()
const localFile = closedObject({
  id: commandString('file.id', 128), path: commandString('file.path', 4096),
  name: commandString('file.name', 1024), mimeType: commandString('file.mimeType', 256),
  size: z.number({ error: 'file.size 无效' }).refine(value =>
    Number.isSafeInteger(value) && value >= 0 && value <= 100 * 1024 * 1024, 'file.size 无效')
}, 'Agent input file')
const mediaUrl = commandString('url', 4_000_000).transform((value, context) => {
  try {
    const url = new URL(value)
    if (['http:', 'https:', 'data:'].includes(url.protocol)) return url.toString()
  } catch { /* invalid URL follows the same rejection path */ }
  context.addIssue({ code: 'custom', message: 'Agent input url 协议无效' })
  return z.NEVER
})
const partSchemas = {
  text: closedObject({ kind: z.literal('text'), text: commandString('text', 1_000_000, true) }, 'Agent input part'),
  'local-file': closedObject({ kind: z.literal('local-file'), file: localFile }, 'Agent input part'),
  image: closedObject({ kind: z.literal('image'), file: localFile, detail: imageDetail }, 'Agent input part', []),
  'image-url': closedObject({ kind: z.literal('image-url'), url: mediaUrl, detail: imageDetail }, 'Agent input part', []),
  audio: closedObject({ kind: z.literal('audio'), file: localFile }, 'Agent input part'),
  'audio-url': closedObject({ kind: z.literal('audio-url'), url: mediaUrl }, 'Agent input part'),
  mention: closedObject({ kind: z.literal('mention'), name: commandString('name', 1024), path: commandString('path', 4096) }, 'Agent input part'),
  skill: closedObject({ kind: z.literal('skill'), name: commandString('name', 1024), path: commandString('path', 4096) }, 'Agent input part')
}
// Dispatch preserves the relevant variant's field error instead of exposing a Zod union error tree.
export const PublicAgentInputPartSchema = z.unknown().transform((value, context) => {
  const kind = CommandRecordSchema.safeParse(value).data?.kind
  if (typeof kind !== 'string' || !Object.hasOwn(partSchemas, kind)) {
    context.addIssue({ code: 'custom', message: 'Agent input part kind 无效' })
    return z.NEVER
  }
  const result = partSchemas[kind as keyof typeof partSchemas].safeParse(value)
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
    return z.NEVER
  }
  const part = result.data
  if ('detail' in part && part.detail === undefined) delete part.detail
  return part
})

export const PublicAgentInputSchema = commandJsonSize(8 * 1024 * 1024, 'input').pipe(closedObject({
  parts: commandArray(PublicAgentInputPartSchema, 1, 128, 'Agent input parts 数量必须在 1 到 128 之间'),
  presentation: z.literal('visible', { error: 'Agent input presentation 无效' }).optional()
}, 'Agent input', [])).refine(input => input.parts.some(part =>
  part.kind !== 'text' || Boolean(part.text.trim())), '消息不能为空')
  .transform(input => ({ parts: input.parts, ...(input.presentation === undefined ? {} : { presentation: input.presentation }) }))

const trimmedString = (field: string, max: number) => commandString(field, max)
  .transform(value => value.trim()).refine(value => value.length > 0, `无效字段：${field}`)

export const BartSubmitRequestSchema = closedObject({
  input: PublicAgentInputSchema, directoryTag: trimmedString('directoryTag', 256).optional()
}, 'Bart submit 请求', []).transform(value => ({
  input: value.input, ...(value.directoryTag === undefined ? {} : { directoryTag: value.directoryTag })
}))
export type BartSubmitRequest = Readonly<z.output<typeof BartSubmitRequestSchema>>
export const FollowUpThreadRequestSchema = closedObject({ threadId, input: PublicAgentInputSchema }, 'Thread follow-up 请求')
export type FollowUpThreadRequest = Readonly<z.output<typeof FollowUpThreadRequestSchema>>
export const ThreadInteractionResponseSchema = closedObject({
  threadId, interactionId: commandString('interactionId', 128), actionId: commandString('actionId', 128),
  answers: z.custom<JsonObject>(isJsonObject, 'answers 必须是 object')
    .refine(value => commandJsonSize(1_000_000, 'answers').safeParse(value).success, '字段过大：answers')
    .pipe(PublicResponseAnswersSchema).optional(),
  message: PublicResponseMessageSchema
}, 'Thread interaction 回复', []).transform(value => ({
  threadId: value.threadId, interactionId: value.interactionId, actionId: value.actionId,
  ...(value.answers === undefined ? {} : { answers: value.answers }),
  ...(value.message === undefined ? {} : { message: value.message })
}))
// read 的对象是普通 Agent Thread；Bart Thread 不是合法对象，Core 显式拒绝。
export const ReadThreadRequestSchema = closedObject({ threadId, question: trimmedString('question', 1_000_000) }, 'Thread read 请求')
export const ForkThreadRequestSchema = closedObject({
  threadId, request: opaqueJson(8 * 1024 * 1024, 'request', 'Thread fork request 必须是 JSON')
}, 'Thread fork 请求')
export type ForkThreadRequest = Readonly<z.infer<typeof ForkThreadRequestSchema>>
export const UpdateThreadSettingsRequestSchema = closedObject({
  harnessId, threadId,
  change: z.custom<JsonObject>(isJsonObject, 'Thread settings change 必须是 JSON object')
    .refine(value => commandJsonSize(1_000_000, 'change').safeParse(value).success, '字段过大：change')
    .transform(value => structuredClone(value))
}, 'Thread settings 请求')
export type UpdateThreadSettingsRequest = Readonly<z.infer<typeof UpdateThreadSettingsRequestSchema>>
export const HarnessExtensionRequestSchema = closedObject({
  harnessId,
  method: commandString('method', 128).refine(value => value.trim() === value, '无效字段：method'),
  // Accommodates native 5,000,000-byte payloads plus method/path metadata.
  payload: opaqueJson(8 * 1024 * 1024, 'payload', 'Harness extension payload 必须是 JSON')
}, 'Harness extension 请求')
export type HarnessExtensionRequest = Readonly<z.infer<typeof HarnessExtensionRequestSchema>>
/** A reader-initiated reload, which must not be answered from a cache. */
const presentationRefresh = z.boolean().optional()
const globalPresentation = closedObject(
  { scope: z.literal('global'), harnessId, refresh: presentationRefresh },
  'Harness settings presentation 请求',
  ['scope', 'harnessId']
)
const threadPresentation = closedObject(
  { scope: z.literal('thread'), threadId, refresh: presentationRefresh },
  'Harness settings presentation 请求',
  ['scope', 'threadId']
)
export const HarnessSettingsPresentationRequestSchema = z.unknown().transform((value, context) => {
  const scope = CommandRecordSchema.safeParse(value).data?.scope
  const schema = scope === 'global' ? globalPresentation : scope === 'thread' ? threadPresentation : undefined
  if (!schema) {
    context.addIssue({ code: 'custom', message: 'Harness settings presentation scope 无效' })
    return z.NEVER
  }
  const result = schema.safeParse(value)
  if (result.success) return result.data
  for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  return z.NEVER
})
export type HarnessSettingsPresentationRequest = Readonly<z.infer<typeof HarnessSettingsPresentationRequestSchema>>
export const OpenAgentUiStateUpdateSchema = z.preprocess(value =>
  CommandRecordSchema.safeParse(value).success && !Object.hasOwn(value as object, 'selectedThreadId')
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>)) : value, closedObject({
  selectedThreadId: commandString('selectedThreadId', 128).nullable().optional()
}, '界面状态', [])).superRefine((value, context) => {
  if (Object.hasOwn(value, 'selectedThreadId') && value.selectedThreadId === undefined) {
    context.addIssue({ code: 'custom', message: '无效字段：selectedThreadId' })
  }
})
export type OpenAgentUiStateUpdate = Readonly<z.infer<typeof OpenAgentUiStateUpdateSchema>>

const attachmentDisplayName = z.union([commandString('displayName', 1024, true), z.null(), z.undefined()])
  .transform(value => value || '附件')
const pathImport = closedObject({
  source: z.literal('path'), path: commandString('attachment.path', 4096), displayName: attachmentDisplayName
}, '路径附件导入')
const bytesImport = closedObject({
  source: z.literal('bytes'), bytes: z.instanceof(ArrayBuffer, { error: '附件内容缺失' })
    .refine(value => value.byteLength <= 20 * 1024 * 1024, '无路径的粘贴内容不能超过 20 MB'),
  displayName: attachmentDisplayName
}, '字节附件导入')
export const BartAttachmentImportSchema = z.unknown().transform((value, context) => {
  const source = CommandRecordSchema.safeParse(value).data?.source
  const schema = source === 'path' ? pathImport : source === 'bytes' ? bytesImport : undefined
  if (!schema) {
    context.addIssue({ code: 'custom', message: '无效的附件导入来源' })
    return z.NEVER
  }
  const result = schema.safeParse(value)
  if (result.success) return result.data
  for (const issue of result.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path })
  return z.NEVER
})
export type BartAttachmentImport = Readonly<z.infer<typeof BartAttachmentImportSchema>>
export const BartAttachmentImportsSchema = z.preprocess(value => value == null ? [] : value,
  commandArray(BartAttachmentImportSchema, 0, 20, '附件数量不能超过 20 个'))
export const CommandThreadIdSchema = threadId
export const CommandReportIdSchema = commandString('reportId', 128)
export const CommandArchivedSchema = z.boolean({ error: 'archived 必须是布尔值' })
export const ExternalUrlSchema = z.string({ error: '无效链接' }).transform((value, context) => {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString()
  } catch { /* report a public error rather than Zod internals */ }
  context.addIssue({ code: 'custom', message: '仅允许打开 HTTP(S) 链接' })
  return z.NEVER
})

/** Do not expose Zod's error tree as a new transport protocol. */
export function parseCommand<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const message = issue?.message
    throw new Error(message?.startsWith('Invalid ') ? `无效字段：${issue.path.join('.') || '请求'}` : message ?? '请求无效')
  }
  return result.data
}

export const OPENAGENT_APPEARANCES = ['system', 'light', 'dark'] as const
export const OPENAGENT_LOCALES = ['zh-CN', 'en-US'] as const
export const MAX_BART_ROUTING_GUIDANCE_LENGTH = 12_000
export function normalizeBartRoutingGuidance(value: string | null): string | null {
  return value?.trim() || null
}

export function bartRoutingGuidanceError(value: string | null, locale: 'zh-CN' | 'en-US'): string | undefined {
  const length = normalizeBartRoutingGuidance(value)?.length ?? 0
  if (length <= MAX_BART_ROUTING_GUIDANCE_LENGTH) return undefined
  return locale === 'en-US'
    ? `Model routing guidance must be at most ${MAX_BART_ROUTING_GUIDANCE_LENGTH} UTF-16 code units; current length: ${length}.`
    : `模型路由指导最多 ${MAX_BART_ROUTING_GUIDANCE_LENGTH} 个字符（UTF-16 计数），当前 ${length} 个。`
}

/** Only the application shell is interpreted; each Harness slice stays opaque JSON. */
export const OpenAgentSettingsShellSchema = closedObject({
  locale: z.enum(OPENAGENT_LOCALES, { error: 'OpenAgent locale 无效' }),
  appearance: z.enum(OPENAGENT_APPEARANCES, { error: 'OpenAgent appearance 无效' }),
  bart: closedObject({
    hostHarnessPreference: z.string({ error: 'OpenAgent Bart Host Harness preference 无效' }),
    targetHarnessIds: commandArray(z.string({ error: 'OpenAgent Bart Target Harness 集合无效' }), 0, Infinity, 'OpenAgent Bart Target Harness 集合无效')
      .refine(value => new Set(value).size === value.length, 'OpenAgent Bart Target Harness 集合无效').readonly(),
    autoIntervention: z.boolean({ error: 'OpenAgent Bart autoIntervention 无效' }),
    // Settings guidance historically permits embedded NUL; its own rule uses UTF-16 length.
    routingGuidance: z.string().nullable().transform(normalizeBartRoutingGuidance)
  }, 'OpenAgent Bart settings'),
  harnesses: CommandRecordSchema.superRefine((value, context) => {
    for (const [harnessId, settings] of Object.entries(value)) {
      if (!isJsonObject(settings)) context.addIssue({
        code: 'custom', path: [harnessId],
        message: `${harnessId} Harness settings 必须是 JSON object`
      })
    }
  }).transform(value => value as Record<string, JsonObject>)
}, 'OpenAgent settings').superRefine((settings, context) => {
  const message = bartRoutingGuidanceError(settings.bart.routingGuidance, settings.locale)
  if (message) context.addIssue({ code: 'custom', path: ['bart', 'routingGuidance'], message })
})
export type OpenAgentSettings = z.infer<typeof OpenAgentSettingsShellSchema>

// Public callers may supply immutable answer arrays; parsing still returns copies.
export type ThreadInteractionResponseRequest = DeepReadonly<z.infer<typeof ThreadInteractionResponseSchema>>
export type ReadThreadRequest = Readonly<z.infer<typeof ReadThreadRequestSchema>>
