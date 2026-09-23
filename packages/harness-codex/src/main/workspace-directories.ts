import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { parse } from 'smol-toml'
import { discoverJsonlDirectories, discoveryFiles, discoveryRecord } from '@openagent/plugin-kit/main'
import type { HarnessProcessEnvironment } from '@openagent/contracts'

export async function discoverCodexWorkspaceDirectories(environment: HarnessProcessEnvironment, signal: AbortSignal): Promise<string[]> {
  const root = resolve(environment.CODEX_HOME || join(homedir(), '.codex'))
  let sqliteHome = environment.CODEX_SQLITE_HOME || root
  try {
    const config = parse(await readFile(join(root, 'config.toml'), 'utf8'))
    if (typeof config.sqlite_home === 'string') sqliteHome = config.sqlite_home
  } catch { /* Session metadata remains available without a readable config. */ }
  const databaseFiles = (await discoveryFiles(resolve(sqliteHome), 0, signal))
    .filter(file => /^state_\d+\.sqlite$/.test(basename(file)))
    .sort((a, b) => Number(/state_(\d+)/.exec(basename(b))?.[1]) - Number(/state_(\d+)/.exec(basename(a))?.[1]))
  const directories = new Set<string>()
  for (const path of databaseFiles) {
    signal.throwIfAborted()
    let database: DatabaseSync | undefined
    try {
      database = new DatabaseSync(path, { readOnly: true })
      for (const row of database.prepare('SELECT DISTINCT cwd FROM threads').all()) {
        if (typeof row.cwd === 'string') directories.add(row.cwd)
      }
      break
    } catch { /* Absent, busy or incompatible indexes fall back to rollout metadata. */ }
    finally { database?.close() }
  }
  const sessions = await Promise.all(['sessions', 'archived_sessions'].map(directory =>
    discoverJsonlDirectories(join(root, directory), 3, signal, row =>
      row.type === 'session_meta' ? discoveryRecord(row.payload).cwd : undefined)))
  for (const path of sessions.flat()) directories.add(path)
  return [...directories]
}
