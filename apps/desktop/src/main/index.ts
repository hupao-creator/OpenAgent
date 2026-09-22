import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, nativeTheme, protocol, shell } from 'electron'
import { isPackagedRuntime } from '../shared/development-runtime'
import { HARNESS_IDS } from '../shared/harnesses'
import {
  debugError,
  debugLog,
  flushDebugLog,
  initDebugLog
} from '@openagent/plugin-kit/main'
import { createMainHarnessComposition } from './harness-composition'
import { loadHarnessProviderOverride } from './harness-execution-environment'
import {
  DEFAULT_HEADLESS_PORT,
  startHeadlessControl,
  type HeadlessControl
} from './headless-control'
import { registerIpc, unregisterIpc } from './ipc'
import { OpenAgentService } from './openagent-service'
import { REPORT_SCHEME_PRIVILEGES } from './report-runtime'
import { registerSystemFontProtocol, SYSTEM_FONT_SCHEME_PRIVILEGES } from './system-fonts'
import {
  DEV_PROFILE_MARKER,
  resolveDevUserDataPath,
  resolveHeadlessUserDataPath,
  resolveRuntimePaths
} from './runtime-paths'
import { ScheduledDispatchStore } from './scheduled-dispatch'
import { AttachmentRepository } from './services/attachment-repository'
import { BartTelemetryLedger } from './services/bart-telemetry-ledger'
import { CliResolver } from './services/cli-resolver'
import { ThreadStateStore } from './services/thread-state-store'
import { WorktreeManager } from './services/worktree-manager'
import { ApplicationAppearance } from './application-appearance'
import { AppQuitCoordinator } from './app-quit-coordinator'

const PROCESS_ERROR_OBSERVER_KEY = Symbol.for('openagent.debug-log.process-error-observer')

// Entries a disposable dev profile keeps across a reset: debug history has its
// own retention policy, and the marker is what proves the directory is ours.
const PRESERVED_DEV_PROFILE_ENTRIES = new Set([DEV_PROFILE_MARKER, 'debug-logs'])

/**
 * Headless functional-debug mode uses this same composition root and Service.
 * Its only differences are the absence of a window and the loopback transport.
 */
const headless = process.env.OPENAGENT_HEADLESS === '1'

interface RuntimeServices {
  readonly attachmentStore: AttachmentRepository
  readonly defaultCwd: string
}

let mainWindow: BrowserWindow | null = null
let openAgentService: OpenAgentService | null = null
let runtimeServices: RuntimeServices | null = null
let headlessControl: HeadlessControl | null = null
let headlessOpening: Promise<HeadlessControl> | null = null
let startupOperation: Promise<void> | null = null
let removeAppearanceListener: (() => void) | undefined
const appearance = new ApplicationAppearance(nativeTheme, process.platform, () => mainWindow)

app.setName('Agent Workspace')
protocol.registerSchemesAsPrivileged([REPORT_SCHEME_PRIVILEGES, SYSTEM_FONT_SCHEME_PRIVILEGES])
// Keep a manual headless process isolated from the GUI by default. Acceptance
// workers supply an even narrower process-private directory through the env.
if (headless) {
  app.setPath('userData', resolveHeadlessUserDataPath(
    app.getPath('userData'),
    process.env.OPENAGENT_HEADLESS_USER_DATA
  ))
} else if (!app.isPackaged && process.env.OPENAGENT_DEV_RESET_USER_DATA === '1') {
  // Reset before Electron opens sessions or the Service reads persisted state.
  // Keep the regular application's data outside this disposable dev profile.
  // A caller may point the profile elsewhere to run concurrently with another
  // dev instance instead of sharing (and resetting) the default one.
  const configuredDevUserData = process.env.OPENAGENT_DEV_USER_DATA?.trim()
  const devUserDataPath = resolveDevUserDataPath(app.getPath('userData'), configuredDevUserData)
  resetDevUserDataPath(devUserDataPath, { ownedByApp: !configuredDevUserData })
  app.setPath('userData', devUserDataPath)
  app.setPath('sessionData', devUserDataPath)
  console.info(`[dev] reset Electron user data: ${devUserDataPath}`)
}

