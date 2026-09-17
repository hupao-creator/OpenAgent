import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

if (process.argv[2] === 'grandchild') {
  process.on('SIGTERM', () => undefined)
  process.send?.('ready')
  setInterval(() => undefined, 1_000)
} else {
  const fixturePath = fileURLToPath(import.meta.url)
  const grandchild = spawn(process.execPath, [fixturePath, 'grandchild'], {
    detached: false,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  const pidFile = process.env.OPENAGENT_TEST_HEADLESS_PID_FILE
  if (!pidFile) throw new Error('OPENAGENT_TEST_HEADLESS_PID_FILE is required')
  writeFileSync(pidFile, JSON.stringify({
    leaderPid: process.pid,
    grandchildPid: grandchild.pid
  }))

  process.on('SIGTERM', () => process.exit(0))
  grandchild.once('message', () => {
    const mode = process.env.OPENAGENT_TEST_HEADLESS_MODE
    if (mode === 'ready') {
      process.stdout.write(
        'OpenAgent headless control listening on http://127.0.0.1:43123\n'
      )
    } else if (mode === 'exit-before-ready') {
      setTimeout(() => process.exit(17), 25)
    }
  })
  setInterval(() => undefined, 1_000)
}
