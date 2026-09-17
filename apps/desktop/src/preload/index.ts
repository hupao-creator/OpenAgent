import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  DesktopApi,
  ReportRuntimeBounds,
  ReportRuntimeFailure
} from '../shared/desktop-api'
import {
  DIAGNOSTIC_IPC_CHANNEL,
  DIAGNOSTIC_MODE_CHANNEL,
  type DiagnosticIpcEnvelope,
  type DiagnosticTraceContext,
  type RendererDiagnostic,
  type RendererFirstCommitDiagnostic
} from '../shared/diagnostic-tracing'
import type {
  RendererAppState,
  RendererStateMutation
} from '../shared/renderer-state-contracts'
import type { BartAttachmentImport } from '../shared/attachments'

type DiagnosticContextFields = Omit<DiagnosticTraceContext, 'traceId' | 'spanId'>

interface RendererGlobalLike {
  addEventListener?: (
    type: 'error' | 'unhandledrejection',
    listener: (event: unknown) => void
  ) => void
  requestAnimationFrame?: (callback: () => void) => number
  setTimeout?: (callback: () => void, delay: number) => unknown
  performance?: { now(): number }
  crypto?: { randomUUID?: () => string }
}

interface RendererErrorEventLike {
  readonly error?: unknown
  readonly message?: unknown
  readonly filename?: unknown
  readonly lineno?: unknown
  readonly colno?: unknown
}

interface RendererRejectionEventLike {
  readonly reason?: unknown
}

const rendererGlobal = globalThis as unknown as RendererGlobalLike
const MAX_RENDERER_COMMIT_KEYS = 1_024
let rendererDiagnosticSequence = 0
let rendererDiagnosticsEnabled = false
const rendererDiagnosticsReady = initializeRendererDiagnostics()
const firstRendererCommitKeys = new Set<string>()

