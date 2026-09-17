import type { HarnessThreadCapabilities } from './harness-descriptor.js'
import type { HarnessThreadInjection } from './harness-plugin.js'

/** Fail before native startup; omission keeps the ordinary native tool set. */
export function assertHarnessThreadInjection(
  capabilities: HarnessThreadCapabilities,
  injection: HarnessThreadInjection | undefined
): void {
  if (!injection) return
  if (injection.instructions?.length && !capabilities.instructions) {
    throw new Error('Harness does not support Thread instructions')
  }
  if ((injection.contextEntries?.length || injection.seed?.length) && !capabilities.threadContext) {
    throw new Error('Harness does not support Thread context')
  }
  if (injection.tools && !capabilities.toolModes.includes(injection.tools.mode)) {
    throw new Error(`Harness does not support custom tool mode: ${injection.tools.mode}`)
  }
  const names = injection.tools?.bindings.map(tool => tool.name) ?? []
  if (names.some(name => !name.trim()) || new Set(names).size !== names.length) {
    throw new Error('Harness custom tool names must be nonempty and unique')
  }
}

/**
 * Thread Read targets an ordinary Agent Thread, so its source never carries an
 * injection. Reject one rather than answer from a divergent request: read reuses
 * the source's request construction, and no harness forwards an injected tool
 * bridge into its read fork, so the fork would advertise a different tool set
 * (and, for instructions, a different system prompt) while claiming fidelity.
 */
export function assertHarnessThreadReadSource(
  injection: HarnessThreadInjection | undefined
): void {
  if (!injection) return
  throw new Error('Thread Read does not support a source Thread with an injection')
}
