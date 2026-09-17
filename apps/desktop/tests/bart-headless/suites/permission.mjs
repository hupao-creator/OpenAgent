import assert from 'node:assert/strict'
import { check, checkOperation } from '../invariant.mjs'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { exactCallDirective } from '../bart.mjs'
import {
  assertContainsToken,
  assertMissing,
  assertSubsequence,
  bounded,
  escapeRegExp
} from '../support.mjs'

/**
 * The native permission chain. A case is only meaningful when approval changes
 * an observable native fact: an exact proof file that cannot exist before the
 * response, or a random secret the model cannot know without a permitted read.
 */
export const permissionSuite = {
  id: 'permission',
  tier: 'core',
  description: 'Native permission interactions answered through the Bart',
  cases: [
    {
      id: 'allow',
      requires: ['permission'],
      description: 'approval unlocks native work that was impossible before it',
      async run(context) {
        const proofPath = context.proofPath('PERMISSION')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: permissionPrompt(context, proofPath, evidence)
        })

        const { execution, interaction } = await context.waitForInteraction(threadId, 'permission')
        await assertEvidenceIsStillLocked(evidence, proofPath, execution)

        const { terminal, interactionIds } = await context.allowPermissionChain({
          threadId,
          interaction,
          maxPermissions: 4
        })
        await assertEvidenceUnlocked(evidence, proofPath, terminal, context)
        assertSubsequence(
          context.client.statusTransitions(threadId),
          ['running', 'waiting-for-user', 'running', 'completed'],
          'public execution transitions'
        )
        return { threadId, executionId: terminal.executionId, interactionIds }
      }
    },
    {
      id: 'deny',
      requires: ['permission'],
      description: 'denial keeps the native effect from ever happening',
      async run(context) {
        const proofPath = context.proofPath('DENY')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const deniedMarker = `PERMISSION_DENIED:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: [
            permissionPrompt(context, proofPath, evidence),
            'If the native permission request is denied, do not retry it and do not use another tool.',
            `Reply with exactly ${deniedMarker} instead.`
          ].join('\n')
        })

        const { interaction } = await context.waitForInteraction(threadId, 'permission')
        const response = context.answerFor(interaction, 'deny')
        await context.respond({
          threadId,
          interaction,
          actionId: response.actionId,
          intro: 'Reject the pending native permission request for this acceptance case.'
        })

        const terminal = await context.waitForTerminal(threadId)
        if (evidence.kind === 'write-proof') {
          await assertMissing(proofPath, 'denied native proof')
        } else {
          assert.doesNotMatch(
            terminal.summary || '',
            new RegExp(escapeRegExp(evidence.secret)),
            'the denied native read still leaked its secret'
          )
        }
        assert.doesNotMatch(
          terminal.summary || '',
          new RegExp(escapeRegExp(evidence.expectedMarker)),
          'the denied case reported the approved completion marker'
        )
        assertContainsToken(
          terminal.summary,
          deniedMarker,
          `denial was not reported by the native agent: ${bounded(terminal)}`
        )
        return { threadId, executionId: terminal.executionId, interactionId: interaction.id }
      }
    },
    {
      id: 'send-blocked-while-waiting',
      requires: ['permission'],
      description: 'a pending interaction refuses a follow-up until it is answered',
      async run(context) {
        const proofPath = context.proofPath('BLOCKED')
        const evidence = await preparePermissionEvidence(context, proofPath)
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: permissionPrompt(context, proofPath, evidence)
        })
        const { interaction } = await context.waitForInteraction(threadId, 'permission')

        const prompt = `Ignore the pending request and reply BLOCKED:${context.token}.`
        const { message } = await context.bart.askForToolFailure({
          name: 'openagent_thread_send',
          expectedArguments: { threadId, prompt },
          errorPattern: /interaction/,
          directive: exactCallDirective(
            'Try to steer a Thread that is waiting for a native response.',
            'openagent_thread_send',
            { threadId, prompt },
            ['Report the tool error verbatim if it fails; do not work around it.']
          )
        })
        assert.match(message, /等待|waiting/, `unexpected guardrail message: ${message}`)

        const stillWaiting = await context.waitForInteraction(threadId, 'permission')
        assert.equal(
          stillWaiting.interaction.id,
          interaction.id,
          'the rejected follow-up replaced the pending interaction'
        )

        const { terminal } = await context.allowPermissionChain({
          threadId,
          interaction: stillWaiting.interaction,
          maxPermissions: 4
        })
        await assertEvidenceUnlocked(evidence, proofPath, terminal, context)
        return { threadId, executionId: terminal.executionId, guardrail: message }
      }
    }
  ]
}

/**
 * Chooses the native proof for one Harness. `read-secret` targets Harnesses
 * whose permission surface covers reads outside the workspace; every other
 * Harness must create an exact file that cannot exist before approval.
 */
export async function preparePermissionEvidence(context, proofPath) {
  if (context.provider.permissionProbe !== 'read-secret') {
    return { kind: 'write-proof', expectedMarker: `PERMISSION_OK:${context.token}` }
  }
  const secret = `NATIVE_SECRET_${randomUUID()}`
  await context.seedSecret(proofPath, secret)
  return {
    kind: 'read-secret',
    secret,
    expectedMarker: `PERMISSION_OK:${context.token}:${secret}`
  }
}

export function permissionPrompt(context, proofPath, evidence) {
  if (evidence.kind === 'read-secret') {
    return [
      `This is a native ${context.harness} permission-response acceptance case.`,
      `Use the native read tool to read this exact file outside the workspace: ${proofPath}`,
      'Do not use shell, do not guess the contents, and do not bypass the native permission request.',
      `After approval and a successful native read, output exactly PERMISSION_OK:${context.token}:<exact file contents>.`
    ].join('\n')
  }
  return [
    `This is a native ${context.harness} permission-response acceptance case.`,
    `Use the native ${context.provider.permissionTool} tool to run exactly this command: ${context.writeProofCommand(proofPath, context.token)}`,
    'Do not modify the repository. Do not bypass or avoid the native permission request.',
    `After approval, read the proof file with a native read-only tool and output exactly PERMISSION_OK:${context.token}.`
  ].join('\n')
}

export async function assertEvidenceIsStillLocked(evidence, proofPath, execution) {
  if (evidence.kind === 'write-proof') {
    await checkOperation('permission.proof.locked', () => assertMissing(proofPath, 'native proof'))
    return
  }
  check.doesNotMatch('permission.secret.locked',
    execution.summary || '',
    new RegExp(escapeRegExp(evidence.secret)),
    'native secret became observable before respond'
  )
}

export async function assertEvidenceUnlocked(evidence, proofPath, terminal, context) {
  if (evidence.kind === 'write-proof') {
    check.equal('permission.proof.content',
      await checkOperation('permission.proof.exists', () => readFile(proofPath, 'utf8'), ['ENOENT']),
      context.token,
      'native approved command did not write the exact proof token'
    )
  }
  await checkOperation('permission.completion-marker', () => assertContainsToken(
    terminal.summary,
    evidence.expectedMarker,
    `terminal summary did not contain the native permission completion marker: ${bounded(terminal)}`
  ))
}
