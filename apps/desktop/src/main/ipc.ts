import { COMMAND_CHANNELS, createChannelHandlers, type ChannelHandler } from './command-router'
import { parseObject, requiredString, isRecord, boundedString } from './request-validation'
import { basename } from 'node:path'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainInvokeEvent
} from 'electron'
import { isHarnessId } from '../shared/harnesses'
import {
  DIAGNOSTIC_IPC_CHANNEL,
  DIAGNOSTIC_MODE_CHANNEL,
  isRendererDiagnosticEvent,
  type DiagnosticIpcEnvelope,
  type DiagnosticTraceContext,
  type RendererDiagnostic
} from '../shared/diagnostic-tracing'
import type { OpenAgentService } from './openagent-service'
import {
  ReportRuntimeHost,
  type ReportRuntimeBounds
} from './report-runtime'
import type { AttachmentRepository } from './services/attachment-repository'
import {
  debugDetail,
  debugError,
  debugLog,
  getDebugContext,
  getDebugLogMode,
  startDebugSpan,
  withDebugContext,
  type DebugContext
} from '@openagent/plugin-kit/main'

let removeServiceListeners: Array<() => void> = []
let reportRuntimeHost: ReportRuntimeHost | null = null

/** GUI-only channels require a real BrowserWindow. */
const GUI_IPC_CHANNELS = [
  'dialog:choose-files',
  'report:open',
  'report:set-bounds',
  'report:close'
] as const

/** Renderer diagnostics are intentionally separate from the public command set. */
const RENDERER_DIAGNOSTICS_MAX_TEXT = 16_000
const RENDERER_DIAGNOSTICS_MAX_ID = 128
const RENDERER_DIAGNOSTICS_MAX_SOURCE = 512
const RENDERER_DIAGNOSTIC_CONTEXT_KEYS = [
  'traceId',
  'spanId',
  'parentSpanId',
  'threadId',
  'executionId',
  'nativeSessionId',
  'harnessId'
] as const

export interface IpcRuntimeServices {
  readonly attachmentStore: AttachmentRepository
}

export function registerIpc(
  window: BrowserWindow,
  service: OpenAgentService,
  defaultCwd: string,
  runtimeServices: IpcRuntimeServices
): void {
  const trusted = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== window.webContents) {
      throw new Error('拒绝来自未知 renderer 的 IPC 请求')
    }
  }
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
  const handlers = createChannelHandlers(service, {
    attachmentStore: runtimeServices.attachmentStore,
    openExternal: url => shell.openExternal(url)
  })
  const reportRuntime = new ReportRuntimeHost(
    window,
    (failure) => send('report:failed', failure)
  )
  reportRuntimeHost = reportRuntime

  removeServiceListeners = [
    service.onStateMutation((mutation) => send('state:mutation', mutation))
  ]

  for (const [channel, handler] of Object.entries(handlers)) {
    registerIpcHandler(channel, trusted, handler)
  }

  registerIpcHandler(
    'report:open',
    trusted,
    async (rawReportId: unknown, rawBounds: unknown) => {
      const report = service.readReport(
        requiredString(rawReportId, 'reportId', 128)
      )
      await reportRuntime.open(
        { id: report.id, html: report.html },
        parseReportBounds(rawBounds)
      )
    }
  )

  registerIpcHandler('report:set-bounds', trusted, (rawBounds: unknown) => {
    reportRuntime.setBounds(parseReportBounds(rawBounds))
  })

  registerIpcHandler('report:close', trusted, () => {
    reportRuntime.close()
  })

  registerIpcHandler(
    'dialog:choose-files',
    trusted,
    async (rawDefaultPath: unknown, rawMaxCount: unknown) => {
      const defaultPath = typeof rawDefaultPath === 'string'
        ? rawDefaultPath
        : defaultCwd
      const maxCount = rawMaxCount
      if (
        typeof maxCount !== 'number' ||
        !Number.isInteger(maxCount) ||
        maxCount < 1 ||
        maxCount > 20
      ) throw new Error('无效字段：maxCount')

      const result = await dialog.showOpenDialog(window, {
        title: '添加到消息',
        defaultPath,
        properties: ['openFile', 'multiSelections']
      })
      if (result.canceled) return []
      if (result.filePaths.length > maxCount) {
        throw new Error('附件数量不能超过 20 个')
      }
      return attachmentStoreStagePaths(runtimeServices.attachmentStore, result.filePaths)
    }
  )

  if (debugLogMode() !== 'off') {
    ipcMain.handle(DIAGNOSTIC_MODE_CHANNEL, (event) => {
      trusted(event)
      return true
    })
    ipcMain.handle(DIAGNOSTIC_IPC_CHANNEL, (event, rawDiagnostic: unknown) => {
      trusted(event)
      receiveRendererDiagnostic(rawDiagnostic)
    })
  }
}

