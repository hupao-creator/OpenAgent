import {
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
  readonly createReport: BartToolHandler
  readonly listReports: BartToolHandler
  readonly readReport: BartToolHandler
  readonly updateReport: BartToolHandler
  readonly setReportArchived: BartToolHandler
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
    tool('thread_list', 'List compact committed Agent Thread snapshots.',
      emptySchema, (_value, signal) => handlers.listThreads(_value, signal)),
    tool('thread_create',
      'Create a normal Agent Thread using native Harness settings and dispatch its first task.',
      threadCreationSchema,
      (value, signal) => handlers.startThread(value, signal)),
    tool('thread_status', 'Read one committed Thread status projection.',
      objectSchema({ threadId: idSchema }, ['threadId']),
      (value, signal) => handlers.threadStatus(value, signal)),
    tool('thread_send', 'Send a follow-up through the Thread Handle.',
      objectSchema({ threadId: idSchema, prompt: textSchema }, ['threadId', 'prompt']),
      (value, signal) => handlers.sendThread(value, signal)),
    tool('thread_set_archived', 'Archive or restore an Agent Thread without interrupting existing work.',
      objectSchema({ threadId: idSchema, archived: { type: 'boolean' } }, ['threadId', 'archived']),
      (value, signal) => handlers.setThreadArchived(value, signal)),
    tool('thread_read',
      'Read a Thread without creating an Execution or mutating its state.',
      objectSchema({ threadId: idSchema, question: textSchema }, ['threadId', 'question']),
      (value, signal) => handlers.readThread(value, signal)),
    tool('thread_interrupt', 'Interrupt the Thread current Execution.',
      objectSchema({ threadId: idSchema }, ['threadId']),
      (value, signal) => handlers.interruptThread(value, signal)),
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
    // Authoring contract shared by create/update, restored after the Harness migration.
    // Reference: https://github.com/anthropics/claude-plugins-community/blob/main/eli5/skills/eli5/SKILL.md
    description: [
      'Complete HTML document (html/head/body).',
      'Use ELI5 as the sole authoring style: assume the reader knows nothing about the topic and create a visual explanation with big pictures and few words.',
      'Open with a plain-language question or title and a one-sentence mental model, then show an overview visual followed by a small number of numbered steps.',
      'Center each step on one clear claim, one dominant explanatory diagram or chart, and at most a short caption.',
      'Prefer consistent visual vocabulary, arrows, labels, and generous whitespace over long prose, dense card grids, decorative dashboards, or code dumps.',
      'Keep essential facts, numbers, caveats, and sources accurate and visible, but express them as concisely as possible.',
      'Make the document responsive and accessible; use JavaScript only when it directly improves the explanation.',
      'Include the document\'s own CSS and explanatory visuals (for example inline SVG or HTML/CSS diagrams); the isolated report webpage does not inherit the host application\'s styles.',
      'Scripts, styles and network requests run as written; OpenAgent never sanitizes or templates the document.',
      'Pass actual tags, not an entity-escaped document (&lt;h2&gt;), Markdown, or a code fence. Escape entities only inside text or code examples; do not HTML-escape the whole document.'
    ].join(' ')
  }
  const related: JsonObject = { type: 'array', maxItems: 256,
    description: 'Optional explicit completed Execution references. A historical completed Execution remains eligible even after a newer Execution starts. One Execution per Thread.',
    items: objectSchema({ threadId: idSchema, executionId: idSchema }, ['threadId', 'executionId']) }
  return [
    tool('report_create', 'Create a persistent read-only Report Thread.',
      objectSchema({ title, html, relatedExecutions: related }, ['title', 'html']),
      (value, signal) => handlers.createReport(value, signal)),
    tool('report_list', 'List Report Thread summaries.', emptySchema,
      (_value, signal) => handlers.listReports(_value, signal)),
    tool('report_read', 'Read one complete Report Thread.',
      objectSchema({ reportId: idSchema }, ['reportId']),
      (value, signal) => handlers.readReport(value, signal)),
    tool('report_update', 'Replace supplied Report Thread fields.',
      objectSchema({ reportId: idSchema, title, html, relatedExecutions: related }, ['reportId']),
      (value, signal) => handlers.updateReport(value, signal)),
    tool('report_set_archived', 'Archive or restore a Report Thread. Archiving also archives linked Agent Threads only when the referenced Execution is still their latest; restoring affects only the Report.',
      objectSchema({ reportId: idSchema, archived: { type: 'boolean' } }, ['reportId', 'archived']),
      (value, signal) => handlers.setReportArchived(value, signal))
  ]
}

function scheduleToolBindings(
  handlers: BartToolHandlers,
  threadCreationSchema: JsonObject,
  idSchema: JsonObject,
  emptySchema: JsonObject
): readonly HarnessToolBinding[] {
  return [
    tool('schedule_create',
      'Register one immutable future dispatch; no Thread exists before it is due.',
      scheduleThreadCreationSchema(threadCreationSchema),
      (value, signal) => handlers.createSchedule(value, signal)),
    tool('schedule_list', 'List future pending dispatches.', emptySchema,
      (_value, signal) => handlers.listSchedules(_value, signal)),
    tool('schedule_cancel', 'Cancel one pending dispatch.',
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
