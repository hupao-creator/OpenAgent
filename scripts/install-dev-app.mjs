#!/usr/bin/env node

import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultDevAppPath, installDevApp } from './dev-app-lib.mjs'

if (process.platform !== 'darwin') {
  throw new Error('OpenAgent Dev.app installer currently supports macOS only')
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const requireFromDesktop = createRequire(resolve(repoRoot, 'apps/desktop/package.json'))
const electronExecutablePath = requireFromDesktop('electron')
const destinationPath = process.env.OPENAGENT_DEV_APP_PATH?.trim() || defaultDevAppPath()

const installedPath = await installDevApp({
  repoRoot,
  electronExecutablePath,
  destinationPath
})

console.info(`OpenAgent development app installed at ${installedPath}`)
console.info('Run pnpm dev, then open the app from Finder or the Dock.')
