import type { PublicInteraction } from '@openagent/contracts'
import { PUBLIC_OBSERVATION_LIMITS } from '@openagent/contracts'
import type { CodexInteraction } from './types.js'
import { opaqueIdentifierDigest } from '@openagent/plugin-kit/shared'

const PUBLIC_INTERACTION_ID_DOMAIN = 'openagent.codex.public-interaction.v1'

export function codexPublicInteractionId(nativeInteractionId: string): string {
  return `codex-interaction-sha256-${opaqueDigest([
    'interaction',
    nativeInteractionId
  ])}`
}

export function codexPublicQuestionId(
  nativeInteractionId: string,
  nativeQuestionId: string
): string {
  return `codex-question-sha256-${opaqueDigest([
    'question',
    nativeInteractionId,
    nativeQuestionId
  ])}`
}

export function codexPublicOptionId(
  nativeInteractionId: string,
  nativeQuestionId: string,
  nativeOptionId: string
): string {
  return `codex-option-sha256-${opaqueDigest([
    'option',
    nativeInteractionId,
    nativeQuestionId,
    nativeOptionId
  ])}`
}

function opaqueDigest(parts: readonly string[]): string {
  return opaqueIdentifierDigest(PUBLIC_INTERACTION_ID_DOMAIN, parts)
}

export function toPublicInteraction(interaction: CodexInteraction): PublicInteraction {
  const elicitation = interaction.kind === 'mcp-elicitation' ? interaction.elicitation : undefined
  const kind = interaction.kind === 'user-input' || elicitation?.mode === 'form'
    ? 'question'
    : 'permission'
  const schema = elicitation?.mode === 'form'
    ? JSON.stringify(elicitation.requestedSchema, null, 2)
    : undefined
  const description = elicitation?.mode === 'url'
    ? elicitation.url
    : schema || interaction.detail
  const publicDescription = description
    ? displayText(description, PUBLIC_OBSERVATION_LIMITS.description)
    : undefined
  return {
    id: codexPublicInteractionId(interaction.id),
    kind,
    title: displayText(interaction.title, PUBLIC_OBSERVATION_LIMITS.title,
      kind === 'question' ? 'Codex 需要补充信息' : 'Codex 请求确认'),
    ...(publicDescription ? { description: publicDescription } : {}),
    actions: interaction.actions.map(action => ({
      id: action.id,
      intent: action.intent,
      label: displayText(action.label, PUBLIC_OBSERVATION_LIMITS.actionLabel, {
        allow: '允许', deny: '拒绝', submit: '提交', cancel: '取消'
      }[action.intent])
    })),
    questions: interaction.questions.map(question => {
      const header = question.header
        ? displayText(question.header, PUBLIC_OBSERVATION_LIMITS.header)
        : undefined
      return {
        id: codexPublicQuestionId(interaction.id, question.id),
        prompt: displayText(elicitation?.mode === 'form' && question.id === elicitation.questionId
          ? `JSON form values matching this schema:\n${schema}`
          : question.prompt, PUBLIC_OBSERVATION_LIMITS.prompt, 'Codex question'),
        ...(header ? { header } : {}),
        multiple: false,
        allowOther: question.allowOther,
        secret: question.secret,
        options: question.options.map((option, index) => {
          const description = option.description
            ? displayText(option.description, PUBLIC_OBSERVATION_LIMITS.optionDescription)
            : undefined
          return {
            value: codexPublicOptionId(interaction.id, question.id, option.id),
            label: displayText(option.label, PUBLIC_OBSERVATION_LIMITS.optionLabel, `选项 ${index + 1}`),
            ...(description ? { description } : {})
          }
        })
      }
    })
  }
}

/** Display limits never modify the native labels used to encode answers. */
function displayText(text: string, maximum: number, fallback = ''): string {
  return text.replaceAll('\0', '\uFFFD').trim().slice(0, maximum) || fallback
}