export function unregisterIpc(): void {
  for (const remove of removeServiceListeners) remove()
  removeServiceListeners = []
  reportRuntimeHost?.close()
  reportRuntimeHost = null
  for (const channel of COMMAND_CHANNELS) ipcMain.removeHandler(channel)
  for (const channel of GUI_IPC_CHANNELS) ipcMain.removeHandler(channel)
  ipcMain.removeHandler(DIAGNOSTIC_IPC_CHANNEL)
  ipcMain.removeHandler(DIAGNOSTIC_MODE_CHANNEL)
}

interface IpcArgumentsWithDiagnostics {
  readonly businessArguments: readonly unknown[]
  readonly context?: DebugContext
}

/**
 * Register one Electron handler with a transport-only diagnostic envelope.
 * The envelope is removed before the business handler is called, so the
 * command parser and the Service never receive diagnostic data.
 */
function registerIpcHandler(
  channel: string,
  trusted: (event: IpcMainInvokeEvent) => void,
  handler: ChannelHandler
): void {
  ipcMain.handle(channel, (event, ...rawArguments: unknown[]) => {
    trusted(event)
    const { businessArguments, context: suppliedContext } = splitDiagnosticArguments(rawArguments)
    const context = suppliedContext ?? getDebugContext()
    const startedAt = performance.now()
    const run = async (): Promise<unknown> => {
      const span = startDebugSpan('ipc.request', {
        channel
      })
      return withDebugContext(span.context, async () => {
        debugDetail('ipc.received', { channel })
        try {
          const result = await handler(...businessArguments)
          const durationMs = elapsedMilliseconds(startedAt)
          span.end({
            channel,
            status: channel === 'bart:cancel' ? 'cancel-requested' : 'ok',
            durationMs
          })
          debugDetail('ipc.response', {
            channel,
            status: channel === 'bart:cancel' ? 'cancel-requested' : 'ok',
            durationMs
          })
          return result
        } catch (error) {
          const durationMs = elapsedMilliseconds(startedAt)
          span.fail(error, {
            channel,
            status: 'error',
            durationMs
          })
          debugError('ipc.error', error, {
            channel,
            status: 'error',
            durationMs
          })
          throw error
        }
      })
    }

    return context
      ? withDebugContext(context, run)
      : run()
  })
}

function splitDiagnosticArguments(
  rawArguments: readonly unknown[]
): IpcArgumentsWithDiagnostics {
  const last = rawArguments.at(-1)
  if (!isRecord(last) || !Object.hasOwn(last, '__openagentDiagnostic')) {
    return { businessArguments: rawArguments }
  }
  const envelope = parseDiagnosticEnvelope(last)
  return {
    businessArguments: rawArguments.slice(0, -1),
    context: envelope.context as DebugContext
  }
}

function parseDiagnosticEnvelope(value: Record<string, unknown>): DiagnosticIpcEnvelope {
  const envelope = parseObject(
    value,
    ['__openagentDiagnostic', 'context'],
    'IPC diagnostic metadata'
  )
  if (envelope.__openagentDiagnostic !== true) {
    throw new Error('IPC diagnostic metadata 无效')
  }
  return {
    __openagentDiagnostic: true,
    context: parseDiagnosticContext(envelope.context)
  }
}

