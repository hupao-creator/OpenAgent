import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadNativeTestAdapters } from '@openagent/test-kit'
import { HARNESS_IDS } from '../src/shared/harnesses'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('native test adapter registry', () => {
  it('loads an adapter for every registered Harness declared as a Desktop dependency', async () => {
    const adapters = await loadNativeTestAdapters({ workspaceRoot: join(import.meta.dirname, '..') })
    expect(Object.keys(adapters).sort()).toEqual([...HARNESS_IDS].sort())
    for (const harnessId of HARNESS_IDS) {
      expect(adapters[harnessId].id).toBe(harnessId)
      expect(adapters[harnessId].descriptor.id).toBe(harnessId)
      expect(adapters[harnessId].scenarioCapabilities.length).toBeGreaterThan(0)
      expect(typeof adapters[harnessId].nativeSessionIdentity).toBe('function')
      expect(typeof adapters[harnessId].nativeModelEvidence).toBe('function')
    }
  })

  it('names the missing Harness instead of silently skipping it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-adapter-registry-'))
    directories.push(root)
    await mkdir(join(root, 'node_modules', '@openagent'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'openagent-adapter-registry-fixture',
      private: true,
      dependencies: { '@openagent/harness-ghost': 'workspace:*' }
    }))
    await expect(loadNativeTestAdapters({ workspaceRoot: root }))
      .rejects.toThrow(/harness-ghost.*test-support/s)
  })
})
