export interface ThreadWorkspaceIdentity {
  readonly cwd: string
  readonly worktree?: {
    readonly baseCwd: string
  }
}

/** Shared tag identity used by Core in Main and Renderer. */
export function threadTagKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

export function sameThreadTag(left: string, right: string): boolean {
  return threadTagKey(left) === threadTagKey(right)
}

export function isTemporaryWorkspacePath(value: string): boolean {
  const path = value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!path) return false
  return (
    /\/\.OpenAgent(?:-headless)?\/tmp-workspaces(?:\/|$)/.test(path) ||
    /^\/(?:private\/)?(?:tmp|var\/tmp)\/openagent-[^/]+(?:\/|$)/i.test(path) ||
    /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/openagent-[^/]+(?:\/|$)/i.test(path) ||
    /^[A-Za-z]:\/(?:Windows\/Temp|Users\/[^/]+\/AppData\/Local\/Temp)\/openagent-[^/]+(?:\/|$)/i.test(path)
  )
}

/** The user-owned workspace represented by a Thread, never its managed worktree. */
export function threadWorkspaceCwd(thread: ThreadWorkspaceIdentity): string {
  return (thread.worktree?.baseCwd?.trim() || thread.cwd.trim())
    .replace(/[\\/]+$/, '')
}

export function threadDirectoryTag(thread: ThreadWorkspaceIdentity): string {
  const cwd = threadWorkspaceCwd(thread)
  if (!cwd || isTemporaryWorkspacePath(cwd)) return ''
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || ''
}