function parseDiagnosticContext(value: unknown): DiagnosticTraceContext {
  const context = parseObject(
    value,
    RENDERER_DIAGNOSTIC_CONTEXT_KEYS,
    'Diagnostic trace context',
    true
  )
  return {
    traceId: requiredString(context.traceId, 'traceId', RENDERER_DIAGNOSTICS_MAX_ID),
    ...optionalDiagnosticContextField(context.spanId, 'spanId'),
    ...optionalDiagnosticContextField(context.parentSpanId, 'parentSpanId'),
    ...optionalDiagnosticContextField(context.threadId, 'threadId'),
    ...optionalDiagnosticContextField(context.executionId, 'executionId'),
    ...optionalDiagnosticContextField(context.nativeSessionId, 'nativeSessionId'),
    ...(context.harnessId === undefined
      ? {}
      : isHarnessId(context.harnessId)
        ? { harnessId: context.harnessId }
        : (() => { throw new Error('无效字段：harnessId') })())
  }
}

function optionalDiagnosticContextField(
  value: unknown,
  field: string
): Record<string, string> {
  if (value === undefined) return {}
  return { [field]: requiredString(value, field, RENDERER_DIAGNOSTICS_MAX_ID) }
}

function contextFieldsForLog(
  context: DebugContext | undefined
): Record<string, string> {
  if (!context) return {}
  return {
    ...(context.traceId === undefined ? {} : { traceId: context.traceId }),
    ...(context.spanId === undefined ? {} : { spanId: context.spanId }),
    ...(context.parentSpanId === undefined ? {} : { parentSpanId: context.parentSpanId }),
    ...(context.threadId === undefined ? {} : { threadId: context.threadId }),
    ...(context.executionId === undefined ? {} : { executionId: context.executionId }),
    ...(context.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: context.nativeSessionId }),
    ...(context.harnessId === undefined ? {} : { harnessId: context.harnessId })
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100)
}

function debugLogMode(): 'off' | 'summary' | 'detail' {
  return getDebugLogMode()
}

function receiveRendererDiagnostic(value: unknown): void {
  if (debugLogMode() === 'off') return
  const diagnostic = parseRendererDiagnostic(value)
  const context = diagnostic.context
  const contextFields = contextFieldsForLog(context as DebugContext | undefined)
  const run = (): void => {
    if (diagnostic.event === 'renderer.exception' ||
        diagnostic.event === 'renderer.unhandled-rejection') {
      debugError(
        diagnostic.event,
        diagnosticError(diagnostic.fields),
        { ...diagnostic.fields, ...contextFields }
      )
      return
    }
    debugLog(diagnostic.event, {
      ...diagnostic.fields,
      ...contextFields
    })
  }
  if (context) withDebugContext(context as DebugContext, run)
  else run()
}

function parseRendererDiagnostic(value: unknown): RendererDiagnostic {
  const diagnostic = parseObject(
    value,
    ['event', 'context', 'fields'],
    'Renderer diagnostic',
    true
  )
  if (!isRendererDiagnosticEvent(diagnostic.event)) {
    throw new Error('Renderer diagnostic event 无效')
  }
  switch (diagnostic.event) {
    case 'renderer.submit': {
      const context = parseDiagnosticContext(diagnostic.context)
      if (diagnostic.fields === undefined) return { event: diagnostic.event, context }
      const fields = parseObject(
        diagnostic.fields,
        ['operation'],
        'Renderer submit diagnostic',
        true
      )
      if (fields.operation !== undefined && fields.operation !== 'bart-submit') {
        throw new Error('Renderer submit diagnostic operation 无效')
      }
      return {
        event: diagnostic.event,
        context,
        ...(fields.operation === undefined ? {} : { fields: { operation: fields.operation } })
      }
    }
    case 'renderer.exception':
      return {
        event: diagnostic.event,
        ...(diagnostic.context === undefined
          ? {}
          : { context: parseDiagnosticContext(diagnostic.context) }),
        fields: parseRendererErrorFields(diagnostic.fields, true)
      }
    case 'renderer.unhandled-rejection':
      return {
        event: diagnostic.event,
        ...(diagnostic.context === undefined
          ? {}
          : { context: parseDiagnosticContext(diagnostic.context) }),
        fields: parseRendererErrorFields(diagnostic.fields, false)
      }
    case 'renderer.first-reasoning-commit':
    case 'renderer.first-text-commit':
      return {
        event: diagnostic.event,
        ...(diagnostic.context === undefined
          ? {}
          : { context: parseDiagnosticContext(diagnostic.context) }),
        fields: parseRendererCommitFields(diagnostic.fields)
      }
  }
}

