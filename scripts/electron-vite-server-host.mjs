#!/usr/bin/env node

import process from 'node:process'

const appPath = process.env.OPENAGENT_DEV_APP_PATH || '~/Applications/OpenAgent Dev.app'
console.info(`[dev] Electron auto-launch is disabled; open ${appPath}`)

process.once('SIGINT', () => process.exit(0))
process.once('SIGTERM', () => process.exit(0))

// electron-vite expects its launched child to stay alive. Keeping this tiny Node
// host alive preserves main/preload watchers without owning the real Dev App.
setInterval(() => undefined, 2_147_483_647)
