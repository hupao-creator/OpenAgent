#!/usr/bin/env node
/** Transparent native CLI recorder: forwards the real process unchanged. */
import { spawn } from 'node:child_process'
import { appendFileSync, fstatSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

const recorderArguments = process.argv.slice(2)
const preserveBridge = recorderArguments[0] === '--preserve-fd3'
if (preserveBridge) recorderArguments.shift()
const [executable, evidencePath, ...arguments_] = recorderArguments
// Pi's bridge is one inherited duplex socket. Version probes have no bridge.
let bridgeFd
if (preserveBridge) {
  try { if (fstatSync(3).isSocket()) bridgeFd = 3 } catch { /* No bridge for this invocation. */ }
}
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key) && value)
  .map(([, value]) => value)
const record = value => {
  let encoded = JSON.stringify({ at: Date.now(), wrapperPid: process.pid, ...value })
  for (const secret of secrets) encoded = encoded.replaceAll(secret, '[REDACTED]')
  appendFileSync(evidencePath, encoded + '\n')
}
// Preserve complete native lines before redaction: a key may cross pipe chunks.
function recordStream(stream, direction) {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  stream.on('data', chunk => {
    pending += decoder.write(chunk)
    const end = pending.lastIndexOf('\n') + 1
    if (end) {
      record({ type: 'protocol', direction, text: pending.slice(0, end) })
      pending = pending.slice(end)
    }
  })
  stream.on('end', () => {
    pending += decoder.end()
    if (pending) record({ type: 'protocol', direction, text: pending })
  })
}
const child = spawn(executable, arguments_, {
  env: process.env,
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe', ...(bridgeFd === undefined ? [] : [bridgeFd])]
})
record({ type: 'spawn', pid: child.pid, executable, arguments: arguments_ })
recordStream(process.stdin, 'stdin')
process.stdin.pipe(child.stdin)
// A native process may close stdin before its parent notices completion.
child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error })
recordStream(child.stdout, 'stdout')
recordStream(child.stderr, 'stderr')
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', error => {
  record({ type: 'error', message: error.message })
  process.stderr.write(error.message + '\n')
  process.exitCode = 1
})
child.on('close', (code, signal) => {
  record({ type: 'exit', pid: child.pid, code, signal })
  process.stdin.unpipe(child.stdin)
  process.stdin.destroy()
  process.exitCode = code ?? 1
})
