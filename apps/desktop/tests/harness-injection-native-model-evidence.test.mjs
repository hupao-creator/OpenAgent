import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nativeModelEvidence } from './harness-injection-native.mjs'
import { nativeAdapter } from './bart-headless/providers.mjs'

/**
 * Generic runner responsibility only: reading the recorded protocol evidence
 * file and handing events to the owning Harness's adapter. Per-host frame
 * parsing knowledge lives in packages/harness-<id>/tests.
 */
describe('native model acceptance evidence', () => {
  it('reads recorded protocol files through the owning Harness adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openagent-native-model-proof-'))
    const protocol = join(root, 'protocol.jsonl')
    try {
      await writeFile(protocol, [
        { wrapperPid: 1, direction: 'stdin', text: '{"params":{"model":"requested-only"}}\n' },
        { wrapperPid: 1, direction: 'stdout', text: '{"id":1,"result":{"model":"native-' },
        { wrapperPid: 2, direction: 'stdout', text: 'a version line\n' },
        { wrapperPid: 1, direction: 'stdout', text: 'actual"}}\n' }
      ].map(event => JSON.stringify(event)).join('\n') + '\n')
      expect(await nativeModelEvidence(nativeAdapter('codex'), protocol)).toEqual(['native-actual'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
