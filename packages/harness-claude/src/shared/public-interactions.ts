import type { PublicInteraction } from '@openagent/contracts'
import type { ClaudeInteraction } from './state.js'
import { opaqueIdentifierDigest } from '@openagent/plugin-kit/shared'

const PUBLIC_INTERACTION_ID_DOMAIN = 'openagent.claude.public-interaction.v1'

/**
 * Claude native request identifiers are Plugin-private opaque strings. Public
 * IDs are stable within a persisted Execution without exposing or constraining the
 * native identifier's alphabet.
 */
export function claudePublicInteractionId(
  executionId: string,
  nativeInteractionId: string
): string {
  return `claude-interaction-sha256-${opaqueDigest([
    'interaction',
    executionId,
    nativeInteractionId
  ])}`
}

/** A public question identity derived without embedding its native parent. */
export function claudePublicQuestionId(
  executionId: string,
  nativeInteractionId: string,
  questionIndex: number
): string {
  return `claude-question-sha256-${opaqueDigest([
    'question',
    executionId,
    nativeInteractionId,
    String(questionIndex)
  ])}`
}

/** A public option identity that never exposes a native option value. */
export function claudePublicOptionId(
  executionId: string,
  nativeInteractionId: string,
  questionIndex: number,
  optionIndex: number
): string {
  return `claude-option-sha256-${opaqueDigest([
    'option',
    executionId,
    nativeInteractionId,
    String(questionIndex),
    String(optionIndex)
  ])}`
}

function opaqueDigest(parts: readonly string[]): string {
  return opaqueIdentifierDigest(PUBLIC_INTERACTION_ID_DOMAIN, parts)
}

export function toPublicClaudeInteraction(
  executionId: string,
  interaction: ClaudeInteraction
): PublicInteraction {
  const questionLike = interaction.kind !== 'permission'
  const actions = interaction.kind === 'permission'
    ? [
        { id: 'allow', intent: 'allow' as const, label: 'Allow' },
        ...(interaction.canRemember
          ? [{ id: 'allow-session', intent: 'allow' as const, label: 'Allow for session' }]
          : []),
        { id: 'deny', intent: 'deny' as const, label: 'Deny' },
        { id: 'cancel', intent: 'cancel' as const, label: 'Cancel' }
      ]
    : interaction.kind === 'elicitation'
      ? [
          {
            id: 'submit',
            intent: 'submit' as const,
            label: interaction.elicitationMode === 'url'
              ? 'Accept and open'
              : 'Submit'
          },
          { id: 'deny', intent: 'deny' as const, label: 'Decline' },
          { id: 'cancel', intent: 'cancel' as const, label: 'Cancel' }
        ]
      : [
          { id: 'submit', intent: 'submit' as const, label: 'Submit' },
          { id: 'cancel', intent: 'cancel' as const, label: 'Cancel' }
        ]
  return {
    id: claudePublicInteractionId(executionId, interaction.id),
    kind: questionLike ? 'question' : 'permission',
    title: interaction.title,
    ...(interaction.description ? { description: interaction.description } : {}),
    actions,
    questions: interaction.kind === 'permission'
      ? [{
          id: claudePublicQuestionId(executionId, interaction.id, 0),
          prompt: 'Optional denial reason',
          multiple: false,
          allowOther: true,
          secret: false,
          options: []
        }]
      : interaction.kind === 'elicitation' && interaction.elicitationMode !== 'url'
        ? [{
            id: claudePublicQuestionId(executionId, interaction.id, 0),
            prompt: 'JSON form values',
            multiple: false,
            allowOther: true,
            secret: false,
            options: []
          }]
        : interaction.kind === 'elicitation'
          ? []
        : interaction.kind === 'dialog'
          ? [{
              id: claudePublicQuestionId(executionId, interaction.id, 0),
              prompt: interaction.title || 'Reply',
              multiple: false,
              allowOther: true,
              secret: false,
              options: []
            }]
          : (interaction.questions || []).map((question, index) => ({
              id: claudePublicQuestionId(executionId, interaction.id, index),
              prompt: question.question,
              ...(question.header ? { header: question.header } : {}),
              multiple: question.multiSelect,
              allowOther: true,
              secret: false,
              options: question.options.map((option, optionIndex) => ({
                value: claudePublicOptionId(
                  executionId,
                  interaction.id,
                  index,
                  optionIndex
                ),
                label: option.label,
                ...(option.description ? { description: option.description } : {})
              }))
            }))
  }
}
