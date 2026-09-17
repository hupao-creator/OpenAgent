import { execFile } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const DEV_APP_BUNDLE_NAME = 'OpenAgent Dev.app'
export const DEV_APP_DISPLAY_NAME = 'OpenAgent Dev'
export const DEV_APP_BUNDLE_ID = 'com.openagent.desktop.dev'
export const DEV_APP_RUNTIME_NAME = 'OpenAgent Dev Runtime'
export function defaultDevAppPath(homeDirectory = homedir()) {
  return join(homeDirectory, 'Applications', DEV_APP_BUNDLE_NAME)
}

export function resolveElectronAppPath(electronExecutablePath) {
  const executable = resolve(electronExecutablePath)
  const appPath = dirname(dirname(dirname(executable)))
  if (!appPath.endsWith('.app')) {
    throw new Error(`Electron executable is not inside a macOS app bundle: ${executable}`)
  }
  return appPath
}

export function renderDevAppLauncher({
  repoRoot,
  rendererUrl = 'http://localhost:5173'
}) {
  const desktopRoot = join(resolve(repoRoot), 'apps', 'desktop')
  const lines = [
    '#!/bin/sh',
    'set -eu',
    'launcher_dir="$(CDPATH= cd "$(dirname "$0")" && pwd -P)"',
    'unset ELECTRON_RUN_AS_NODE',
    `export OPENAGENT_DEV_APP=${shellQuote('1')}`,
    `export OPENAGENT_DEV_CWD=${shellQuote(resolve(repoRoot))}`,
    `export NODE_ENV_ELECTRON_VITE=${shellQuote('development')}`,
    `export ELECTRON_RENDERER_URL="\${OPENAGENT_DEV_RENDERER_URL:-${rendererUrl}}"`
  ]
  lines.push(`exec "$launcher_dir/${DEV_APP_RUNTIME_NAME}" ${shellQuote(desktopRoot)}`, '')
  return lines.join('\n')
}

export function rewriteDevAppInfoPlist(source) {
  const values = {
    CFBundleDisplayName: DEV_APP_DISPLAY_NAME,
    CFBundleExecutable: DEV_APP_DISPLAY_NAME,
    CFBundleIdentifier: DEV_APP_BUNDLE_ID,
    CFBundleName: DEV_APP_DISPLAY_NAME
  }
  let result = source
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)[^<]*(</string>)`)
    if (!pattern.test(result)) throw new Error(`Electron Info.plist is missing ${key}`)
    result = result.replace(pattern, `$1${escapeXml(value)}$2`)
  }
  return removeMediaUsageDescriptionsFromPlist(result)
}

export function removeMediaUsageDescriptionsFromPlist(source) {
  let result = source
  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription']) {
    const pattern = new RegExp(
      `<key>${escapeRegExp(key)}</key>\\s*<string>[^<]*</string>`,
      'g'
    )
    result = result.replace(pattern, '')
  }
  return result
}

export async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  )
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const plist = await readFile(plistPath, 'utf8')
  await writeFile(plistPath, removeMediaUsageDescriptionsFromPlist(plist), 'utf8')
}

export async function installDevApp({
  repoRoot,
  electronExecutablePath,
  destinationPath = defaultDevAppPath(),
  copyBundle = copyElectronBundle,
  signBundle = adHocSignBundle
}) {
  const destination = resolve(destinationPath)
  if (!destination.endsWith('.app')) {
    throw new Error(`Development app destination must end in .app: ${destination}`)
  }
  const sourceApp = resolveElectronAppPath(electronExecutablePath)
  const sourceRuntimeName = basename(electronExecutablePath)
  const destinationParent = dirname(destination)
  await Promise.all([
    access(join(sourceApp, 'Contents', 'Info.plist')),
    access(join(sourceApp, 'Contents', 'MacOS', sourceRuntimeName)),
    access(join(resolve(repoRoot), 'apps', 'desktop', 'package.json')),
    mkdir(destinationParent, { recursive: true })
  ])

  const stagingRoot = await mkdtemp(join(destinationParent, '.openagent-dev-app-'))
  const stagedApp = join(stagingRoot, DEV_APP_BUNDLE_NAME)
  const previousApp = join(stagingRoot, 'previous.app')
  let previousMoved = false
  try {
    await copyBundle(sourceApp, stagedApp)
    await prepareCopiedDevApp({
      appPath: stagedApp,
      sourceRuntimeName,
      repoRoot
    })
    await signBundle(stagedApp)

    if (await pathExists(destination)) {
      await rename(destination, previousApp)
      previousMoved = true
    }
    try {
      await rename(stagedApp, destination)
    } catch (error) {
      if (previousMoved) await rename(previousApp, destination).catch(() => undefined)
      throw error
    }
    return destination
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}

export async function prepareCopiedDevApp({
  appPath,
  sourceRuntimeName,
  repoRoot
}) {
  const contentsPath = join(appPath, 'Contents')
  const macosPath = join(contentsPath, 'MacOS')
  const sourceRuntimePath = join(macosPath, sourceRuntimeName)
  const runtimePath = join(macosPath, DEV_APP_RUNTIME_NAME)
  const launcherPath = join(macosPath, DEV_APP_DISPLAY_NAME)
  const plistPath = join(contentsPath, 'Info.plist')

  await rename(sourceRuntimePath, runtimePath)
  await writeFile(
    launcherPath,
    renderDevAppLauncher({
      repoRoot
    }),
    'utf8'
  )
  await chmod(launcherPath, 0o755)
  const plist = await readFile(plistPath, 'utf8')
  await writeFile(plistPath, rewriteDevAppInfoPlist(plist), 'utf8')
}

export async function copyElectronBundle(source, destination) {
  if (process.platform === 'darwin') {
    await runFile('/usr/bin/ditto', ['--noqtn', source, destination])
    return
  }
  await cp(source, destination, { recursive: true, preserveTimestamps: true })
}

export async function adHocSignBundle(appPath) {
  if (process.platform !== 'darwin') return
  // Electron runtimes copied from long-lived worktrees can carry Finder metadata
  // or resource forks that make codesign reject an otherwise valid bundle.
  await runFile('/usr/bin/xattr', ['-cr', appPath])
  await runFile('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
  await runFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath])
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function runFile(command, args) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed: ${(stderr || stdout || error.message).trim()}`))
        return
      }
      resolvePromise()
    })
  })
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
