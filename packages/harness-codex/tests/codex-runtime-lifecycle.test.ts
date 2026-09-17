import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexRuntime } from '../src/main/runtime/index.js'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod) }
})

const fixture = resolve(import.meta.dirname, '../../../apps/desktop/tests/fixtures/fake-codex-app-server.mjs')
const directories: string[] = []

afterEach(async () => {
  vi.mocked(chmod).mockReset()
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('Codex isolated runtime lifecycle', () => {
  it.each(['prompt', 'exclusive'] as const)(
    'cleans copied credentials when %s launch is cancelled during filesystem setup',
    async (profile) => {
      await chmod(fixture, 0o755)
      const directory = await temporaryDirectory(`codex-${profile}-setup-abort-`)
      const sourceHome = join(directory, 'source-home')
      const dataRoot = join(directory, 'session-state')
      await mkdir(sourceHome)
      await writeFile(join(sourceHome, 'auth.json'), '{"token":"fake-auth"}')
      const operation = new AbortController()
      const { chmod: chmodOriginal } = await vi.importActual<
        typeof import('node:fs/promises')
      >('node:fs/promises')
      const chmodSpy = vi.mocked(chmod).mockImplementation(async (path, mode) => {
        await chmodOriginal(path, mode)
        if (String(path).endsWith('/auth.json')) operation.abort()
      })
      const runtime = new CodexRuntime({
        resolveExecutable: async () => fixture,
        environment: async () => ({ ...process.env, CODEX_HOME: sourceHome }),
        dataRoot,
        temporaryWorkspaceRoot: directory
      })
      let acquired: Awaited<ReturnType<CodexRuntime['server']>> | undefined
      let failure: unknown
      try {
        try {
          acquired = await runtime.server(
            directory,
            undefined,
            operation.signal,
            profile === 'prompt' ? 'prompt' : { toolMode: 'exclusive', threadId: 'cancelled-bart' }
          )
        } catch (error) {
          failure = error
        }
        expect(failure).toMatchObject({ name: 'AbortError' })
        expect(acquired).toBeUndefined()
        const isolationRoot = join(dataRoot, 'application-tools-only')
        const homes = await readdir(isolationRoot)
        if (profile === 'prompt') {
          expect(homes).toEqual([])
        } else {
          expect(homes).toHaveLength(1)
          await expect(stat(join(isolationRoot, homes[0]!, 'auth.json')))
            .rejects.toMatchObject({ code: 'ENOENT' })
        }
        expect(await readFile(join(sourceHome, 'auth.json'), 'utf8'))
          .toBe('{"token":"fake-auth"}')
      } finally {
        chmodSpy.mockReset()
        await acquired?.server.dispose()
      }
    }
  )
})

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}
