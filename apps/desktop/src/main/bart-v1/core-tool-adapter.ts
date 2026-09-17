import {
  MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS,
  type HarnessToolBinding,
  type JsonObject,
  type JsonValue
} from '@openagent/contracts'

export const BART_TOOL_INPUT_MAX_CHARACTERS = 1_000_000

type BartToolHandler = (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>

/** Protocol-only adapter ports. Service owns orchestration and lifecycle authority. */
export interface BartToolHandlers {
  readonly listThreads: BartToolHandler
  readonly startThread: BartToolHandler
  readonly threadStatus: BartToolHandler
  readonly sendThread: BartToolHandler
  readonly setThreadArchived: BartToolHandler
  readonly readThread: BartToolHandler
  readonly interruptThread: BartToolHandler
  readonly respondThread: BartToolHandler
  readonly deleteThread: BartToolHandler
  readonly createReport: BartToolHandler
  readonly listReports: BartToolHandler
  readonly readReport: BartToolHandler
  readonly updateReport: BartToolHandler
  readonly setReportArchived: BartToolHandler
  readonly deleteReport: BartToolHandler
  readonly createSchedule: BartToolHandler
  readonly listSchedules: BartToolHandler
  readonly cancelSchedule: BartToolHandler
}

export function createBartToolBindings(
  threadCreationSchema: JsonObject,
  handlers: BartToolHandlers
): readonly HarnessToolBinding[] {
  const idSchema: JsonObject = {
    type: 'string', minLength: 1, maxLength: 128,
    pattern: '^[^\\s\\u0000]+$'
  }
  const textSchema: JsonObject = {
    type: 'string', minLength: 1, maxLength: BART_TOOL_INPUT_MAX_CHARACTERS, pattern: '\\S'
  }
  const emptySchema: JsonObject = {
    type: 'object', properties: {}, additionalProperties: false
  }
  return [
    tool('openagent_thread_list', 'List compact committed Agent Thread snapshots.',
      emptySchema, (_value, signal) => handlers.listThreads(_value, signal)),
    tool('openagent_thread_start',
      'Create a normal Agent Thread using native Harness settings and dispatch its first task.',
      threadCreationSchema,
      (value, signal) => handlers.startThread(value, signal)),
    tool('openagent_thread_status', 'Read one committed Thread status projection.',
      objectSchema({ threadId: idSchema }, ['threadId']),
      (value, signal) => handlers.threadStatus(value, signal)),
    tool('openagent_thread_send', 'Send a follow-up through the Thread Handle.',
      objectSchema({ threadId: idSchema, prompt: textSchema }, ['threadId', 'prompt']),
      (value, signal) => handlers.sendThread(value, signal)),
    tool('openagent_thread_set_archived', 'Archive or restore an Agent Thread without interrupting existing work.',
      objectSchema({ threadId: idSchema, archived: { type: 'boolean' } }, ['threadId', 'archived']),
      (value, signal) => handlers.setThreadArchived(value, signal)),
    tool('openagent_thread_read',
      'Read a Thread without creating an Execution or mutating its state.',
      objectSchema({ threadId: idSchema, question: textSchema }, ['threadId', 'question']),
      (value, signal) => handlers.readThread(value, signal)),
    tool('openagent_thread_interrupt', 'Interrupt the Thread current Execution.',
      objectSchema({ threadId: idSchema }, ['threadId']),
      (value, signal) => handlers.interruptThread(value, signal)),
    tool('openagent_thread_respond', 'Respond to the Thread current native interaction.',
      objectSchema({
        threadId: idSchema,
        interactionId: idSchema,
        actionId: idSchema,
        answers: {
          type: 'object',
          additionalProperties: {
            anyOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } }
            ]
          }
        },
        message: {
          type: 'string',
          maxLength: MAX_HARNESS_RESPONSE_MESSAGE_CHARACTERS
        }
      }, ['threadId', 'interactionId', 'actionId']),
      (value, signal) => handlers.respondThread(value, signal)),
    tool('openagent_thread_delete',
      'Permanently remove a Thread after interrupting and disposing its Handle.',
      objectSchema({ threadId: idSchema }, ['threadId']),
      (value, signal) => handlers.deleteThread(value, signal)),
    ...reportToolBindings(handlers, idSchema, emptySchema),
    ...scheduleToolBindings(handlers, threadCreationSchema, idSchema, emptySchema)
  ]
}

