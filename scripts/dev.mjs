#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultDevAppPath } from './dev-app-lib.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = resolve(repoRoot, 'apps/desktop')
const forwardedArgs = process.argv.slice(2)
if (forwardedArgs[0] === '--') forwardedArgs.shift()
// The persistent launcher is a macOS app bundle. Windows and Linux must let
// electron-vite launch Electron directly or `pnpm dev` would start only the
// renderer server with no usable desktop window.
const electronFlags = new Set(['electron', '--electron'])
const launchElectron = process.platform !== 'darwin' || forwardedArgs.some((arg) => electronFlags.has(arg))
const desktopArgs = forwardedArgs.filter((arg) => !electronFlags.has(arg))
const devAppPath = process.env.OPENAGENT_DEV_APP_PATH?.trim() || defaultDevAppPath()

runDev({
  repoRoot,
  desktopRoot,
  launchElectron,
  devAppPath
}, desktopArgs)

function runDev(options, desktopArgs) {
  const children = new Map()
  const processGroups = new Set()
  let shuttingDown = false
  let exitCode = 0
  let forceTimer

  const killProcessGroups = () => {
    for (const processGroup of processGroups) {
      try {
        process.kill(-processGroup, 'SIGKILL')
      } catch {
        // The complete process group already exited during the grace period.
      }
    }
  }

  const finishIfStopped = () => {
    if (!shuttingDown || children.size > 0) return
    if (process.platform !== 'win32' && hasLiveProcessGroups(processGroups)) return
    if (forceTimer) clearTimeout(forceTimer)
    process.exit(exitCode)
  }

  const stopChild = (child, signal) => {
    if (!child.pid) return
    if (process.platform === 'win32') {
      if (child.exitCode !== null || child.signalCode !== null) return
      const killer = execFile(
        'taskkill',
        ['/pid', String(child.pid), '/T', '/F'],
        { windowsHide: true },
        () => undefined
      )
      killer.unref()
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal)
    }
  }

  const shutdown = (code, signal = 'SIGTERM') => {
    if (shuttingDown) return
    shuttingDown = true
    exitCode = code
    for (const child of children.values()) stopChild(child, signal)
    forceTimer = setTimeout(() => {
      if (process.platform === 'win32') {
        for (const child of children.values()) stopChild(child, 'SIGKILL')
      } else {
        killProcessGroups()
      }
      process.exit(exitCode)
    }, 5_000)
    forceTimer.unref()
    finishIfStopped()
  }

  const start = (name, args, environment = process.env) => {
    const invocation = pnpmInvocation(args)
    console.info(`[dev] starting ${name}`)
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.repoRoot,
      env: environment,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    if (child.pid && process.platform !== 'win32') processGroups.add(child.pid)
    children.set(name, child)
    child.once('error', (error) => {
      console.error(`[dev] failed to start ${name}: ${error.message}`)
      shutdown(1)
    })
    child.once('exit', (code, signal) => {
      children.delete(name)
      if (!shuttingDown) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`
        console.info(`[dev] ${name} exited with ${detail}`)
        shutdown(code ?? 1)
      }
      finishIfStopped()
    })
  }

  process.on('SIGINT', () => shutdown(130, 'SIGINT'))
  process.on('SIGTERM', () => shutdown(143, 'SIGTERM'))
  process.on('SIGHUP', () => shutdown(129, 'SIGHUP'))
  process.on('exit', () => {
    if (process.platform !== 'win32') killProcessGroups()
  })

  const desktopEnvironment = {
    ...process.env,
    OPENAGENT_DEV_CWD: options.repoRoot
  }
  if (options.launchElectron) {
    desktopEnvironment.OPENAGENT_DEV_RESET_USER_DATA = '1'
  }
  if (!options.launchElectron) {
    Object.assign(desktopEnvironment, {
      ELECTRON_EXEC_PATH: process.execPath,
      ELECTRON_ENTRY: resolve(options.repoRoot, 'scripts/electron-vite-server-host.mjs'),
      OPENAGENT_DEV_APP: '1',
      OPENAGENT_DEV_APP_PATH: options.devAppPath
    })
    if (existsSync(options.devAppPath)) {
      console.info(`[dev] server-only mode; open ${options.devAppPath}`)
    } else {
      console.info('[dev] server-only mode; install the desktop launcher with pnpm dev:app:install')
    }
  }

  start(
    'OpenAgent',
    ['--dir', options.desktopRoot, 'dev', ...desktopArgs],
    desktopEnvironment
  )
}

function hasLiveProcessGroups(processGroups) {
  for (const processGroup of processGroups) {
    try {
      process.kill(-processGroup, 0)
      return true
    } catch {
      processGroups.delete(processGroup)
    }
  }
  return false
}

function pnpmInvocation(args) {
  const npmExecPath = process.env.npm_execpath
  if (npmExecPath && /pnpm(?:\.c?js)?$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] }
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    args
  }
}
