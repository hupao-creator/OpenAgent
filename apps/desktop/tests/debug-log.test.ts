import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { debugLog, initDebugLog } from '@openagent/plugin-kit/main'

const roots: string[] = []

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'debug-log-'))
  roots.push(root)
  return root
}

afterEach(() => {
  // 让日志器回到 no-op，后续用例互不串扰
  initDebugLog(join(createRoot(), 'missing\0dir'))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('debug-log', () => {
  it('writes NDJSON lines with ts and evt into the launch file', async () => {
    const root = createRoot()
    const filePath = initDebugLog(root)
    expect(filePath).toBeDefined()
    debugLog('provider.session-opened', { threadId: 't1', sessionId: 's1' })
    debugLog('bart.tool-call', { bartRunId: 'r1' })
    let lines: Array<Record<string, unknown>> = []
    await vi.waitFor(() => {
      lines = readFileSync(filePath!, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(lines).toHaveLength(2)
    })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ evt: 'provider.session-opened', threadId: 't1', sessionId: 's1' })
    expect(typeof lines[0].ts).toBe('string')
    expect(lines[1]).toMatchObject({ evt: 'bart.tool-call', bartRunId: 'r1' })
  })

  it('prunes launch files older than the seven-day retention limit', () => {
    const root = createRoot()
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    for (let index = 0; index < 12; index += 1) {
      const path = join(root, `openagent-2026-01-01T00-00-${String(index).padStart(2, '0')}-old.jsonl`)
      writeFileSync(path, '')
      if (index < 3) utimesSync(path, expiredAt, expiredAt)
    }
    initDebugLog(root)
    const remaining = readdirSync(root).filter((name) => name.startsWith('openagent-'))
    expect(remaining).toHaveLength(10)
    expect(remaining.sort()[0]).not.toContain('00-00-00')
  })

  it('degrades to a no-op when the directory cannot be created', () => {
    const root = createRoot()
    const blocker = join(root, 'blocked')
    writeFileSync(blocker, '')
    expect(initDebugLog(join(blocker, 'nested'))).toBeUndefined()
    expect(() => debugLog('app.started')).not.toThrow()
  })

})