function tool(
  name: string,
  description: string,
  inputSchema: JsonObject,
  execute: (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>
): HarnessToolBinding {
  return {
    name,
    description,
    inputSchema,
    execute: request => execute(request.arguments, request.signal)
  }
}

function reportToolBindings(
  handlers: BartToolHandlers,
  idSchema: JsonObject,
  emptySchema: JsonObject
): readonly HarnessToolBinding[] {
  const title: JsonObject = { type: 'string', minLength: 1, maxLength: 60, pattern: '\\S' }
  const html: JsonObject = {
    type: 'string', minLength: 1, maxLength: 1_000_000, pattern: '\\S',
    description: 'Raw HTML rendered as a webpage, for example <h2>Summary</h2><p>Details</p>. Pass actual tags, not an entity-escaped document (&lt;h2&gt;), Markdown, or a code fence. Escape entities only inside text or code examples; do not HTML-escape the whole document.'
  }
  const related: JsonObject = { type: 'array', maxItems: 256,
    description: 'Optional explicit completed Execution references. A historical completed Execution remains eligible even after a newer Execution starts. One Execution per Thread.',
    items: objectSchema({ threadId: idSchema, executionId: idSchema }, ['threadId', 'executionId']) }
  return [
    tool('openagent_report_create', 'Create a persistent read-only Report Thread.',
      objectSchema({ title, html, relatedExecutions: related }, ['title', 'html']),
      (value, signal) => handlers.createReport(value, signal)),
    tool('openagent_report_list', 'List Report Thread summaries.', emptySchema,
      (_value, signal) => handlers.listReports(_value, signal)),
    tool('openagent_report_read', 'Read one complete Report Thread.',
      objectSchema({ reportId: idSchema }, ['reportId']),
      (value, signal) => handlers.readReport(value, signal)),
    tool('openagent_report_update', 'Replace supplied Report Thread fields.',
      objectSchema({ reportId: idSchema, title, html, relatedExecutions: related }, ['reportId']),
      (value, signal) => handlers.updateReport(value, signal)),
    tool('openagent_report_set_archived', 'Archive or restore a Report Thread. Archiving also archives linked Agent Threads only when the referenced Execution is still their latest; restoring affects only the Report.',
      objectSchema({ reportId: idSchema, archived: { type: 'boolean' } }, ['reportId', 'archived']),
      (value, signal) => handlers.setReportArchived(value, signal)),
    tool('openagent_report_delete', 'Permanently delete a Report Thread.',
      objectSchema({ reportId: idSchema }, ['reportId']),
      (value, signal) => handlers.deleteReport(value, signal))
  ]
}

function scheduleToolBindings(
  handlers: BartToolHandlers,
  threadCreationSchema: JsonObject,
  idSchema: JsonObject,
  emptySchema: JsonObject
): readonly HarnessToolBinding[] {
  return [
    tool('openagent_schedule_create',
      'Register one immutable future dispatch; no Thread exists before it is due.',
      scheduleThreadCreationSchema(threadCreationSchema),
      (value, signal) => handlers.createSchedule(value, signal)),
    tool('openagent_schedule_list', 'List future pending dispatches.', emptySchema,
      (_value, signal) => handlers.listSchedules(_value, signal)),
    tool('openagent_schedule_cancel', 'Cancel one pending dispatch.',
      objectSchema({ scheduleId: idSchema }, ['scheduleId']),
      (value, signal) => handlers.cancelSchedule(value, signal))
  ]
}

function objectSchema(
  properties: Record<string, JsonObject>,
  required: readonly string[]
): JsonObject {
  return { type: 'object', properties, required: [...required], additionalProperties: false }
}

function scheduleThreadCreationSchema(input: JsonObject): JsonObject {
  const variants = Array.isArray(input.oneOf) ? input.oneOf : []
  const withExecuteAt = (schema: JsonObject): JsonObject => {
    const properties = jsonObject(schema.properties) ? schema.properties : {}
    const required = Array.isArray(schema.required) ? schema.required : []
    return {
      ...schema,
      properties: {
        ...properties,
        executeAt: {
          type: 'string', minLength: 20, maxLength: 40,
          description: 'Future RFC 3339 timestamp with an explicit timezone.'
        }
      },
      required: [...required, 'executeAt']
    }
  }
  return {
    ...withExecuteAt(input),
    oneOf: variants.map(variant => jsonObject(variant) ? withExecuteAt(variant) : variant)
  }
}

function jsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
