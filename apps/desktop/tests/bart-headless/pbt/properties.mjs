import assert from 'node:assert/strict'
import {
  isolationCommand,
  isolationCommands,
  lifecycleCommand,
  lifecycleCommands,
  permissionCommand,
  permissionCommands
} from './commands.mjs'

/**
 * The three first-phase properties.
 *
 * Each one owns:
 *  - `requires`: the native capabilities its target must declare. A property is
 *    never silently skipped; the runner fails when no configured target can
 *    exercise it.
 *  - `checkpoints`: short, fixed operation sequences that run before the
 *    generated samples in their own isolated session. `fc.commands` picks a kind
 *    and then drops it whenever `check(model)` rejects it, so a random sequence
 *    reaches a deep state only by luck. Checkpoints make the deep states
 *    mandatory every run, so the coverage requirement below can never be
 *    satisfied by a vacuous pass, and shrinking never has to rediscover them.
 *  - `coverage`: the minimum operation and state coverage the checkpoint phase
 *    must report. A shortfall is a failure, and it is deterministic: the same
 *    fixed sequences reach the same states on every run.
 *  - `sampleCoverage`: the minimum the *generated* phase must report on its own,
 *    required at every budget. The two phases are counted separately, so a
 *    checkpoint can never satisfy it. This is what keeps a run from passing
 *    because its checkpoints were thorough while its generated distribution
 *    executed almost nothing. The values are the reach the short regression's
 *    fixed seed was measured to deliver, so a run that reaches less than this
 *    has lost generated coverage and fails.
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
    commandFor: lifecycleCommand,
    checkpoints: [
      // The late-result race: cancel while the native turn is parked, then let it
      // answer. The answered turn may never revive the cancelled Execution.
      [{ kind: 'start-hold' }, { kind: 'interrupt' }, { kind: 'release' }],
      [{ kind: 'start-hold' }, { kind: 'interrupt' }, { kind: 'send' }],
      // Steering a running Execution must not be attributed to a new one.
      [{ kind: 'start-hold' }, { kind: 'steer' }, { kind: 'release' }],
      // A follow-up after a terminal Execution starts exactly one successor.
      [{ kind: 'start-plain' }, { kind: 'send' }],
      // Projection of a settled Thread.
      [{ kind: 'start-plain' }, { kind: 'status' }, { kind: 'list' }]
    ],
    coverage: {
      kinds: { 'start-plain': 1, 'start-hold': 1, send: 1, steer: 1, release: 1, interrupt: 1 },
      states: ['completed', 'running', 'interrupted', 'successor-execution', 'late-result-after-successor', 'late-result-after-interrupt']
    },
    sampleCoverage: {
      kinds: { 'start-hold': 1, 'start-plain': 1, send: 1, steer: 1, interrupt: 1, release: 1 },
      states: ['completed', 'running', 'interrupted', 'successor-execution', 'late-result-after-interrupt']
    },
    exploreCoverage: {
      // Exploration must also generate both controlled late-result races;
      // checkpoint reach cannot satisfy this independent requirement.
      kinds: { release: 1 },
      states: ['late-result-after-interrupt', 'late-result-after-successor']
    }
  },

  permission: {
    name: 'permission',
    description: 'Interaction ownership: approval, denial, and rejected responses',
    requires: ['permission'],
    commands: permissionCommands,
    commandFor: permissionCommand,
    checkpoints: [
      // Approval must perform the protected native effect.
      [{ kind: 'start' }, { kind: 'respond-allow' }],
      // Denial must leave the protected effect impossible.
      [{ kind: 'start' }, { kind: 'respond-deny' }],
      // An unknown identifier is rejected without consuming the pending
      // interaction, and the real one still works afterwards.
      [{ kind: 'start' }, { kind: 'respond-unknown' }, { kind: 'respond-allow' }, { kind: 'respond-consumed' }]
    ],
    coverage: {
      kinds: {
        start: 1,
        'respond-allow': 1,
        'respond-deny': 1,
        'respond-unknown': 1,
        'respond-consumed': 1
      },
      states: [
        'waiting-for-user',
        'approved-with-proof',
        'denied-without-proof',
        'rejected-unknown-interaction',
        'rejected-consumed-interaction'
      ]
    },
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
    commandFor: isolationCommand,
    checkpoints: [
      // An identifier from the sibling Thread is rejected, and both Threads keep
      // their own pending interaction and their own locked protected effect.
      [
        { kind: 'start', thread: 'A' },
        { kind: 'start', thread: 'B' },
        { kind: 'respond-foreign', thread: 'A' },
        { kind: 'respond-allow', thread: 'B' },
        { kind: 'respond-allow', thread: 'A' }
      ],
      // A denial in one Thread must not affect the other Thread's approval.
      [
        { kind: 'start', thread: 'A' },
        { kind: 'start', thread: 'B' },
        { kind: 'respond-deny', thread: 'A' },
        { kind: 'respond-allow', thread: 'B' }
      ],
      [
        { kind: 'start', thread: 'A' },
        { kind: 'start', thread: 'B' },
        { kind: 'interrupt', thread: 'A' },
        { kind: 'respond-allow', thread: 'B' }
      ]
    ],
    coverage: {
      kinds: { start: 2, 'respond-allow': 2, 'respond-deny': 1, 'respond-foreign': 1, interrupt: 1 },
      states: [
        'waiting-for-user',
        'approved-with-proof',
        'denied-without-proof',
        'rejected-foreign-interaction',
        'cancelled-beside-waiting',
        'out-of-order-completion'
      ]
    },
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

/**
 * Runs one fixed checkpoint sequence through the same commands, the same
 * independent model, and the same committed-state assertions as a generated
 * sample. The session is the caller's, so a checkpoint is only isolated from
 * other checkpoints by the model it starts from — every command still drives the
 * real chain.
 */
export async function driveCheckpoint(session, definition, coverage, plans, label, trace = []) {
  const model = { threads: {} }
  for (const plan of plans) {
    const command = definition.commandFor(plan, coverage)
    assert.ok(
      await command.check(model),
      `${label}: checkpoint is not feasible at ${command} — the checkpoint definition is wrong`
    )
    trace.push(String(command))
    await command.run(model, session)
  }
  return model
}
