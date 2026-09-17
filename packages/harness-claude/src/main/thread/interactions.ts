import type { HarnessRespondRequest } from '@openagent/contracts'
import { isJsonValue, type JsonObject } from '@openagent/contracts'
import { type ClaudeInteraction } from '../../shared/state.js'
import { claudePublicOptionId, claudePublicQuestionId } from '../../shared/public-interactions.js'
import { isRecord } from './values.js'

export function normalizeClaudeResponse(
  value: HarnessRespondRequest,
  interaction: ClaudeInteraction,
  executionId: string
): JsonObject {
  const interactionId = value.interactionId
  const actionId = value.actionId
  if (typeof interactionId !== 'string' || !interactionId.trim() ||
      typeof actionId !== 'string' || !actionId.trim()) {
    throw new Error('Claude interaction response 缺少 interactionId/actionId')
  }
  if (actionId === 'allow-session' && interaction.canRemember !== true) {
    throw new Error('Claude permission 不支持会话级授权')
  }
  const behavior = actionId === 'allow-session' ? 'allow' : actionId
  const nativeResponse = claudeNativeResponse(
    interaction,
    value.answers,
    executionId
  )
  return {
    interactionId: interaction.id,
    behavior,
    ...(actionId === 'allow-session' ? { remember: true } : {}),
    ...nativeResponse,
    ...(value.message === undefined ? {} : { message: value.message })
  }
}

function claudeNativeResponse(
  interaction: ClaudeInteraction,
  answers: HarnessRespondRequest['answers'],
  executionId: string
): JsonObject {
  if (!answers) return {}
  if (interaction.kind === 'elicitation') {
    const encoded = answers[
      claudePublicQuestionId(executionId, interaction.id, 0)
    ]
    if (typeof encoded !== 'string') {
      throw new Error('Claude elicitation 缺少 values answer')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch (error) {
      throw new Error('Claude elicitation values 不是有效 JSON', { cause: error })
    }
    if (!isRecord(parsed) || !isJsonValue(parsed)) {
      throw new Error('Claude elicitation values 必须是 JSON object')
    }
    return { values: parsed }
  }
  if (interaction.kind === 'question') {
    const questionResponses: JsonObject[] = []
    for (const [index, question] of (interaction.questions || []).entries()) {
      const answer = answers[
        claudePublicQuestionId(executionId, interaction.id, index)
      ]
      if (answer === undefined) continue
      const values = (Array.isArray(answer) ? answer : [answer]).map(
        (candidate): JsonObject => {
          const optionIndex = question.options.findIndex(
            (_option, candidateIndex) => claudePublicOptionId(
              executionId,
              interaction.id,
              index,
              candidateIndex
            ) === candidate
          )
          return optionIndex >= 0
            ? { optionIndex }
            : { text: candidate }
        }
      )
      questionResponses.push({
        questionIndex: index,
        multiple: question.multiSelect,
        values
      })
    }
    return { questionResponses }
  }
  const message = answers[
    claudePublicQuestionId(executionId, interaction.id, 0)
  ]
  return message === undefined ? {} : { message }
}
