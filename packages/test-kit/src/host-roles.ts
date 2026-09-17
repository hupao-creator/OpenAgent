import { canHostBart, type HarnessThreadCapabilities } from '@openagent/contracts'

export { canHostBart }

export interface CapabilityBearing {
  readonly id: string
  readonly threadCapabilities: HarnessThreadCapabilities
}

/** Registered ids whose declared capabilities satisfy the Core Bart host role. */
export function bartCapableIds(
  registered: readonly CapabilityBearing[]
): string[] {
  return registered.filter(module => canHostBart(module.threadCapabilities)).map(module => module.id)
}

/**
 * Role assignment for host-policy fixtures. Roles are behaviour positions the
 * host rules are written against — "available with the Bart host role",
 * "available without it", "task target only" — never plugin identities. Each
 * legal composition maps real registered ids onto these roles before the
 * shared rule suite runs.
 */
export interface FixtureHarnessRoles {
  readonly host: string
  readonly nonHost: string
  readonly taskOnly: readonly string[]
}

/**
 * Derive the default role assignment from declared capabilities: the first
 * registered host-capable id plays the host role, the next host-capable id is
 * stripped into the non-host role, and everything incapable stays task-only.
 */
export function deriveFixtureRoles(
  registered: readonly CapabilityBearing[]
): FixtureHarnessRoles {
  const capable = bartCapableIds(registered)
  if (capable.length === 0) {
    throw new Error(
      'test-kit: 当前注册组合没有任何具备 Bart Host 能力的 Harness，无法派生宿主策略角色'
    )
  }
  const taskOnly = registered.map(module => module.id)
    .filter(id => !capable.includes(id))
  const nonHost = capable[1] ?? taskOnly[0]
  if (nonHost === undefined || nonHost === capable[0]) {
    // The host-policy rules need a second, distinct behaviour position
    // ("available without the host role"); a single-Harness composition
    // cannot exercise them and must not alias both roles onto one id.
    throw new Error(
      'test-kit: 当前注册组合无法派生不同的 non-host 角色' +
      '（只有一个具备 Bart Host 能力的 Harness 且没有 task-only Harness）'
    )
  }
  return { host: capable[0], nonHost, taskOnly }
}
