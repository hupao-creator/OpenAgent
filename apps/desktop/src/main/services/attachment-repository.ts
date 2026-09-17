import { createHash, randomUUID } from 'crypto'
import { createReadStream } from 'fs'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  rename,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile
} from 'fs/promises'
import { SerialQueue } from './serial-queue'
import { basename, extname, isAbsolute, join, relative, sep } from 'path'
import type { AgentInput, AgentInputPart } from '@openagent/contracts'
import type {
  AgentAttachment,
  BartAttachmentImport
} from '../../shared/attachments'
import {
  attachmentKindForMimeType,
  mimeTypeForPath
} from '../../shared/attachment-capabilities'

/** Bytes-backed clipboard blobs without a real disk path must be small; larger ones are asked to be saved first. */
export const MAX_BYTES_IMPORT_BYTES = 20 * 1024 * 1024
export const MAX_ATTACHMENT_MESSAGE_BYTES = 100 * 1024 * 1024
export const MAX_ATTACHMENT_MESSAGE_COUNT = 20
const MAX_DISPLAY_NAME_LENGTH = 120
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1_000
const MANAGED_ENTRY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OWNERS_FILE = '.owners.json'
const MANIFEST_DIRECTORY = '.metadata'

interface AttachmentManifest extends AgentAttachment {
  readonly sha256: string
}

/**
 * Core-owned canonical attachments shared by Bart and Agent Threads. Native
 * histories can retain paths for the lifetime of a Thread, independently of
 * the Bart transcript. Owners are persisted before crossing native I/O.
 */
export class AttachmentRepository {
  private readonly ownership = new SerialQueue()
  private owners: Record<string, string[]> | undefined

  constructor(private readonly root: string) {}

  /** Reconcile the current Thread catalog after load/reset; no Plugin history inspection. */
  retainOwners(threadIds: readonly string[]): Promise<void> {
    return this.ownership.run(async () => {
      const owners = await this.readOwners()
      const live = new Set(threadIds)
      await this.writeOwners(Object.fromEntries(
        Object.entries(owners).filter(([id]) => live.has(id))
      ))
    })
  }

  /** Record every accepted path before a Plugin can persist/reference it. */
  retainInput(threadId: string, input: AgentInput): Promise<AgentInput> {
    return this.ownership.run(async () => {
      assertOwnerId(threadId)
      const parts = input.parts.filter(isFilePart)
      if (!parts.length) return structuredClone(input)
      const canonical = await this.canonicalizeInput(input)
      const ids = canonical.parts.filter(isFilePart).map(part => part.file.id)
      const owners = await this.readOwners()
      await this.writeOwners({
        ...owners,
        [threadId]: [...new Set([...(Object.hasOwn(owners, threadId) ? owners[threadId] : []), ...ids])]
      })
      return canonical
    })
  }

  /** Forked native histories retain the source's canonical paths independently. */
  inheritOwners(sourceThreadId: string, threadId: string): Promise<void> {
    return this.ownership.run(async () => {
      assertOwnerId(sourceThreadId)
      assertOwnerId(threadId)
      const owners = await this.readOwners()
      if (!Object.hasOwn(owners, sourceThreadId) || !owners[sourceThreadId].length) return
      await this.writeOwners({
        ...owners,
        [threadId]: [...new Set([...(Object.hasOwn(owners, threadId) ? owners[threadId] : []), ...owners[sourceThreadId]])]
      })
    })
  }

  /** Called only after the Thread deletion/replacement is durable. */
  releaseOwner(threadId: string): Promise<void> {
    return this.ownership.run(async () => {
      const owners = await this.readOwners()
      if (!Object.hasOwn(owners, threadId)) return
      const next = { ...owners }
      delete next[threadId]
      await this.writeOwners(next)
    })
  }

