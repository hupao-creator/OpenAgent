import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'

it('imports byte-identical captures and leaves the catalog intact when observations mismatch', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'thread-lab-import-'))
  try {
    const file = resolve(dir, 'state.json')
    const manifest = resolve(dir, 'manifest.json')
    const output = resolve(dir, 'scenes')
    const bytes = JSON.stringify({ threads: [{ id: 'actual', harnessId: 'codex', observation: { latestExecution: { status: 'completed' } } }] }, null, 2) + '\n'
    await writeFile(file, bytes)
    const entry = { harness: 'codex', scenario: 'completed', threadId: 'actual', file }
    await writeFile(manifest, JSON.stringify([entry]))
    const run = () => execFileSync(process.execPath, [resolve('playgrounds/single-thread/import-scenarios.mjs'), manifest], {
      env: { ...process.env, OPENAGENT_THREAD_LAB_SNAPSHOTS: output }, stdio: 'pipe'
    })
    run()
    const hash = createHash('sha256').update(bytes).digest('hex')
    expect(await readFile(resolve(output, `${hash}.json`), 'utf8')).toBe(bytes)
    const catalog = await readFile(resolve(output, 'cases.json'), 'utf8')
    expect(JSON.parse(catalog).cases[0].snapshot).toBe(hash)
    await writeFile(manifest, JSON.stringify([{ ...entry, scenario: 'question' }]))
    expect(run).toThrow()
    expect(await readFile(resolve(output, 'cases.json'), 'utf8')).toBe(catalog)
    await writeFile(manifest, JSON.stringify([{ ...entry, harness: 'invented' }]))
    expect(run).toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
