import assert from 'node:assert/strict'
import {
  isolationCommands,
  lifecycleCommands,
  permissionCommands
} from './commands.mjs'

/**
 * The three first-phase properties.
 *
 * Each one owns:
 *  - `requires`: the native capabilities its target must declare. A property is
 *    never silently skipped; the runner fails when no configured target can
 *    exercise it.
 *  - `sampleCoverage`: the minimum operations and states generated samples
 *    must reach. Shrinking and replay cannot satisfy these requirements.
 *  - `exploreCoverage`: additionally required from the generated phase when the
 *    exploration budget runs. It holds the operations and states the exploration
 *    distribution is required to reach before passing but a short sequence draws only by luck.
 */
export const PROPERTIES = {
  lifecycle: {
    name: 'lifecycle',
    description: 'Thread lifecycle: create, follow-up, steering, interruption',
    requires: [],
    commands: lifecycleCommands,
    sampleCoverage: {
      kinds: { 'start-hold': 1, 'start-plain': 1, send: 1, steer: 1, interrupt: 1, release: 1 },
      states: ['completed', 'running', 'interrupted', 'successor-execution', 'late-result-after-interrupt']
    },
    exploreCoverage: {
      // Exploration must generate both controlled late-result races.
      kinds: { release: 1 },
      states: ['late-result-after-interrupt', 'late-result-after-successor']
    }
  },

  permission: {
    name: 'permission',
    description: 'Interaction ownership: approval, denial, and rejected responses',
    requires: ['permission'],
    commands: permissionCommands,
    sampleCoverage: {
      kinds: { start: 1, 'respond-allow': 1, 'respond-deny': 1, 'respond-unknown': 1, 'respond-consumed': 1 },
      states: ['waiting-for-user', 'approved-with-proof', 'denied-without-proof', 'rejected-unknown-interaction', 'rejected-consumed-interaction']
    },
    exploreCoverage: {
      // Retain native approval evidence in the exploration requirement as well.
      kinds: { 'respond-allow': 1 },
      states: ['approved-with-proof']
    }
  },

  isolation: {
    name: 'isolation',
    description: 'Multi-Thread isolation: permission ownership never crosses Threads',
    requires: ['permission'],
    commands: isolationCommands,
    sampleCoverage: {
      kinds: { start: 2, 'respond-allow': 1, 'respond-deny': 1, 'respond-foreign': 1, interrupt: 1 },
      states: ['waiting-for-user', 'approved-with-proof', 'denied-without-proof', 'rejected-foreign-interaction', 'interrupted']
    },
    exploreCoverage: {
      // The cross-Thread denial and interruption of one Thread beside another
      // need more picks than the short budget's six samples draw.
      kinds: { 'respond-deny': 1, interrupt: 1 },
      states: ['denied-without-proof', 'out-of-order-completion', 'cancelled-beside-waiting']
    }
  }
}

export const PROPERTY_NAMES = Object.freeze(Object.keys(PROPERTIES))

export function selectProperties(requested = 'all') {
  if (requested === 'all') return PROPERTY_NAMES.map(name => PROPERTIES[name])
  const definition = PROPERTIES[requested]
  assert.ok(definition, `unknown property: ${requested} (expected all or ${PROPERTY_NAMES.join(', ')})`)
  return [definition]
}

export function supportsProperty(definition, capabilities) {
  return definition.requires.every(capability => capabilities.includes(capability))
}
