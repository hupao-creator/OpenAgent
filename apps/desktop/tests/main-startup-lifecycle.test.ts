import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HARNESS_IDS } from '../src/shared/harnesses'

const mock = vi.hoisted(() => ({
  mkdir: vi.fn(),
  realpath: vi.fn(),
  createComposition: vi.fn(),
  createService: vi.fn(),
  initialize: vi.fn(),
  shutdown: vi.fn(),
  ledgerOpen: vi.fn(),
  ledgerDispose: vi.fn(),
  startHeadless: vi.fn(),
  closeHeadless: vi.fn(),
  registerIpc: vi.fn(),
  unregisterIpc: vi.fn(),
  app: undefined as unknown as EventEmitter & {
    whenReady: ReturnType<typeof vi.fn>
    quit: ReturnType<typeof vi.fn>
    exit: ReturnType<typeof vi.fn>
  },
  createWindow: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ mkdir: mock.mkdir, realpath: mock.realpath }))
vi.mock('electron', () => ({
  get app() { return mock.app },
  nativeTheme: { themeSource: 'system', shouldUseDarkColors: false, on: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: Object.assign(function (...args: unknown[]) {
    return mock.createWindow(...args)
  }, { getAllWindows: () => [] }),
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() }
}))
vi.mock('../src/main/debug-log', () => ({ debugLog: vi.fn(), initDebugLog: vi.fn() }))
vi.mock('../src/main/harness-composition', () => ({
  createMainHarnessComposition: mock.createComposition
}))
vi.mock('../src/main/headless-control', () => ({
  DEFAULT_HEADLESS_PORT: 45775,
  startHeadlessControl: mock.startHeadless
}))
vi.mock('../src/main/ipc', () => ({
  registerIpc: mock.registerIpc,
  unregisterIpc: mock.unregisterIpc
}))
vi.mock('../src/main/report-runtime', () => ({ REPORT_SCHEME_PRIVILEGES: {} }))
vi.mock('../src/main/openagent-service', () => ({
  OpenAgentService: function (...args: unknown[]) {
    mock.createService(...args)
    return { initialize: mock.initialize, shutdown: mock.shutdown,
      loadRendererState: () => ({ settings: { appearance: 'system' } }),
      onStateMutation: () => vi.fn() }
  }
}))
vi.mock('../src/main/services/bart-telemetry-ledger', () => ({
  BartTelemetryLedger: { open: mock.ledgerOpen }
}))
vi.mock('../src/main/services/cli-resolver', () => ({ CliResolver: class {} }))
vi.mock('../src/main/services/thread-state-store', () => ({ ThreadStateStore: class {} }))
vi.mock('../src/main/services/worktree-manager', () => ({ WorktreeManager: class {} }))
vi.mock('../src/main/services/attachment-repository', () => ({ AttachmentRepository: class {} }))
vi.mock('../src/main/scheduled-dispatch', () => ({ ScheduledDispatchStore: class {} }))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

function requestQuit() {
  const event = { preventDefault: vi.fn() }
  mock.app.emit('before-quit', event)
  return event
}

let originalSignals: Map<'SIGINT' | 'SIGTERM', Set<(signal: NodeJS.Signals) => void>>

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.stubEnv('OPENAGENT_HEADLESS', '0')
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  originalSignals = new Map((['SIGINT', 'SIGTERM'] as const).map(signal => [
    signal, new Set(process.listeners(signal))
  ]))
  mock.app = Object.assign(new EventEmitter(), {
    whenReady: vi.fn().mockResolvedValue(undefined),
    commandLine: { appendSwitch: vi.fn() },
    quit: vi.fn(),
    exit: vi.fn(),
    setName: vi.fn(),
    getPath: () => '/tmp/openagent-startup-test',
    setPath: vi.fn(),
    isPackaged: false,
    dock: { hide: vi.fn() }
  })
  mock.mkdir.mockResolvedValue(undefined)
  mock.realpath.mockImplementation(async (path: string) => path)
  mock.ledgerOpen.mockImplementation(async () => ({ dispose: mock.ledgerDispose }))
  mock.ledgerDispose.mockResolvedValue(undefined)
  mock.createComposition.mockReturnValue({})
  mock.initialize.mockResolvedValue(undefined)
  mock.shutdown.mockResolvedValue(undefined)
  mock.closeHeadless.mockResolvedValue(undefined)
  mock.startHeadless.mockResolvedValue({ port: 12345, close: mock.closeHeadless })
  mock.createWindow.mockImplementation(() => Object.assign(new EventEmitter(), {
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
    isMinimized: () => false,
    loadFile: vi.fn().mockResolvedValue(undefined),
    webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() })
  }))
})