const packagedRuntime = isPackagedRuntime(app.isPackaged, process.env)
const earlyDebugLogPath = initDebugLog(
  join(app.getPath('userData'), 'debug-logs'),
  { packaged: packagedRuntime }
)
if (earlyDebugLogPath && !packagedRuntime) {
  console.log(`[debug-log] ${earlyDebugLogPath}`)
}
debugLog('app.bootstrap', {
  cwd: process.cwd(),
  version: readAppVersion(),
  electronVersion: process.versions.electron,
  runtime: packagedRuntime ? 'packaged' : 'development',
  headless,
  userDataPath: app.getPath('userData')
})
installProcessErrorObservers()

process.once('SIGINT', () => app.quit())
process.once('SIGTERM', () => app.quit())

const quitCoordinator = new AppQuitCoordinator({
  drain: async () => {
    app.removeListener('activate', openMainWindow)
    removeAppearanceListener?.()
    appearance.dispose()
    const results = await Promise.allSettled([
      closeHeadlessControl(),
      // Revoke the Service before joining startup: initializeService's error
      // cleanup may itself be waiting for this same shutdown operation.
      openAgentService?.shutdown(),
      // The startup observer below reports failures; cancellation is expected.
      startupOperation?.catch(() => undefined)
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to stop OpenAgent cleanly', result.reason)
      }
    }
    openAgentService = null
    runtimeServices = null
    // Keep shutdown bounded: queued diagnostics are useful only if they do
    // not hold Electron's native quit path open indefinitely.
    await flushDebugLogSafely(1_000)
  },
  quit: () => app.quit(),
  schedule: callback => setImmediate(callback),
  onDrainError: error => console.error('Failed to stop OpenAgent cleanly', error),
  onPhaseChange: phase => {
    debugLog('app.quit-phase', { phase })
    if (phase === 'ready') void flushDebugLogSafely(250)
  }
})

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 600,
    show: false,
    ...appearance.windowOptions,
    title: 'Agent Workspace',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 21 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  window.once('ready-to-show', () => {
    if (quitCoordinator.phase === 'running' && !window.isDestroyed()) window.show()
  })
  window.once('closed', () => {
    if (mainWindow !== window) return
    mainWindow = null
    unregisterIpc()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void window.loadURL(rendererUrl)
  else void window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

function openMainWindow(): void {
  if (quitCoordinator.phase !== 'running') return
  const service = openAgentService
  const runtime = runtimeServices
  if (!service || !runtime) return
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }

  unregisterIpc()
  mainWindow = createWindow()
  registerIpc(mainWindow, service, runtime.defaultCwd, {
    attachmentStore: runtime.attachmentStore
  })
}

async function initializeService(): Promise<void> {
  assertStartupRunning()
  const paths = resolveRuntimePaths({
    headless,
    userDataPath: app.getPath('userData'),
    homePath: app.getPath('home'),
    headlessOpenAgentHome: process.env.OPENAGENT_HEADLESS_HOME,
    devAttachmentRoot: process.env.OPENAGENT_DEV_ATTACHMENT_ROOT
  })
  const userDataPath = paths.userDataPath
  debugLog('app.started', {
    packaged: packagedRuntime
  })

  await joinStartupOperations([
    mkdir(paths.openAgentHome, { recursive: true }),
    mkdir(paths.bartCwd, { recursive: true }),
    mkdir(paths.temporaryWorkspaceRoot, { recursive: true })
  ])
  assertStartupRunning()
  const defaultCwd = await realpath(paths.openAgentHome)
  assertStartupRunning()

  const providerOverride = await loadHarnessProviderOverride({
    environment: { ...process.env },
    cwd: process.cwd()
  })
  assertStartupRunning()
  const resolver = new CliResolver(headless && providerOverride ? { ...process.env } : undefined)
  const worktreeManager = new WorktreeManager({
    registryPath: join(userDataPath, 'openagent-state-v4', 'managed-worktrees.json')
  })
  const telemetryLedgers = new Map<string, BartTelemetryLedger>()
  let mainHarnesses: ReturnType<typeof createMainHarnessComposition> | undefined
  let service: OpenAgentService | undefined
  try {
    assertStartupRunning()
    await joinStartupOperations(HARNESS_IDS.map(async harnessId => {
      const ledger = await BartTelemetryLedger.open(
        join(userDataPath, 'bart-telemetry-ledgers', `${harnessId}.json`)
      )
      telemetryLedgers.set(harnessId, ledger)
    }))
    assertStartupRunning()
    mainHarnesses = createMainHarnessComposition({
      resolver,
      providerOverride,
      harnessDataRoot: join(userDataPath, 'harnesses'),
      temporaryWorkspaceRoot: paths.temporaryWorkspaceRoot,
      telemetryLedgerFor: (harnessId) => {
        const ledger = telemetryLedgers.get(harnessId)
        if (!ledger) throw new Error(`Missing telemetry ledger scope: ${harnessId}`)
        return ledger
      },
      authorizeManagedWorkspaceWrite: (request) =>
        worktreeManager.authorizeManagedWorkspaceWrite(request)
    })
    const attachmentStore = new AttachmentRepository(paths.attachmentRoot)
    service = new OpenAgentService(
      new ThreadStateStore(userDataPath),
      mainHarnesses,
      worktreeManager,
      attachmentStore,
      new ScheduledDispatchStore(userDataPath),
      {
        defaultCwd,
        bartCwd: paths.bartCwd,
        temporaryWorkspaceRoot: paths.temporaryWorkspaceRoot
      }
    )
    // Publish the lifecycle owner before initialization may acquire any native
    // Plugin resource. A quit during catalog discovery can now revoke and join
    // that exact Service instead of exiting around it.
    openAgentService = service
    await service.initialize()
    assertStartupRunning()
    if (!headless) {
      appearance.apply(service.loadRendererState().settings.appearance)
      removeAppearanceListener = service.onStateMutation(mutation => {
        if (mutation.settings) appearance.apply(mutation.settings.appearance)
      })
    }
    runtimeServices = { attachmentStore, defaultCwd }
  } catch (error) {
    // Before Service takes ownership, startup owns every acquired sidecar.
    // Join the entire acquisition batch before disposing even on partial failure.
    const cleanup = service
      ? [() => service!.shutdown()]
      : [
          ...HARNESS_IDS.flatMap(harnessId => mainHarnesses
            ? [() => mainHarnesses![harnessId].dispose()]
            : []),
          ...[...telemetryLedgers.values()].map(ledger => () => ledger.dispose())
        ]
    const results = await Promise.allSettled(
      cleanup.map(operation => Promise.resolve().then(operation))
    )
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to clean up OpenAgent initialization', result.reason)
      }
    }
    if (openAgentService === service) openAgentService = null
    throw error
  }
}