function createDiagnosticId(prefix: string): string {
  try {
    const generated = rendererGlobal.crypto?.randomUUID?.()
    if (generated) return generated
  } catch {
    // Fall through to a local monotonic identifier. Diagnostics are best effort.
  }
  rendererDiagnosticSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${rendererDiagnosticSequence.toString(36)}`
}

function createOperationContext(fields: DiagnosticContextFields = {}): DiagnosticTraceContext {
  return {
    traceId: createDiagnosticId('renderer-trace'),
    spanId: createDiagnosticId('renderer-span'),
    ...fields
  }
}

function beginBartSubmitTrace(): DiagnosticTraceContext {
  return {
    traceId: createDiagnosticId('renderer-trace'),
    spanId: createDiagnosticId('renderer-span')
  }
}

function invokeIpc<T>(
  channel: string,
  businessArguments: readonly unknown[],
  context?: DiagnosticTraceContext
): Promise<T> {
  const diagnostic = !rendererDiagnosticsEnabled || context === undefined
    ? undefined
    : {
        __openagentDiagnostic: true as const,
        context
      } satisfies DiagnosticIpcEnvelope
  return ipcRenderer.invoke(
    channel,
    ...businessArguments,
    ...(diagnostic === undefined ? [] : [diagnostic])
  ) as Promise<T>
}

function sendRendererDiagnostic(diagnostic: RendererDiagnostic): void {
  void rendererDiagnosticsReady.then((enabled) => {
    if (!enabled) return
    try {
      void ipcRenderer.invoke(DIAGNOSTIC_IPC_CHANNEL, diagnostic).catch(() => undefined)
    } catch {
      // Diagnostics are strictly best effort.
    }
  }).catch(() => undefined)
}

function reportRendererError(event: unknown): void {
  try {
    const errorEvent = event as RendererErrorEventLike
    const error = normalizeRendererError(errorEvent.error, errorEvent.message)
    const fields = {
      ...error,
      ...(typeof errorEvent.filename === 'string'
        ? { source: errorEvent.filename }
        : {}),
      ...(typeof errorEvent.lineno === 'number' ? { line: errorEvent.lineno } : {}),
      ...(typeof errorEvent.colno === 'number' ? { column: errorEvent.colno } : {})
    }
    sendRendererDiagnostic({
      event: 'renderer.exception',
      fields
    })
  } catch {
    // Do not let diagnostic formatting affect the browser's native error flow.
  }
}

function reportUnhandledRejection(event: unknown): void {
  try {
    const reason = (event as RendererRejectionEventLike).reason
    sendRendererDiagnostic({
      event: 'renderer.unhandled-rejection',
      fields: normalizeRendererError(reason)
    })
  } catch {
    // Do not let diagnostic formatting affect the browser's native rejection flow.
  }
}

function normalizeRendererError(
  value: unknown,
  fallback?: unknown
): { readonly message: string; readonly name?: string; readonly stack?: string } {
  const candidate = value instanceof Error ? value : undefined
  const message = candidate?.message ||
    (typeof value === 'string' ? value : stringifyRendererValue(value)) ||
    (typeof fallback === 'string' ? fallback : stringifyRendererValue(fallback)) ||
    'Unknown renderer error'
  return {
    message,
    ...(candidate?.name ? { name: candidate.name } : {}),
    ...(candidate?.stack ? { stack: candidate.stack } : {})
  }
}

function stringifyRendererValue(value: unknown): string {
  if (value === undefined) return ''
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value)
    return serialized === undefined ? String(value) : serialized
  } catch {
    return String(value)
  }
}

function reportFirstRendererCommit(input: RendererFirstCommitDiagnostic): void {
  const commitKey = `${input.executionId}:${input.kind}`
  if (firstRendererCommitKeys.has(commitKey)) return
  firstRendererCommitKeys.delete(commitKey)
  firstRendererCommitKeys.add(commitKey)
  while (firstRendererCommitKeys.size > MAX_RENDERER_COMMIT_KEYS) {
    const oldest = firstRendererCommitKeys.values().next().value
    if (typeof oldest !== 'string') break
    firstRendererCommitKeys.delete(oldest)
  }
  sendRendererDiagnostic({
    event: input.kind === 'reasoning'
      ? 'renderer.first-reasoning-commit'
      : 'renderer.first-text-commit',
    fields: {
      threadId: input.threadId,
      executionId: input.executionId,
      durationMs: input.durationMs
    }
  })
}

function initializeRendererDiagnostics(): Promise<boolean> {
  try {
    return ipcRenderer.invoke(DIAGNOSTIC_MODE_CHANNEL).then((value: unknown) => {
      rendererDiagnosticsEnabled = value === true
      return rendererDiagnosticsEnabled
    }).catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

function installGlobalRendererDiagnostics(): void {
  rendererGlobal.addEventListener?.('error', reportRendererError)
  rendererGlobal.addEventListener?.('unhandledrejection', reportUnhandledRejection)
}

installGlobalRendererDiagnostics()

/**
 * Path-backed Files cross the bridge by path. Clipboard-generated Files are
 * copied as bounded bytes into Main's attachment store.
 */
const stageBartAttachments: DesktopApi['stageBartAttachments'] = async (files) => {
  if (files.length > 20) throw new Error('附件数量不能超过 20 个')
  const imports: BartAttachmentImport[] = []
  for (const file of files) {
    const path = webUtils.getPathForFile(file)
    if (path) {
      imports.push({ source: 'path', path, displayName: file.name })
      continue
    }
    if (file.size > 20 * 1024 * 1024) {
      throw new Error('无路径的粘贴内容不能超过 20 MB；请先保存文件后再通过回形针添加')
    }
    imports.push({
      source: 'bytes',
      bytes: await file.arrayBuffer(),
      displayName: file.name
    })
  }
  return invokeIpc('bart:stage-attachments', [imports], createOperationContext())
}

const api: DesktopApi = {
  platform: process.platform,
  loadState: async () => {
    return invokeIpc<RendererAppState>('state:load', [])
  },
  onStateMutation: (listener: (mutation: RendererStateMutation) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      mutation: RendererStateMutation
    ): void => {
      listener(mutation)
    }
    ipcRenderer.on('state:mutation', handler)
    return () => ipcRenderer.removeListener('state:mutation', handler)
  },

  submitBartMessage: async (request) => {
    const context = beginBartSubmitTrace()
    sendRendererDiagnostic({
      event: 'renderer.submit',
      context,
      fields: { operation: 'bart-submit' }
    })
    await invokeIpc('bart:submit', [request], context)
  },
  reportRendererFirstCommit: reportFirstRendererCommit,
  cancelBartTask: () => invokeIpc<void>(
    'bart:cancel',
    [],
    createOperationContext()
  ),
  clearBartSession: () => invokeIpc<void>(
    'bart:clear',
    [],
    createOperationContext()
  ),
  clearAllHistory: () => invokeIpc(
    'history:clear',
    [],
    createOperationContext()
  ),

  followUpThread: (request) => invokeIpc(
    'thread:follow-up',
    [request],
    createOperationContext({ threadId: request.threadId })
  ),
  interruptThread: (threadId) => invokeIpc(
    'thread:interrupt',
    [threadId],
    createOperationContext({ threadId })
  ),
  respondToThreadInteraction: (request) =>
    invokeIpc('thread:interaction-respond', [request], createOperationContext({
      threadId: request.threadId
    })),
  readThread: (request) => invokeIpc(
    'thread:read',
    [request],
    createOperationContext({ threadId: request.threadId })
  ),
  forkThread: (request) => invokeIpc(
    'thread:fork',
    [request],
    createOperationContext({ threadId: request.threadId })
  ),
  updateThreadSettings: (request) =>
    invokeIpc('thread:update-settings', [request], createOperationContext({
      threadId: request.threadId,
      harnessId: request.harnessId
    })),

  updateAppSettings: (settings) => invokeIpc(
    'app:update-settings',
    [settings],
    createOperationContext()
  ),
  updateUiState: (update) => invokeIpc(
    'state:update-ui',
    [update],
    createOperationContext()
  ),
  installHarness: (harnessId) => invokeIpc(
    'harness:install', [harnessId], createOperationContext({ harnessId })
  ),
  detectHarnessInstallations: () => invokeIpc(
    'harness:detect-installations',
    [],
    createOperationContext()
  ),
  loadHarnessSettingsPresentation: (request) =>
    invokeIpc('harness:settings-presentation', [request], createOperationContext(
      request.scope === 'thread' ? { threadId: request.threadId } : {
        harnessId: request.harnessId
      }
    )),
  invokeHarnessExtension: (request) =>
    invokeIpc('harness:extension', [request], createOperationContext({
      harnessId: request.harnessId
    })),

  chooseFiles: (defaultPath: string | undefined, maxCount: number) =>
    invokeIpc('dialog:choose-files', [defaultPath, maxCount], createOperationContext()),
  stageBartAttachments,

  openReportRuntime: (reportId: string, bounds: ReportRuntimeBounds) =>
    invokeIpc('report:open', [reportId, bounds], createOperationContext()),
  setReportRuntimeBounds: (bounds: ReportRuntimeBounds) =>
    invokeIpc('report:set-bounds', [bounds], createOperationContext()),
  setThreadArchived: (threadId: string, archived: boolean) =>
    invokeIpc('thread:set-archived', [threadId, archived], createOperationContext({ threadId })),
  setReportArchived: (reportId: string, archived: boolean) =>
    invokeIpc(
      'report:set-archived',
      [reportId, archived],
      createOperationContext()
    ),
  closeReportRuntime: () => invokeIpc(
    'report:close',
    [],
    createOperationContext()
  ),
  onReportRuntimeFailure: (listener: (failure: ReportRuntimeFailure) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      failure: ReportRuntimeFailure
    ): void => listener(failure)
    ipcRenderer.on('report:failed', handler)
    return () => ipcRenderer.removeListener('report:failed', handler)
  },

  openExternal: (url: string) => invokeIpc(
    'shell:open-external',
    [url],
    createOperationContext()
  )
}

contextBridge.exposeInMainWorld('openAgent', api)