afterEach(async () => {
  for (const [signal, previous] of originalSignals) {
    for (const listener of process.listeners(signal)) {
      if (!previous.has(listener)) process.removeListener(signal, listener)
    }
  }
  await nextTurn()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Main startup and quit ownership', () => {
  it('does not begin startup when readiness arrives after quit', async () => {
    const ready = deferred()
    mock.app.whenReady.mockReturnValue(ready.promise)
    await import('../src/main/index')
    requestQuit()
    ready.resolve()
    await nextTurn()
    expect(mock.mkdir).not.toHaveBeenCalled()
    expect(mock.createComposition).not.toHaveBeenCalled()
    expect(mock.createWindow).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
  })

  it.each(['directories', 'telemetry ledgers'] as const)(
    'joins pending %s and prevents late composition or window installation',
    async stage => {
      const gate = deferred()
      const blocked = stage === 'directories' ? mock.mkdir
        : mock.ledgerOpen
      blocked.mockImplementation(() => gate.promise.then(() =>
        stage === 'telemetry ledgers' ? { dispose: mock.ledgerDispose } : undefined
      ))
      await import('../src/main/index')
      await vi.waitFor(() => expect(blocked).toHaveBeenCalled())
      requestQuit()
      await nextTurn()
      expect(mock.app.quit).not.toHaveBeenCalled()
      gate.resolve()
      await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
      expect(mock.createComposition).not.toHaveBeenCalled()
      expect(mock.createService).not.toHaveBeenCalled()
      expect(mock.createWindow).not.toHaveBeenCalled()
      expect(mock.startHeadless).not.toHaveBeenCalled()
      expect(mock.app.listenerCount('activate')).toBe(0)
      expect(mock.app.exit).not.toHaveBeenCalled()
      if (stage === 'telemetry ledgers') expect(mock.ledgerDispose).toHaveBeenCalledTimes(HARNESS_IDS.length)
    }
  )

  it('joins all parallel startup work even when one operation fails first', async () => {
    const gate = deferred()
    mock.ledgerOpen.mockImplementationOnce(async () => {
      throw new Error('first ledger failed')
    }).mockImplementation(() => gate.promise.then(() => ({ dispose: mock.ledgerDispose })))
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.ledgerOpen).toHaveBeenCalledTimes(HARNESS_IDS.length))
    requestQuit()
    await nextTurn()
    expect(mock.app.quit).not.toHaveBeenCalled()
    gate.resolve()
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
    expect(mock.ledgerDispose).toHaveBeenCalledTimes(HARNESS_IDS.length - 1)
    expect(mock.createService).not.toHaveBeenCalled()
    expect(mock.app.exit).not.toHaveBeenCalled()
  })

  it('revokes Service initialization before joining it and cannot deadlock its cleanup', async () => {
    const initializing = deferred()
    const stopping = deferred()
    mock.initialize.mockReturnValue(initializing.promise)
    mock.shutdown.mockImplementation(() => {
      initializing.reject(new Error('startup revoked'))
      return stopping.promise
    })
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.initialize).toHaveBeenCalledOnce())
    requestQuit()
    await nextTurn()
    expect(mock.shutdown).toHaveBeenCalled()
    expect(mock.app.quit).not.toHaveBeenCalled()
    stopping.resolve()
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
    expect(mock.registerIpc).not.toHaveBeenCalled()
    expect(mock.createWindow).not.toHaveBeenCalled()
  })

  it.each([false, true])('prevents publishing after Service initialize resolves (headless=%s)', async headless => {
    vi.stubEnv('OPENAGENT_HEADLESS', headless ? '1' : '0')
    mock.initialize.mockImplementation(async () => { requestQuit() })
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
    expect(mock.createWindow).not.toHaveBeenCalled()
    expect(mock.registerIpc).not.toHaveBeenCalled()
    expect(mock.startHeadless).not.toHaveBeenCalled()
    expect(mock.app.listenerCount('activate')).toBe(0)
  })

  it('joins a pending headless listen and its late close before the final quit', async () => {
    vi.stubEnv('OPENAGENT_HEADLESS', '1')
    const listening = deferred()
    const closing = deferred()
    mock.startHeadless.mockImplementation(() => listening.promise.then(() => ({
      port: 12345, close: mock.closeHeadless
    })))
    mock.closeHeadless.mockReturnValue(closing.promise)
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.startHeadless).toHaveBeenCalledOnce())
    requestQuit()
    await nextTurn()
    expect(mock.app.quit).not.toHaveBeenCalled()
    listening.resolve()
    await vi.waitFor(() => expect(mock.closeHeadless).toHaveBeenCalled())
    expect(mock.app.quit).not.toHaveBeenCalled()
    closing.resolve()
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
    expect(mock.createWindow).not.toHaveBeenCalled()
  })

  it('joins Service cleanup after a failed headless listen before exiting with an error', async () => {
    vi.stubEnv('OPENAGENT_HEADLESS', '1')
    const stopping = deferred()
    mock.startHeadless.mockRejectedValue(new Error('address already in use'))
    mock.shutdown.mockReturnValue(stopping.promise)
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.shutdown).toHaveBeenCalledOnce())
    expect(mock.app.exit).not.toHaveBeenCalled()
    stopping.resolve()
    await vi.waitFor(() => expect(mock.app.exit).toHaveBeenCalledWith(1))
    expect(mock.createWindow).not.toHaveBeenCalled()
  })

  it('does not reopen or show a window after shutdown revokes ingress', async () => {
    const gate = deferred()
    mock.shutdown.mockReturnValue(gate.promise)
    await import('../src/main/index')
    await vi.waitFor(() => expect(mock.createWindow).toHaveBeenCalledOnce())
    expect(mock.realpath).toHaveBeenCalledWith('/tmp/openagent-startup-test/.OpenAgent')
    expect(mock.createService.mock.calls[0]?.at(-1)).toEqual(expect.objectContaining({
      defaultCwd: '/tmp/openagent-startup-test/.OpenAgent'
    }))
    const window = mock.createWindow.mock.results[0].value
    requestQuit()
    mock.app.emit('activate')
    window.emit('ready-to-show')
    expect(window.show).not.toHaveBeenCalled()
    expect(mock.createWindow).toHaveBeenCalledOnce()
    gate.resolve()
    await vi.waitFor(() => expect(mock.app.quit).toHaveBeenCalledOnce())
  })
})
