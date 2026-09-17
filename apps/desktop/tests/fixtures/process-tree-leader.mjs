import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const exitsBeforeCancel = process.argv[2] === '--exit-before-cancel'

const descendant = spawn(process.execPath, [
  '-e',
  `
    process.on('SIGTERM', () => undefined)
    process.send?.({ type: 'ready' })
    setInterval(() => undefined, 1_000)
  `
], {
  stdio: ['ignore', exitsBeforeCancel ? 'inherit' : 'ignore', 'ignore', 'ipc']
})

descendant.once('message', message => {
  if (message?.type !== 'ready') return
  process.stdout.write(`${descendant.pid}\n`)
  if (exitsBeforeCancel) {
    writeFileSync(process.argv[3], JSON.stringify({
      leaderPid: process.pid,
      descendantPid: descendant.pid
    }))
    process.exit(0)
  }
})

setInterval(() => undefined, 1_000)