function parseRendererErrorFields(
  value: unknown,
  includeSource: boolean
): {
  readonly message: string
  readonly name?: string
  readonly stack?: string
  readonly source?: string
  readonly line?: number
  readonly column?: number
} {
  const fields = parseObject(
    value,
    includeSource
      ? ['message', 'name', 'stack', 'source', 'line', 'column']
      : ['message', 'name', 'stack'],
    'Renderer error diagnostic',
    true
  )
  return {
    message: boundedString(fields.message, 'message', RENDERER_DIAGNOSTICS_MAX_TEXT),
    ...optionalDiagnosticText(fields.name, 'name', 256),
    ...optionalDiagnosticText(fields.stack, 'stack', RENDERER_DIAGNOSTICS_MAX_TEXT),
    ...(includeSource ? optionalDiagnosticText(fields.source, 'source', RENDERER_DIAGNOSTICS_MAX_SOURCE) : {}),
    ...(includeSource ? optionalDiagnosticNumber(fields.line, 'line') : {}),
    ...(includeSource ? optionalDiagnosticNumber(fields.column, 'column') : {})
  }
}

function parseRendererCommitFields(value: unknown): {
  readonly threadId: string
  readonly executionId: string
  readonly durationMs: number
} {
  const fields = parseObject(
    value,
    ['threadId', 'executionId', 'durationMs'],
    'Renderer commit diagnostic'
  )
  const durationMs = fields.durationMs
  if (
    typeof durationMs !== 'number' ||
    !Number.isFinite(durationMs) ||
    durationMs < 0 ||
    durationMs > 60 * 60 * 1000
  ) throw new Error('无效字段：durationMs')
  return {
    threadId: requiredString(fields.threadId, 'threadId', RENDERER_DIAGNOSTICS_MAX_ID),
    executionId: requiredString(fields.executionId, 'executionId', RENDERER_DIAGNOSTICS_MAX_ID),
    durationMs
  }
}

function optionalDiagnosticText(
  value: unknown,
  field: string,
  max: number
): Record<string, string> {
  if (value === undefined) return {}
  return { [field]: boundedString(value, field, max) }
}

function optionalDiagnosticNumber(
  value: unknown,
  field: string
): Record<string, number> {
  if (value === undefined) return {}
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 10_000_000
  ) throw new Error(`无效字段：${field}`)
  return { [field]: value }
}

function diagnosticError(
  fields: Extract<RendererDiagnostic, {
    event: 'renderer.exception' | 'renderer.unhandled-rejection'
  }>['fields']
): Error {
  const error = new Error(fields.message)
  if (fields.name) error.name = fields.name
  if (fields.stack) {
    Object.defineProperty(error, 'stack', {
      configurable: true,
      value: fields.stack
    })
  }
  return error
}

function attachmentStoreStagePaths(
  store: AttachmentRepository,
  paths: readonly string[]
) {
  return store.stage(paths.map((path) => ({
    source: 'path' as const,
    path,
    displayName: basename(path)
  })))
}

function parseReportBounds(value: unknown): ReportRuntimeBounds {
  const bounds = parseObject(
    value,
    ['x', 'y', 'width', 'height'],
    '报告视图区域'
  )
  return {
    x: finiteReportBound(bounds.x),
    y: finiteReportBound(bounds.y),
    width: finiteReportBound(bounds.width),
    height: finiteReportBound(bounds.height)
  }
}

function finiteReportBound(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('无效的报告视图区域')
  }
  return value
}
