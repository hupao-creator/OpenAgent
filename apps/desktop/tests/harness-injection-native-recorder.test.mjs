import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('forwards native output while redacting credentials across recorded pipe chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-recorder-'))
  const secret = 'test-provider-key-for-recorder'
  const evidence = join(root, 'protocol.jsonl')
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      resolve('tests/harness-injection-native-executable.mjs'), process.execPath, evidence,
      '-e', 'const k=process.env.DEEPSEEK_API_KEY;process.stdout.write(k.slice(0,8));setTimeout(()=>process.stdout.write(k.slice(8)+"\\n"),20)',
      '--', secret
    ], { env: { ...process.env, DEEPSEEK_API_KEY: secret } })
    expect(stdout).toBe(secret + '\n')
    const recorded = await readFile(evidence, 'utf8')
    expect(recorded).not.toContain(secret)
    const events = recorded.trim().split('\n').map(JSON.parse)
    expect(events.find(event => event.type === 'spawn').arguments.at(-1)).toBe('[REDACTED]')
    expect(events.filter(event => event.direction === 'stdout').map(event => event.text).join('')).toBe('[REDACTED]\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})
