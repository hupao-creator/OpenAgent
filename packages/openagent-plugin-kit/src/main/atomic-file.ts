import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Atomically replaces one owner-readable file and removes failed temporary writes. */
export async function writePrivateFileAtomically(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, data, { mode: 0o600 })
    await chmod(temporary, 0o600)
    // rename is the commit point. The temporary file already has mode 0600;
    // no fallible operation may report failure after the destination changed.
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
