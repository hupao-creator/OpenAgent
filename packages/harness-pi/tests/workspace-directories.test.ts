import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverPiWorkspaceDirectories } from '../src/main/workspace-directories.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
it('reads default session headers and configured session directories without decoding directory names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-workspaces-')); roots.push(root)
  const standard = join(root, 'sessions', '--lossy-name--'), custom = join(root, 'custom')
  await mkdir(standard, { recursive: true }); await mkdir(custom)
  await writeFile(join(standard, 'session.jsonl'), JSON.stringify({ type: 'session', cwd: '/repo/a--b' }) + '\n')
  await writeFile(join(custom, 'session.jsonl'), JSON.stringify({ type: 'session', cwd: '/repo/custom' }) + '\n')
  await writeFile(join(root, 'settings.json'), JSON.stringify({ sessionDir: custom }))
  const discover = (env = {}) => discoverPiWorkspaceDirectories({ PI_CODING_AGENT_DIR: root, ...env }, new AbortController().signal)
  expect((await discover()).sort()).toEqual(['/repo/a--b', '/repo/custom'])
  expect(await discover({ PI_CODING_AGENT_SESSION_DIR: join(root, 'missing') })).toEqual(['/repo/a--b'])
})
