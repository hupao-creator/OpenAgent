import { open, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

export function discoveryRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function readDiscoveryJson(path: string): Promise<Record<string, unknown>> {
  try { return discoveryRecord(JSON.parse(await readFile(path, 'utf8'))) }
  catch { return {} }
}

/** Walk only native session metadata trees, never workspace contents or symlinks. */
export async function discoveryFiles(root: string, depth: number, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    signal.throwIfAborted()
    const path = join(root, entry.name)
    if (entry.isFile()) files.push(path)
    else if (entry.isDirectory() && depth > 0) files.push(...await discoveryFiles(path, depth - 1, signal))
  }
  return files
}

/** Read a bounded prefix: session headers carry cwd, conversation bodies need not be loaded. */
async function sessionDirectory(path: string, select: (row: Record<string, unknown>) => unknown): Promise<string | undefined> {
  const file = await open(path, 'r').catch(() => undefined)
  if (!file) return undefined
  try {
    const buffer = Buffer.alloc(8 * 1024)
    const decoder = new StringDecoder('utf8')
    let tail = ''
    for (let offset = 0; offset < 1024 * 1024;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      offset += bytesRead
      tail += bytesRead ? decoder.write(buffer.subarray(0, bytesRead)) : decoder.end()
      const lines = tail.split('\n')
      tail = bytesRead ? lines.pop()! : ''
      for (const line of lines) {
        try {
          const value = select(discoveryRecord(JSON.parse(line)))
          if (typeof value === 'string' && value) return value
        } catch { /* Truncated or malformed records do not hide the other sessions. */ }
      }
      if (!bytesRead) break
    }
    return undefined
  } catch { return undefined }
  finally { await file.close() }
}

export async function discoverJsonlDirectories(
  root: string, depth: number, signal: AbortSignal, select: (row: Record<string, unknown>) => unknown
): Promise<string[]> {
  const files = (await discoveryFiles(root, depth, signal)).filter(file => file.endsWith('.jsonl'))
  const directories = new Set<string>()
  for (let index = 0; index < files.length; index += 16) {
    signal.throwIfAborted()
    const batch = await Promise.all(files.slice(index, index + 16).map(file => sessionDirectory(file, select)))
    for (const path of batch) if (path) directories.add(path)
  }
  signal.throwIfAborted()
  return [...directories]
}
