import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import { isTemporaryWorkspacePath } from '@openagent/contracts'
import type { KnownDirectory } from '../../shared/known-directory'

export function mergeKnownDirectories(paths: readonly string[], excludedRoots: readonly string[]): KnownDirectory[] {
  const directories = new Set<string>()
  for (const path of paths) {
    if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) continue
    const normalized = resolve(path)
    // Historical native sessions can outlive a deleted managed Thread and its registry entry.
    if (isTemporaryWorkspacePath(normalized) || normalized.split(sep).some(part => /^\..+-openagent-worktrees$/.test(part))) continue
    if (excludedRoots.some(root => {
      const fromRoot = relative(root, normalized)
      return fromRoot === '' || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
    })) continue
    directories.add(normalized)
  }
  return [...directories].map(path => ({ name: basename(path) || path, path }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
}
