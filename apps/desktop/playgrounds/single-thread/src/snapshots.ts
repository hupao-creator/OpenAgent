import { z } from 'zod'
import { isJsonValue, ThreadPublicObservationSchema } from '@openagent/contracts'
import { OpenAgentSettingsSchema } from '../../../src/shared/openagent-settings'
import type { RendererAppState } from '../../../src/shared/renderer-state-contracts'

const json = z.custom(isJsonValue, '必须是 JSON 数据')
const thread = z.object({
  id: z.string().min(1), harnessId: z.string().min(1), revision: z.number().int().nonnegative(),
  sessionState: json, observation: ThreadPublicObservationSchema,
  title: z.string(), tags: z.array(z.string()), cwd: z.string(), settings: json,
  createdAt: z.number().finite(), updatedAt: z.number().finite(),
  archived: z.boolean().optional(), bart: z.literal(true).optional(), transcript: z.array(json).optional()
}).passthrough().superRefine((value, ctx) => {
  if (!value.bart && typeof value.archived !== 'boolean') ctx.addIssue({ code: 'custom', message: 'Agent Thread 缺少 archived' })
  if (value.bart && !value.transcript) ctx.addIssue({ code: 'custom', message: 'Bart 缺少 transcript' })
})
const report = z.object({
  id: z.string().min(1), title: z.string(), tags: z.array(z.string()),
  relatedExecutions: z.array(z.object({ threadId: z.string(), executionId: z.string() }).strict()), createdAt: z.number().finite(), updatedAt: z.number().finite(),
  archived: z.boolean(), previewText: z.string()
}).strict()
const snapshot = z.object({
  revision: z.number().int().nonnegative(), defaultCwd: z.string(), threads: z.array(thread),
  executions: z.array(z.object({ threadId: z.string(), executionId: z.string(), status: z.literal('running'), startedAt: z.number() })),
  reports: z.array(report), selectedThreadId: z.string().nullable(), settings: OpenAgentSettingsSchema
}).strict()

/** Validate the public envelope without decoding or rebuilding Harness-owned state. */
export function parseSnapshot(value: unknown): RendererAppState {
  snapshot.parse(value)
  // Return the exact supplied state, not schema defaults or transformed settings.
  return freezeSnapshot(value as RendererAppState)
}

function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeSnapshot(child)
  }
  return value
}
