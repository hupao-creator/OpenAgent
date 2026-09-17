import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('native acceptance transparent executable recorder', () => {
  it('preserves the Pi duplex bridge without recording its private payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-native-bridge-recorder-'))
    let child
    try {
      const evidencePath = join(root, 'events.jsonl')
      const script = fileURLToPath(new URL('./harness-injection-native-executable.mjs', import.meta.url))
      const executableScript = [
        "const net = require('node:net');",
        "const bridge = new net.Socket({ fd: 3, readable: true, writable: true });",
        "bridge.once('data', data => bridge.end('reply:' + data));",
        "bridge.on('end', () => process.exit(0));"
      ].join('\n')
      child = spawn(process.execPath, [script, '--preserve-fd3', process.execPath, evidencePath, '-e', executableScript], {
        stdio: ['pipe', 'pipe', 'pipe', 'pipe']
      })
      child.stdout.resume()
      child.stderr.resume()
      const closed = new Promise((resolve, reject) => {
        child.once('close', code => resolve(code))
        child.once('error', reject)
      })
      const received = new Promise((resolve, reject) => {
        child.stdio[3].once('data', data => resolve(data.toString()))
        child.stdio[3].once('error', reject)
      })
      child.stdio[3].write('private-bridge-receipt')
      expect(await received).toBe('reply:private-bridge-receipt')
      child.stdio[3].end()
      expect(await closed).toBe(0)
      expect(await readFile(evidencePath, 'utf8')).not.toContain('private-bridge-receipt')
    } finally {
      child?.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])('forwards real process input/output/exit without a bridge (Pi recorder=%s)', async preserveBridge => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-native-recorder-'))
    try {
      const evidencePath = join(root, 'events.jsonl')
      const script = fileURLToPath(new URL('./harness-injection-native-executable.mjs', import.meta.url))
      const input = 'a unique input with spaces\n'
      const executableScript = [
        "process.stdin.setEncoding('utf8');",
        "let input=''; process.stdin.on('data', chunk => input += chunk);",
        "process.stdin.on('end', () => { process.stdout.write(input.toUpperCase());",
        "process.stderr.write('native stderr'); process.exitCode = 7; });"
      ].join('\n')
      const child = spawn(process.execPath, [script, ...(preserveBridge ? ['--preserve-fd3'] : []), process.execPath, evidencePath, '-e', executableScript], {
        stdio: ['pipe', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const closed = new Promise((resolve, reject) => {
        child.once('close', code => resolve(code))
        child.once('error', reject)
      })
      child.stdin.end(input)
      expect(await closed).toBe(7)
      expect(stdout).toBe(input.toUpperCase())
      expect(stderr).toBe('native stderr')
      const events = (await readFile(evidencePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const started = events.find(event => event.type === 'spawn')
      const exited = events.find(event => event.type === 'exit')
      expect(started).toMatchObject({ executable: process.execPath, pid: expect.any(Number), wrapperPid: child.pid })
      expect(exited).toMatchObject({ pid: started.pid, code: 7 })
      expect(events.filter(event => event.direction === 'stdin').map(event => event.text).join('')).toBe(input)
      expect(events.filter(event => event.direction === 'stdout').map(event => event.text).join('')).toBe(stdout)
      expect(() => process.kill(started.pid, 0)).toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
