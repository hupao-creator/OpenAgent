import assert from 'node:assert/strict'
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEV_APP_BUNDLE_ID,
  DEV_APP_DISPLAY_NAME,
  DEV_APP_RUNTIME_NAME,
  installDevApp,
  rewriteDevAppInfoPlist
} from '../dev-app-lib.mjs'

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>NSCameraUsageDescription</key><string>This app needs access to the camera</string>
<key>NSMicrophoneUsageDescription</key><string>This app needs access to the microphone</string>
</dict></plist>`

test('installs a launchable development app tied to the repository', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'openagent-dev-app-test-'))
  context.after(async () => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  })
  const repoRoot = join(root, "repo with ' quote")
  const electronApp = join(root, 'Electron.app')
  const electronExecutablePath = join(electronApp, 'Contents', 'MacOS', 'Electron')
  const destinationPath = join(root, 'Applications', 'OpenAgent Dev.app')
  await Promise.all([
    mkdir(join(repoRoot, 'apps', 'desktop'), { recursive: true }),
    mkdir(join(electronApp, 'Contents', 'MacOS'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(repoRoot, 'apps', 'desktop', 'package.json'), '{}'),
    writeFile(join(electronApp, 'Contents', 'Info.plist'), INFO_PLIST),
    writeFile(electronExecutablePath, 'runtime')
  ])
  await chmod(electronExecutablePath, 0o755)
  let signedPath = ''

  const installed = await installDevApp({
    repoRoot,
    electronExecutablePath,
    destinationPath,
    copyBundle: (source, destination) => cp(source, destination, { recursive: true }),
    signBundle: async (path) => {
      signedPath = path
    }
  })

  assert.equal(installed, destinationPath)
  assert.match(signedPath, /\.openagent-dev-app-/)
  assert.equal(
    await readFile(join(destinationPath, 'Contents', 'MacOS', DEV_APP_RUNTIME_NAME), 'utf8'),
    'runtime'
  )
  const launcherPath = join(destinationPath, 'Contents', 'MacOS', DEV_APP_DISPLAY_NAME)
  const launcher = await readFile(launcherPath, 'utf8')
  assert.match(launcher, /OPENAGENT_DEV_APP='1'/)
  assert.match(launcher, /OPENAGENT_DEV_CWD='.*repo with '"'"' quote'/)
  assert.match(launcher, /http:\/\/localhost:5173/)
  assert.equal((await stat(launcherPath)).mode & 0o111, 0o111)

  const plist = await readFile(join(destinationPath, 'Contents', 'Info.plist'), 'utf8')
  assert.match(plist, new RegExp(`<string>${DEV_APP_BUNDLE_ID}</string>`))
  assert.match(plist, new RegExp(`<string>${DEV_APP_DISPLAY_NAME}</string>`))
  assert.doesNotMatch(plist, /NSCameraUsageDescription/)
  assert.doesNotMatch(plist, /This app needs access to the camera/)
  assert.doesNotMatch(plist, /NSMicrophoneUsageDescription/)
  assert.doesNotMatch(plist, /This app needs access to the microphone/)
})

test('requires all Electron plist identity fields', () => {
  assert.throws(
    () => rewriteDevAppInfoPlist('<plist><dict></dict></plist>'),
    /CFBundleDisplayName/
  )
})