function assertStartupRunning(): void {
  if (quitCoordinator.phase !== 'running') throw new Error('OpenAgent startup revoked by shutdown')
}

async function joinStartupOperations(operations: readonly Promise<unknown>[]): Promise<void> {
  const results = await Promise.allSettled(operations)
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'OpenAgent startup failed')
}

async function startHeadless(): Promise<void> {
  if (quitCoordinator.phase !== 'running') return
  const service = openAgentService
  const runtime = runtimeServices
  if (!service || !runtime) return
  if (process.platform === 'darwin') app.dock?.hide()
  const configuredPort = Number(process.env.OPENAGENT_HEADLESS_PORT)
  const port = Number.isInteger(configuredPort) &&
    configuredPort >= 0 && configuredPort <= 65_535
    ? configuredPort
    : DEFAULT_HEADLESS_PORT
  const opening = startHeadlessControl(
    service,
    { attachmentStore: runtime.attachmentStore, openExternal: url => shell.openExternal(url) },
    port
  )
  headlessOpening = opening
  let opened: HeadlessControl
  try {
    opened = await opening
  } finally {
    if (headlessOpening === opening) headlessOpening = null
  }
  if (quitCoordinator.phase !== 'running') {
    await opened.close()
    return
  }
  headlessControl = opened
  console.log(
    `OpenAgent headless control listening on http://127.0.0.1:${headlessControl.port}`
  )
}

async function closeHeadlessControl(): Promise<void> {
  const current = headlessControl
  headlessControl = null
  const pending = headlessOpening
  const [opening] = await Promise.allSettled([pending])
  const controls = new Set<HeadlessControl>()
  if (current) controls.add(current)
  if (opening.status === 'fulfilled' && opening.value) controls.add(opening.value)
  const results = await Promise.allSettled(
    [...controls].map(control => control.close())
  )
  const failures = [opening, ...results].flatMap(result =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length) {
    throw new AggregateError(failures, 'Headless control shutdown failed')
  }
}

