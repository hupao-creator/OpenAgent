import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { isTemporaryWorkspacePath } from '@openagent/contracts'
import type { KnownDirectory } from '../../shared/known-directory'

export function mergeKnownDirectories(paths: readonly string[], temporaryRoot: string): KnownDirectory[] {
  const directories = new Set<string>()
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) continue
    const normalized = resolve(path)
    const fromTemporary = relative(temporaryRoot, normalized)
    if (isTemporaryWorkspacePath(normalized) || fromTemporary === '' || (!isAbsolute(fromTemporary) && fromTemporary !== '..' && !fromTemporary.startsWith(`..${sep}`))) continue
    directories.add(normalized)
  }
  return [...directories].map(path => ({ name: basename(path) || path, path }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
