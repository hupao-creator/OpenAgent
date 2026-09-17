#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import process from 'node:process'
import { defaultDevAppPath } from './dev-app-lib.mjs'

if (process.platform !== 'darwin') {
  throw new Error('OpenAgent Dev.app launcher currently supports macOS only')
}

const appPath = process.env.OPENAGENT_DEV_APP_PATH?.trim() || defaultDevAppPath()
try {
  await access(appPath)
} catch {
  throw new Error(`OpenAgent Dev.app is not installed at ${appPath}; run pnpm dev:app:install`)
}

await new Promise((resolvePromise, reject) => {
  execFile('/usr/bin/open', [appPath], (error) => {
    if (error) reject(error)
    else resolvePromise()
  })
})
