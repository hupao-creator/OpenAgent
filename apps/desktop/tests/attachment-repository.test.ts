import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AttachmentRepository,
  MAX_BYTES_IMPORT_BYTES
} from '../src/main/services/attachment-repository'
import type { BartAttachmentImport } from '../src/shared/attachments'
import type { AgentInput } from '@openagent/contracts'

const temporaryDirectories: string[] = []

async function createFixture(): Promise<{
  directory: string
  root: string
  store: AttachmentRepository
}> {
  const directory = await mkdtemp(join(tmpdir(), 'openagent-bart-attachments-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'bart-workspace', '.openagent', 'attachments')
  return { directory, root, store: new AttachmentRepository(root) }
}

function arrayBuffer(bytes: number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('AttachmentRepository', () => {
  it('copies path-backed files into a private managed directory without changing the source', async () => {
    const { directory, root, store } = await createFixture()
    const source = join(directory, 'original.txt')
    await writeFile(source, 'original contents', 'utf8')

    const [attachment] = await store.stage([{
      source: 'path',
      path: source,
      displayName: '../资料\\report.png'
    }])

    expect(attachment).toMatchObject({
      name: 'report.txt',
      mimeType: 'text/plain',
      size: 17,
      kind: 'document'
    })
    expect(store.isManagedPath(attachment.path)).toBe(true)
    expect(store.isManagedPath(join(directory, 'attachments-elsewhere', 'file.txt'))).toBe(false)
    expect(await readFile(attachment.path, 'utf8')).toBe('original contents')
    expect(await readFile(source, 'utf8')).toBe('original contents')
    if (process.platform !== 'win32') {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(dirname(attachment.path))).mode & 0o777).toBe(0o700)
      expect((await stat(attachment.path)).mode & 0o777).toBe(0o600)
    }
  })

  it('sniffs bytes-backed images and gives their staged files a controlled extension', async () => {
    const { store } = await createFixture()
    const [png, jpeg, spoofed] = await store.stage([
      {
        source: 'bytes',
        bytes: arrayBuffer([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
        displayName: '../截图/屏幕截图.txt'
      },
      {
        source: 'bytes',
        bytes: arrayBuffer([0xff, 0xd8, 0xff, 0xe0, 1]),
        displayName: 'photo'
      },
      {
        source: 'bytes',
        bytes: arrayBuffer([1, 2, 3, 4]),
        displayName: 'pretend.png'
      }
    ])

    expect(png).toMatchObject({ name: '屏幕截图.png', mimeType: 'image/png', kind: 'image' })
    expect(jpeg).toMatchObject({ name: 'photo.jpg', mimeType: 'image/jpeg', kind: 'image' })
    expect(spoofed).toMatchObject({
      name: 'pretend.bin',
      mimeType: 'application/octet-stream',
      kind: 'file'
    })
    expect([...await readFile(png.path)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1
    ])
  })

  it('rejects invalid sources, oversized bytes, malformed buffers, and too many imports', async () => {
    const { directory, store } = await createFixture()
    const sourceDirectory = join(directory, 'not-a-file')
    await mkdir(sourceDirectory)

    await expect(store.stage([{
      source: 'path', path: 'relative.txt', displayName: 'relative.txt'
    }])).rejects.toThrow('附件路径无效')
    await expect(store.stage([{
      source: 'path', path: sourceDirectory, displayName: 'folder'
    }])).rejects.toThrow('不存在或不是文件')
    await expect(store.stage([{
      source: 'bytes',
      bytes: new ArrayBuffer(MAX_BYTES_IMPORT_BYTES + 1),
      displayName: 'large.bin'
    }])).rejects.toThrow('不能超过 20 MB')
    await expect(store.stage([{
      source: 'bytes',
      bytes: { byteLength: 4 } as ArrayBuffer,
      displayName: 'forged.bin'
    }])).rejects.toThrow('附件内容缺失')

    const tooMany: BartAttachmentImport[] = Array.from({ length: 21 }, (_, index) => ({
      source: 'bytes',
      bytes: arrayBuffer([index]),
      displayName: `${index}.bin`
    }))
    await expect(store.stage(tooMany)).rejects.toThrow('附件数量不能超过 20 个')
  })

  it('rejects a batch whose aggregate size exceeds 100 MB before copying it', async () => {
    const { directory, store } = await createFixture()
    const imports: BartAttachmentImport[] = []
    for (let index = 0; index < 3; index += 1) {
      const source = join(directory, `sparse-${index}.bin`)
      await writeFile(source, '')
      await truncate(source, 40 * 1024 * 1024)
      imports.push({ source: 'path', path: source, displayName: `sparse-${index}.bin` })
    }

    await expect(store.stage(imports)).rejects.toThrow('附件总大小不能超过 100 MB')
  })

  it('rebuilds attachment metadata from the staged file at the send boundary', async () => {
    const { directory, store } = await createFixture()
    const source = join(directory, 'facts.txt')
    await writeFile(source, 'trusted bytes', 'utf8')
    const [attachment] = await store.stage([{
      source: 'path', path: source, displayName: 'facts.txt'
    }])
    const canonicalPath = await realpath(attachment.path)

    const canonical = await store.canonicalizeInput({
      parts: [{
        kind: 'image',
        detail: 'original',
        file: {
          id: 'forged',
          path: canonicalPath,
          name: 'forged.png',
          mimeType: 'image/png',
          size: 1
        }
      }]
    })

    expect(canonical).toEqual({
      parts: [{
        kind: 'local-file',
        file: {
          id: attachment.id,
          path: canonicalPath,
          name: 'facts.txt',
          mimeType: 'text/plain',
          size: 13
        }
      }]
    })
  })

  it('rejects deleted, replaced, and symlinked staged files at the send boundary', async () => {
    const { directory, store } = await createFixture()
    const source = join(directory, 'source.txt')
    await writeFile(source, 'original', 'utf8')
    const stage = async () => (await store.stage([{
      source: 'path' as const, path: source, displayName: 'source.txt'
    }]))[0]
    const input = (path: string): AgentInput => ({
      parts: [{
        kind: 'local-file',
        file: { id: 'ignored', path, name: 'ignored', mimeType: 'x/fake', size: 0 }
      }]
    })

    const deleted = await stage()
    await rm(deleted.path)
    await expect(store.canonicalizeInput(input(deleted.path)))
      .rejects.toThrow('不存在、已替换或不是普通文件')

    const replaced = await stage()
    await writeFile(replaced.path, 'replacement', 'utf8')
    await expect(store.canonicalizeInput(input(replaced.path)))
      .rejects.toThrow('staging 后已被替换')

    const linked = await stage()
    const outside = join(directory, 'outside.txt')
    await writeFile(outside, 'outside', 'utf8')
    await rm(linked.path)
    await symlink(outside, linked.path)
    await expect(store.canonicalizeInput(input(linked.path)))
      .rejects.toThrow('不存在、已替换或不是普通文件')
  })

  it('enforces the 20-file limit again at the authoritative send boundary', async () => {
    const { store } = await createFixture()
    const forged: AgentInput = {
      parts: Array.from({ length: 21 }, (_, index) => ({
        kind: 'local-file' as const,
        file: {
          id: String(index), path: `/forged/${index}`, name: String(index),
          mimeType: 'application/octet-stream', size: 0
        }
      }))
    }
    await expect(store.canonicalizeInput(forged)).rejects.toThrow('不能超过 20 个')
  })

  it('removes expired unreferenced staging entries while preserving live attachments', async () => {
    const { root, store } = await createFixture()
    const [live, orphan] = await store.stage([
      { source: 'bytes', bytes: arrayBuffer([1]), displayName: 'live.bin' },
      { source: 'bytes', bytes: arrayBuffer([2]), displayName: 'orphan.bin' }
    ])
    const unmanaged = join(root, 'keep-me')
    await mkdir(unmanaged)
    const old = new Date(Date.now() - 10_000)
    await Promise.all([
      utimes(dirname(live.path), old, old),
      utimes(dirname(orphan.path), old, old),
      utimes(unmanaged, old, old)
    ])

    await store.retainInput('agent-owner', attachmentInput(live))
    await store.collectOrphans(1_000)

    await expect(access(live.path)).resolves.toBeUndefined()
    await expect(access(orphan.path)).rejects.toThrow()
    await expect(access(unmanaged)).resolves.toBeUndefined()
  })

})

function attachmentInput(file: { id: string; path: string; name: string; mimeType: string; size: number }): AgentInput {
  return { parts: [{ kind: 'local-file', file }] }
}

it('retains Agent and fork owners across restart and releases files only after the last owner disappears', async () => {
  const { root, store } = await createFixture()
  const [attachment] = await store.stage([{
    source: 'bytes', bytes: arrayBuffer([1, 2]), displayName: 'shared.bin'
  }])
  const old = new Date(Date.now() - 10_000)
  await utimes(dirname(attachment.path), old, old)
  await store.retainInput('agent', attachmentInput(attachment))
  await store.retainInput('bart', attachmentInput(attachment))
  await store.inheritOwners('agent', 'fork')

  const restarted = new AttachmentRepository(root)
  await restarted.retainOwners(['agent', 'bart', 'fork'])
  await restarted.releaseOwner('bart')
  await restarted.releaseOwner('agent')
  await restarted.collectOrphans(1_000)
  await expect(access(attachment.path)).resolves.toBeUndefined()

  await restarted.releaseOwner('fork')
  await restarted.collectOrphans(1_000)
  await expect(access(attachment.path)).rejects.toThrow()
})

it('reconciles deleted Thread owners at restart without removing live Agent references', async () => {
  const { root, store } = await createFixture()
  const [live, discarded] = await store.stage([
    { source: 'bytes', bytes: arrayBuffer([1]), displayName: 'live.bin' },
    { source: 'bytes', bytes: arrayBuffer([2]), displayName: 'discarded.bin' }
  ])
  await store.retainInput('live', attachmentInput(live))
  await store.retainInput('deleted', attachmentInput(discarded))
  const old = new Date(Date.now() - 10_000)
  await Promise.all([live, discarded].map(file => utimes(dirname(file.path), old, old)))
  const restarted = new AttachmentRepository(root)
  await restarted.retainOwners(['live'])
  await restarted.collectOrphans(1_000)
  await expect(access(live.path)).resolves.toBeUndefined()
  await expect(access(discarded.path)).rejects.toThrow()
})

it('fails closed on an invalid ownership index instead of treating owned files as orphans', async () => {
  const { root, store } = await createFixture()
  const [attachment] = await store.stage([{
    source: 'bytes', bytes: arrayBuffer([1]), displayName: 'retained.bin'
  }])
  await writeFile(join(root, '.owners.json'), '{broken')
  await expect(new AttachmentRepository(root).collectOrphans(0)).rejects.toThrow()
  await expect(access(attachment.path)).resolves.toBeUndefined()
})

it('preserves canonical files when a previously established owner index is missing', async () => {
  const { root, store } = await createFixture()
  const [attachment] = await store.stage([{
    source: 'bytes', bytes: arrayBuffer([1]), displayName: 'retained.bin'
  }])
  await store.retainInput('agent', attachmentInput(attachment))
  await rm(join(root, '.owners.json'))
  await expect(new AttachmentRepository(root).collectOrphans(0)).rejects.toThrow('owner index 缺失')
  await expect(access(attachment.path)).resolves.toBeUndefined()
})
