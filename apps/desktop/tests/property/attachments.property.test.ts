import { access, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import fc from 'fast-check'
import { expect, it } from 'vitest'
import type { AgentInput } from '@openagent/contracts'
import { AttachmentRepository } from '../../src/main/services/attachment-repository'
import type { AgentAttachment } from '../../src/shared/attachments'
import { checkAsync, sequenceLength } from './check'

// Plain arrays keep the shrunk event order in M1's counterexample/replay output.
// No scheduler or fc.commands: replayPath is null. Every operation is awaited.
const owner = fc.constantFrom('agent', 'bart', 'fork', 'other')
const slot = fc.nat({ max: 7 })
const operation = fc.oneof(
  fc.record({ kind: fc.constant('stage' as const), bytes: fc.uint8Array({ minLength: 1, maxLength: 16 }), old: fc.boolean() }),
  fc.record({ kind: fc.constantFrom('retain' as const, 'send' as const), owner, slot }),
  fc.record({ kind: fc.constant('fork' as const), source: owner, target: owner }),
  fc.record({ kind: fc.constantFrom('release' as const, 'delete' as const), owner }),
  fc.record({ kind: fc.constant('reset' as const), keep: fc.subarray(['agent', 'bart', 'fork', 'other']) }),
  fc.record({ kind: fc.constant('age' as const), slot, old: fc.boolean() }),
  fc.record({ kind: fc.constantFrom('reopen' as const, 'gc' as const) })
)
const sequence = fc.array(operation, { maxLength: sequenceLength(30) })
type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never
interface Entry {
  file: AgentAttachment
  bytes: Uint8Array
  owners: Set<string>
  present: boolean
  old: boolean
}
const oldDate = new Date('2000-01-01T00:00:00Z')
const youngDate = new Date('2100-01-01T00:00:00Z')
const input = (file: AgentAttachment): AgentInput => ({ parts: [{ kind: 'local-file', file }] })

async function sample(operations: Operation[], body: (fixture: {
  root: string; entries: Entry[]; repository: AttachmentRepository
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'openagent-attachment-property-'))
  let repository = new AttachmentRepository(root)
  const entries: Entry[] = []
  const select = (index: number) => {
    const present = entries.filter(entry => entry.present)
    return present.length ? present[index % present.length] : undefined
  }
  const stage = async (bytes: Uint8Array, old: boolean) => {
    const [file] = await repository.stage([{ source: 'bytes', bytes: Uint8Array.from(bytes).buffer,
      displayName: 'sample.bin' }])
    entries.push({ file, bytes, owners: new Set(), present: true, old })
    await utimes(dirname(file.path), old ? oldDate : youngDate, old ? oldDate : youngDate)
  }
  try {
    // Both an owned candidate and an orphan are available even to short sequences.
    await stage(Uint8Array.from([1]), true)
    await stage(Uint8Array.from([2]), false)
    for (const event of operations) {
      switch (event.kind) {
        case 'stage': await stage(event.bytes, event.old); break
        case 'retain':
        case 'send': {
          const entry = select(event.slot)
          if (!entry) break
          // This is the service's pre-native-I/O send seam. Canonicalization alone
          // is not ownership. Repeated sends must retain the accumulated union.
          const canonical = await repository.retainInput(event.owner, input(entry.file))
          expect(canonical.parts[0]).toMatchObject({ file: { id: entry.file.id } })
          entry.owners.add(event.owner)
          break
        }
        case 'fork':
          await repository.inheritOwners(event.source, event.target)
          for (const entry of entries) if (entry.owners.has(event.source)) entry.owners.add(event.target)
          break
        case 'release':
        case 'delete':
          // Caller has already committed deletion; native lifecycle is separate.
          await repository.releaseOwner(event.owner)
          for (const entry of entries) entry.owners.delete(event.owner)
          break
        case 'reset':
          await repository.retainOwners(event.keep)
          for (const entry of entries) for (const id of entry.owners) {
            if (!event.keep.includes(id)) entry.owners.delete(id)
          }
          break
        case 'reopen': repository = new AttachmentRepository(root); break
        case 'age': {
          const entry = select(event.slot)
          if (entry) {
            entry.old = event.old
            const date = event.old ? oldDate : youngDate
            await utimes(dirname(entry.file.path), date, date)
          }
          break
        }
        case 'gc':
          await repository.collectOrphans(1000)
          for (const entry of entries) if (entry.old && entry.owners.size === 0) entry.present = false
          break
      }
      await assertFiles(root, entries)
    }
    await body({ root, entries, repository })
  } finally {
    // Each run and each shrink/replay owns its directory; failures clean up too.
    await rm(root, { recursive: true, force: true })
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' })
  }
}

async function assertFiles(root: string, entries: Entry[]): Promise<void> {
  // These reads observe one settled operation. Drain every check before the next
  // operation or failure cleanup, while avoiding serial I/O for unrelated files.
  const checks = await Promise.allSettled(entries.map(async (entry, index) => {
    const manifest = join(root, '.metadata', `${entry.file.id}.json`)
    if (entry.present) {
      expect([...await readFile(entry.file.path)], `attachment ${index}, owners=${[...entry.owners]}`).toEqual([...entry.bytes])
      await expect(access(manifest)).resolves.toBeUndefined()
    } else {
      await expect(access(dirname(entry.file.path))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  }))
  for (const check of checks) if (check.status === 'rejected') throw check.reason
}

it('attachment owner sets protect files across serial operations and reopen', async () => {
  await checkAsync('attachment owner sets', fc.asyncProperty(sequence, async operations => {
    await sample(operations, async ({ root, entries, repository }) => {
      // Force an expired GC probe after every generated sequence so ownership
      // mistakes cannot hide behind a missing random GC or a young directory.
      for (const entry of entries.filter(entry => entry.present)) {
        await utimes(dirname(entry.file.path), oldDate, oldDate)
        entry.old = true
      }
      repository = new AttachmentRepository(root)
      await repository.collectOrphans(1000)
      for (const entry of entries) if (entry.owners.size === 0) entry.present = false
      await assertFiles(root, entries)
      await repository.retainOwners([])
      await repository.collectOrphans(1000)
      for (const entry of entries) entry.present = false
      await assertFiles(root, entries)
    })
  }))
}, 130_000)

const corruption = fc.constantFrom('missing', 'json', 'version', 'shape', 'owner', 'attachment', 'extra')
it('attachment invalid index fails closed after reopen', async () => {
  await checkAsync('attachment invalid index', fc.asyncProperty(sequence, corruption, async (operations, fault) => {
    await sample(operations, async ({ root, entries, repository }) => {
      // Always retain one real file before corrupting authority, even after a
      // generated sequence collected every previous entry.
      const [file] = await repository.stage([{ source: 'bytes', bytes: Uint8Array.from([3]).buffer, displayName: 'protected.bin' }])
      await repository.retainInput('agent', input(file))
      entries.push({ file, bytes: Uint8Array.from([3]), owners: new Set(['agent']), present: true, old: true })
      for (const entry of entries.filter(entry => entry.present)) await utimes(dirname(entry.file.path), oldDate, oldDate)
      const index = join(root, '.owners.json')
      const invalid: Record<Exclude<typeof fault, 'missing'>, string> = {
        json: '{broken', version: JSON.stringify({ version: 2, owners: {} }),
        shape: JSON.stringify({ version: 1, owners: [] }),
        owner: JSON.stringify({ version: 1, owners: { constructor: [file.id] } }),
        attachment: JSON.stringify({ version: 1, owners: { agent: ['not-an-attachment-id'] } }),
        extra: JSON.stringify({ version: 1, owners: {}, extra: true })
      }
      if (fault === 'missing') await rm(index)
      else await writeFile(index, invalid[fault])
      repository = new AttachmentRepository(root) // Drop the valid in-memory cache.
      await expect(repository.collectOrphans(0)).rejects.toThrow()
      await assertFiles(root, entries)
      // Reconciliation must not silently repair invalid authority to an empty set.
      await expect(repository.retainOwners([])).rejects.toThrow()
      await expect(repository.collectOrphans(0)).rejects.toThrow()
      await assertFiles(root, entries)
    })
  }))
}, 130_000)