function readAppVersion(): string | undefined {
  try {
    return typeof app.getVersion === 'function' ? app.getVersion() : undefined
  } catch {
    return undefined
  }
}

function safeDebugError(evt: string, error: unknown, fields?: Record<string, unknown>): void {
  try {
    if (typeof debugError === 'function') debugError(evt, error, fields)
  } catch {
    // Error observation is strictly diagnostic and cannot change failure flow.
  }
}

function flushDebugLogSafely(timeoutMs: number): Promise<void> {
  try {
    return typeof flushDebugLog === 'function'
      ? flushDebugLog(timeoutMs).catch(() => undefined)
      : Promise.resolve()
  } catch {
    return Promise.resolve()
  }
}

function installProcessErrorObservers(): void {
  const processMarkers = process as unknown as Record<symbol, boolean>
  if (processMarkers[PROCESS_ERROR_OBSERVER_KEY]) return
  processMarkers[PROCESS_ERROR_OBSERVER_KEY] = true

  // Monitor observes an uncaught exception without becoming the handler that
  // changes Node's default fatal-exception behavior.
  try {
    process.on('uncaughtExceptionMonitor', (error, origin) => {
      safeDebugError('process.uncaught-exception', error, { origin })
    })
    process.on('warning', (warning) => {
      safeDebugError('process.warning', warning)
    })
  } catch {
    // Process observation is diagnostic only and cannot block startup.
  }
}

function resetDevUserDataPath(path: string, options: { ownedByApp: boolean }): void {
  mkdirSync(path, { recursive: true })
  const markerPath = join(path, DEV_PROFILE_MARKER)
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return
  }
  const removable = names.filter(name => !PRESERVED_DEV_PROFILE_ENTRIES.has(name))
  // Clearing is recursive, so a caller-supplied path must prove it holds
  // nothing of its own first. A typo in OPENAGENT_DEV_USER_DATA would
  // otherwise delete unrelated files before Electron finishes starting. An
  // empty directory is accepted: the caller created it for this app.
  if (!options.ownedByApp && !names.includes(DEV_PROFILE_MARKER) && removable.length) {
    throw new Error(
      `refusing to clear ${path}: it holds data this app does not own. ` +
        'Point OPENAGENT_DEV_USER_DATA at an empty directory, or delete it first.'
    )
  }
  writeFileSync(markerPath, '')
  for (const name of removable) {
    rmSync(join(path, name), { recursive: true, force: true })
  }
}

async function startApplication(): Promise<void> {
  try {
    await initializeService()
    assertStartupRunning()
    if (headless) {
      await startHeadless()
      return
    }
    openMainWindow()
    app.on('activate', openMainWindow)
  } catch (error) {
    // A failed listener/window startup still owns the successfully initialized
    // Service. Release it before the fatal startup exit (or concurrent quit).
    const results = await Promise.allSettled([
      closeHeadlessControl(),
      openAgentService?.shutdown()
    ])
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Failed to clean up OpenAgent startup', result.reason)
      }
    }
    openAgentService = null
    runtimeServices = null
    throw error
  }
}

void app.whenReady().then(() => {
  // Readiness itself owns no resources and need not delay an earlier quit.
  debugLog('app.ready')
  if (quitCoordinator.phase !== 'running') return
  if (!headless) registerSystemFontProtocol(protocol)
  startupOperation = startApplication()
  return startupOperation
}).catch(async (error) => {
  if (quitCoordinator.phase !== 'running') return
  safeDebugError('app.startup-failed', error, { phase: quitCoordinator.phase })
  console.error('Failed to start OpenAgent', error)
  await flushDebugLogSafely(1_000)
  app.exit(1)
})

app.on('before-quit', (event) => {
  unregisterIpc()
  debugLog('app.before-quit', {
    phase: quitCoordinator.phase,
    hasService: openAgentService !== null,
    windowCount: BrowserWindow.getAllWindows().length
  })
  quitCoordinator.handleBeforeQuit(event)
})

app.on('window-all-closed', () => {
  debugLog('app.window-all-closed')
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => debugLog('app.will-quit'))
app.on('quit', (_event, exitCode) => debugLog('app.quit', { exitCode }))