  private async readOwners(): Promise<Record<string, string[]>> {
    if (this.owners) return this.owners
    const text = await readFile(join(this.root, OWNERS_FILE), 'utf8').catch(error => {
      if (isMissingPathError(error)) return null
      throw error
    })
    if (text === null) {
      const entries = await readdir(this.root).catch(error => {
        if (isMissingPathError(error)) return []
        throw error
      })
      if (entries.some(entry => MANAGED_ENTRY_PATTERN.test(entry))) {
        throw new Error('Attachment owner index 缺失；停止回收以保留附件')
      }
      return this.owners = {}
    }
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        Object.keys(value).length !== 2 || !('version' in value) || value.version !== 1 ||
        !('owners' in value) || typeof value.owners !== 'object' ||
        value.owners === null || Array.isArray(value.owners)) {
      throw new Error('Attachment owner index 不符合当前格式')
    }
    for (const [id, entries] of Object.entries(value.owners)) {
      assertOwnerId(id)
      if (!Array.isArray(entries) || entries.some(entry =>
        typeof entry !== 'string' || !MANAGED_ENTRY_PATTERN.test(entry))) {
        throw new Error('Attachment owner index 包含无效附件 ID')
      }
    }
    return this.owners = value.owners as Record<string, string[]>
  }

  private async writeOwners(owners: Record<string, string[]>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.root, `.owners-${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, owners }), 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, join(this.root, OWNERS_FILE))
      this.owners = owners
    } finally {
      await rm(temporary, { force: true })
    }
  }

  /**
   * Validate and persist untrusted renderer imports into the staging area.
   * Path-backed files are copied (original untouched); bytes-backed blobs are written.
   */
  async stage(imports: BartAttachmentImport[]): Promise<AgentAttachment[]> {
    if (imports.length > MAX_ATTACHMENT_MESSAGE_COUNT) throw new Error('附件数量不能超过 20 个')
    let totalBytes = 0
    for (const item of imports) {
      totalBytes += await this.validateImportSize(item)
      if (totalBytes > MAX_ATTACHMENT_MESSAGE_BYTES) throw new Error('附件总大小不能超过 100 MB')
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await chmod(this.root, 0o700)
    // Establish ownership authority before creating canonical files. A later
    // missing index is corruption, never evidence that those files are orphaned.
    await this.ownership.run(async () => this.writeOwners(await this.readOwners()))
    return Promise.all(imports.map((item) => this.stageOne(item)))
  }

  /**
   * Authoritative send boundary for GUI, headless, Bart, and direct follow-up.
   * Caller metadata is discarded; every managed file is re-opened and checked.
   */
  async canonicalizeInput(input: AgentInput): Promise<AgentInput> {
    const fileParts = input.parts.filter(isFilePart)
    if (fileParts.length > MAX_ATTACHMENT_MESSAGE_COUNT) {
      throw new Error('附件数量不能超过 20 个')
    }
    if (fileParts.length === 0) return structuredClone(input)

    const canonicalRoot = await realpath(this.root).catch(error => {
      throw new Error('Attachment repository 不可访问', { cause: error })
    })
    const seenIds = new Set<string>()
    let totalBytes = 0
    const canonicalParts: AgentInputPart[] = []
    for (const part of input.parts) {
      if (!isFilePart(part)) {
        canonicalParts.push(structuredClone(part))
        continue
      }
      const attachment = await this.canonicalizeFile(part.file.path, canonicalRoot)
      if (seenIds.has(attachment.id)) {
        throw new Error(`附件重复：${attachment.name}`)
      }
      seenIds.add(attachment.id)
      totalBytes += attachment.size
      if (totalBytes > MAX_ATTACHMENT_MESSAGE_BYTES) {
        throw new Error('附件总大小不能超过 100 MB')
      }
      const file = {
        id: attachment.id,
        path: attachment.path,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size
      }
      if (attachment.mimeType.startsWith('image/')) {
        canonicalParts.push({
          kind: 'image',
          file,
          ...(part.kind === 'image' && part.detail ? { detail: part.detail } : {})
        })
      } else if (attachment.mimeType.startsWith('audio/')) {
        canonicalParts.push({ kind: 'audio', file })
      } else {
        canonicalParts.push({ kind: 'local-file', file })
      }
    }
    return {
      parts: canonicalParts,
      ...(input.presentation ? { presentation: input.presentation } : {})
    }
  }

  /** True when `path` lives inside this store's controlled root. */
  isManagedPath(path: string): boolean {
    const relativePath = relative(this.root, path)
    return (
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath) &&
      relativePath !== ''
    )
  }

  /** Delete only expired files with zero durable Thread owners. */
  collectOrphans(ttlMs = ORPHAN_TTL_MS): Promise<void> {
    return this.ownership.run(async () => {
      if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('附件回收 TTL 无效')
      const owners = await this.readOwners()
      const liveEntries = new Set(Object.values(owners).flat())
      const entries = await readdir(this.root, { withFileTypes: true }).catch(error => {
        if (isMissingPathError(error)) return []
        throw error
      })
      const expiredBefore = Date.now() - ttlMs
      await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory() || !MANAGED_ENTRY_PATTERN.test(entry.name) ||
            liveEntries.has(entry.name)) return
        const entryPath = join(this.root, entry.name)
        const metadata = await stat(entryPath).catch(error => {
          if (isMissingPathError(error)) return null
          throw error
        })
        if (metadata && metadata.mtimeMs <= expiredBefore) {
          await rm(entryPath, { recursive: true, force: true })
          await rm(this.manifestPath(entry.name), { force: true })
        }
      }))
    })
  }

  private async stageOne(item: BartAttachmentImport): Promise<AgentAttachment> {
    if (item.source === 'path') {
      return this.stageFromPath(item)
    }
    return this.stageFromBytes(item)
  }

  private async validateImportSize(item: BartAttachmentImport): Promise<number> {
    if (item.source === 'path') {
      if (!isAbsolute(item.path) || item.path.includes('\0')) throw new Error('附件路径无效')
      const metadata = await stat(item.path).catch(() => null)
      if (!metadata?.isFile()) {
        throw new Error(`附件不存在或不是文件：${safeDisplayName(item.displayName)}`)
      }
      const mimeType = resolveMimeType(item.path)
      if (metadata.size > sizeLimitFor(mimeType)) {
        throw new Error(`附件过大：${safeDisplayName(item.displayName)}`)
      }
      return metadata.size
    }
    if (!(item.bytes instanceof ArrayBuffer)) throw new Error('附件内容缺失')
    if (item.bytes.byteLength > MAX_BYTES_IMPORT_BYTES) {
      throw new Error('无路径的粘贴内容不能超过 20 MB；请先保存文件后再通过回形针添加')
    }
    const mimeType = sniffMimeType(new Uint8Array(item.bytes)) || 'application/octet-stream'
    if (item.bytes.byteLength > sizeLimitFor(mimeType)) {
      throw new Error(`附件过大：${safeDisplayName(item.displayName)}`)
    }
    return item.bytes.byteLength
  }

  private async stageFromPath(item: Extract<BartAttachmentImport, { source: 'path' }>): Promise<AgentAttachment> {
    if (!isAbsolute(item.path) || item.path.includes('\0')) throw new Error('附件路径无效')
    const metadata = await stat(item.path).catch(() => null)
    if (!metadata?.isFile()) throw new Error(`附件不存在或不是文件：${safeDisplayName(item.displayName)}`)
    const mimeType = resolveMimeType(item.path)
    const limit = sizeLimitFor(mimeType)
    if (metadata.size > limit) throw new Error(`附件过大：${safeDisplayName(item.displayName)}`)
    const id = randomUUID()
    const name = sanitizeDisplayName(item.displayName, safeExtension(extname(item.path)), true)
    const targetDir = join(this.root, id)
    const target = join(targetDir, name)
    await mkdir(targetDir, { recursive: true, mode: 0o700 })
    await copyFile(item.path, target)
    await chmod(target, 0o600)
    return this.finishStaging({ id, path: target, name, mimeType })
  }

  private async stageFromBytes(item: Extract<BartAttachmentImport, { source: 'bytes' }>): Promise<AgentAttachment> {
    if (!(item.bytes instanceof ArrayBuffer)) throw new Error('附件内容缺失')
    if (item.bytes.byteLength > MAX_BYTES_IMPORT_BYTES) {
      throw new Error('无路径的粘贴内容不能超过 20 MB；请先保存文件后再通过回形针添加')
    }
    const bytes = new Uint8Array(item.bytes)
    const sniffed = sniffMimeType(bytes)
    const mimeType = sniffed || 'application/octet-stream'
    const limit = sizeLimitFor(mimeType)
    if (bytes.byteLength > limit) throw new Error(`附件过大：${safeDisplayName(item.displayName)}`)
    const id = randomUUID()
    const name = sanitizeDisplayName(item.displayName, extensionFor(mimeType), true)
    const targetDir = join(this.root, id)
    const target = join(targetDir, name)
    await mkdir(targetDir, { recursive: true, mode: 0o700 })
    await writeFile(target, bytes, { mode: 0o600 })
    return this.finishStaging({ id, path: target, name, mimeType })
  }

  private async finishStaging(input: {
    readonly id: string
    readonly path: string
    readonly name: string
    readonly mimeType: string
  }): Promise<AgentAttachment> {
    try {
      const metadata = await lstat(input.path)
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`附件 staging 结果不是普通文件：${input.name}`)
      }
      if (metadata.size > sizeLimitFor(input.mimeType)) {
        throw new Error(`附件过大：${input.name}`)
      }
      const manifest: AttachmentManifest = {
        id: input.id,
        path: input.path,
        name: input.name,
        mimeType: input.mimeType,
        size: metadata.size,
        kind: attachmentKindForMimeType(input.mimeType),
        sha256: await hashFile(input.path)
      }
      await mkdir(join(this.root, MANIFEST_DIRECTORY), {
        recursive: true,
        mode: 0o700
      })
      await writeFile(this.manifestPath(input.id), JSON.stringify(manifest), {
        encoding: 'utf8',
        mode: 0o600
      })
      const { sha256: _sha256, ...attachment } = manifest
      return attachment
    } catch (error) {
      await rm(join(this.root, input.id), { recursive: true, force: true })
      await rm(this.manifestPath(input.id), { force: true })
      throw error
    }
  }

  private async canonicalizeFile(
    suppliedPath: string,
    canonicalRoot: string
  ): Promise<AgentAttachment> {
    if (!isAbsolute(suppliedPath) || suppliedPath.includes('\0')) {
      throw new Error('附件路径无效')
    }
    const suppliedMetadata = await lstat(suppliedPath).catch(() => null)
    if (!suppliedMetadata?.isFile() || suppliedMetadata.isSymbolicLink()) {
      throw new Error('附件不存在、已替换或不是普通文件')
    }
    const canonicalPath = await realpath(suppliedPath).catch(error => {
      throw new Error('附件不可访问', { cause: error })
    })
    const relativePath = relative(canonicalRoot, canonicalPath)
    const components = relativePath.split(sep)
    if (
      components.length !== 2 ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath) ||
      !MANAGED_ENTRY_PATTERN.test(components[0]) ||
      !components[1] ||
      components[1] === '.' ||
      components[1] === '..'
    ) {
      throw new Error('附件不属于 Attachment repository')
    }
    const [id, name] = components
    const entryPath = join(this.root, id)
    const entryMetadata = await lstat(entryPath).catch(() => null)
    if (!entryMetadata?.isDirectory() || entryMetadata.isSymbolicLink()) {
      throw new Error(`附件不存在、已替换或不是普通文件：${name}`)
    }
    const manifest = await this.readManifest(id)
    const manifestCanonicalPath = await realpath(manifest.path).catch(() => null)
    if (
      manifest.id !== id ||
      manifest.name !== name ||
      manifestCanonicalPath !== canonicalPath ||
      manifest.size !== suppliedMetadata.size ||
      manifest.sha256 !== await hashFile(canonicalPath)
    ) {
      throw new Error(`附件在 staging 后已被替换：${name}`)
    }
    const mimeType = resolveMimeType(name)
    const authoritativeMimeType = mimeType === 'application/octet-stream'
      ? manifest.mimeType
      : mimeType
    if (suppliedMetadata.size > sizeLimitFor(authoritativeMimeType)) {
      throw new Error(`附件过大：${name}`)
    }
    return {
      id,
      path: canonicalPath,
      name,
      mimeType: authoritativeMimeType,
      size: suppliedMetadata.size,
      kind: attachmentKindForMimeType(authoritativeMimeType)
    }
  }

  private async readManifest(id: string): Promise<AttachmentManifest> {
    const value = JSON.parse(await readFile(this.manifestPath(id), 'utf8')) as unknown
    if (!isAttachmentManifest(value)) {
      throw new Error(`附件 staging metadata 无效：${id}`)
    }
    return value
  }

  private manifestPath(id: string): string {
    return join(this.root, MANIFEST_DIRECTORY, `${id}.json`)
  }
}

/** Strip separators/control chars/`..` and cap length while keeping a readable extension. */
function sanitizeDisplayName(
  raw: string,
  controlledExtension: string,
  enforceExtension = false
): string {
  const base = basename(String(raw || '').replace(/[\\/]+/g, '/')).trim()
  let cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '')
  if (!cleaned || cleaned === '..') cleaned = 'file'
  const extension = safeExtension(controlledExtension)
  if (enforceExtension) {
    const currentExtension = extname(cleaned)
    const stem = currentExtension ? cleaned.slice(0, -currentExtension.length) : cleaned
    cleaned = (stem || 'file') + extension
  } else if (!extname(cleaned) && extension) {
    cleaned += extension
  }
  if (cleaned.length > MAX_DISPLAY_NAME_LENGTH) {
    const finalExtension = extname(cleaned)
    const stem = cleaned.slice(0, Math.max(1, MAX_DISPLAY_NAME_LENGTH - finalExtension.length))
    cleaned = stem + finalExtension
  }
  return cleaned || ('file' + extension)
}

function safeDisplayName(raw: string): string {
  const cleaned = sanitizeDisplayName(raw, '')
  return cleaned || '附件'
}

function resolveMimeType(pathOrName: string): string {
  return mimeTypeForPath(pathOrName)
}

function safeExtension(extension: string): string {
  return /^\.[a-z0-9]{1,16}$/i.test(extension) ? extension.toLowerCase() : ''
}

/** Minimal magic-byte recognition; unknown content degrades to octet-stream. */
function sniffMimeType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
  ) {
    return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return 'application/pdf'
  }
  return null
}

function extensionFor(mimeType: string): string {
  return {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'application/octet-stream': '.bin'
  }[mimeType] || '.bin'
}

function sizeLimitFor(mimeType: string): number {
  if (mimeType.startsWith('image/')) return 20 * 1024 * 1024
  if (mimeType === 'application/pdf') return 32 * 1024 * 1024
  return 50 * 1024 * 1024
}

function isFilePart(
  part: AgentInputPart
): part is Extract<AgentInputPart, { kind: 'local-file' | 'image' | 'audio' }> {
  return part.kind === 'local-file' || part.kind === 'image' || part.kind === 'audio'
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function isAttachmentManifest(value: unknown): value is AttachmentManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Object.keys(candidate).length === 7 &&
    typeof candidate.id === 'string' && MANAGED_ENTRY_PATTERN.test(candidate.id) &&
    typeof candidate.path === 'string' && isAbsolute(candidate.path) &&
    typeof candidate.name === 'string' && candidate.name.length > 0 &&
    typeof candidate.mimeType === 'string' && candidate.mimeType.length > 0 &&
    typeof candidate.size === 'number' && Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    (candidate.kind === 'image' || candidate.kind === 'document' || candidate.kind === 'file') &&
    typeof candidate.sha256 === 'string' && /^[0-9a-f]{64}$/.test(candidate.sha256)
  )
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
}

function assertOwnerId(id: string): void {
  if (typeof id !== 'string' || !id.length || id.length > 128 || /[\s\0]/.test(id) ||
      id === '__proto__' || id === 'constructor' || id === 'prototype') {
    throw new Error('Attachment owner Thread ID 无效')
  }
}
