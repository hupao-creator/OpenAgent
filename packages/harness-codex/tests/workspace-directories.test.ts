import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { discoverCodexWorkspaceDirectories } from '../src/main/workspace-directories.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('combines the configured read-only database with active and archived rollout metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-workspaces-')); roots.push(root)
  const sqlite = join(root, 'db')
  await mkdir(sqlite)
  await writeFile(join(root, 'config.toml'), `sqlite_home = ${JSON.stringify(sqlite)}\n`)
  const db = new DatabaseSync(join(sqlite, 'state_5.sqlite'))
  db.exec("CREATE TABLE threads(cwd TEXT); INSERT INTO threads VALUES('/repo/db-only'),('/repo/db-only')")
  db.close()
  for (const directory of ['sessions/2026/09/23', 'archived_sessions']) {
    await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, directory, 'session.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo/' + directory.split('/')[0] } }) + '\n')
    await writeFile(join(root, directory, 'bad.jsonl'), '{partial')
  }
  const result = await discoverCodexWorkspaceDirectories({ CODEX_HOME: root, CODEX_SQLITE_HOME: '/unused-override' }, new AbortController().signal)
  expect(result.sort()).toEqual(['/repo/archived_sessions', '/repo/db-only', '/repo/sessions'])
})

it('honors SQLite environment overrides and tolerates missing native directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-workspaces-')); roots.push(root)
  const db = new DatabaseSync(join(root, 'state_6.sqlite'))
  db.exec("CREATE TABLE threads(cwd TEXT); INSERT INTO threads VALUES('/repo/external')"); db.close()
  expect(await discoverCodexWorkspaceDirectories({ CODEX_HOME: join(root, 'missing'), CODEX_SQLITE_HOME: root }, new AbortController().signal)).toEqual(['/repo/external'])
  await expect(discoverCodexWorkspaceDirectories({ CODEX_HOME: root }, AbortSignal.abort())).rejects.toThrow()
})
