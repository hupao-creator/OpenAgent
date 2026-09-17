export interface WorktreeOptions {
  readonly enabled?: boolean
  readonly name?: string
}

export interface AgentWorktree {
  readonly baseCwd: string
  readonly name?: string
  readonly native: boolean
  readonly cwd?: string
}

/**
 * Immutable facts established by Core. The roots are capabilities, not native
 * sandbox configuration, and must remain provider-neutral.
 */
export interface ManagedWorkspaceWriteGrant {
  readonly kind: 'managed-linked-worktree'
  readonly cwd: string
  readonly headOid: string
  readonly writableRoots: readonly string[]
}

/**
 * Thread-bound authority assembled by Core from a trusted Thread reference.
 * A Plugin can request fresh facts but cannot provide or override ownership,
 * repository, or path inputs.
 */
export interface ManagedWorkspaceWriteCapability {
  grant(signal: AbortSignal): Promise<ManagedWorkspaceWriteGrant>
}
