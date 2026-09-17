import assert from 'node:assert/strict'
import {
  assertContainsToken,
  assertSubsequence,
  bounded
} from '../support.mjs'

/**
 * The native question chain. The exact selected label has to reappear in the
 * completed Execution, which is the only proof that the public answer reached
 * the native session rather than being invented by the model.
 */
export const questionSuite = {
  id: 'question',
  tier: 'core',
  description: 'Native question interactions answered through the Bart',
  cases: [
    {
      id: 'single-select',
      requires: ['question'],
      description: 'the first offered option is transported back into the session',
      async run(context) {
        return runQuestionCase(context, { optionIndex: 0 })
      }
    },
    {
      id: 'distinct-answer',
      requires: ['question'],
      description: 'a non-default option proves the answer value is real',
      async run(context) {
        return runQuestionCase(context, { optionIndex: 2 })
      }
    },
    {
      id: 'multi-select',
      requires: ['question'],
      description: 'multiple selected option values are transported as one native answer',
      async run(context) {
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: multiSelectPrompt(context)
        })
        const { interaction } = await context.waitForInteraction(threadId, 'question')
        const question = interaction.questions?.[0]
        assert.ok(question, `multi-select interaction has no question: ${bounded(interaction)}`)
        assert.equal(question.multiple, true, bounded(question))
        assert.equal(question.options.length, 3, bounded(question))
        const selected = [question.options[0], question.options[2]]
        const action = interaction.actions?.find(candidate => candidate.intent === 'submit')
        assert.ok(action, `multi-select interaction has no submit action: ${bounded(interaction)}`)

        await context.respond({
          threadId,
          interaction,
          actionId: action.id,
          answers: { [question.id]: selected.map(option => option.value) }
        })
        const terminal = await context.waitForCompleted(threadId)
        const expected = `QUESTION_MULTI_OK:${context.token}:${selected.map(option => option.label).join('|')}`
        assertContainsToken(
          terminal.summary,
          expected,
          `terminal summary did not preserve the multi-select answer: ${bounded(terminal)}`
        )
        return {
          threadId,
          executionId: terminal.executionId,
          interactionId: interaction.id,
          selected: selected.map(option => option.label)
        }
      }
    },
    {
      id: 'cancel',
      requires: ['question', 'question-cancel'],
      description: 'cancelling a native question resumes without an answer',
      async run(context) {
        const cancelledMarker = `QUESTION_CANCELLED:${context.token}`
        const { threadId } = await context.start({
          cwd: context.repositoryRoot,
          worktree: false,
          options: context.options(),
          prompt: [
            questionPrompt(context),
            'If the question is cancelled instead of answered, do not ask again.',
            `Reply with exactly ${cancelledMarker} instead.`
          ].join('\n')
        })
        const { interaction } = await context.waitForInteraction(threadId, 'question')
        const response = context.answerFor(interaction, 'cancel')
        await context.respond({
          threadId,
          interaction,
          actionId: response.actionId,
          intro: 'Cancel the pending native question for this acceptance case.'
        })
        const terminal = await context.waitForTerminal(threadId)
        assertContainsToken(
          terminal.summary,
          cancelledMarker,
          `cancellation was not observed by the native agent: ${bounded(terminal)}`
        )
        return { threadId, executionId: terminal.executionId, interactionId: interaction.id }
      }
    }
  ]
}

async function runQuestionCase(context, choice) {
  const { threadId } = await context.start({
    cwd: context.repositoryRoot,
    worktree: false,
    options: context.options(),
    prompt: questionPrompt(context)
  })
  const { interaction } = await context.waitForInteraction(threadId, 'question')
  const response = context.answerFor(interaction, 'submit', choice)
  await context.respond({
    threadId,
    interaction,
    actionId: response.actionId,
    answers: response.answers
  })
  const terminal = await context.waitForCompleted(threadId)
  assertContainsToken(
    terminal.summary,
    `QUESTION_OK:${context.token}:${response.expectedLabel}`,
    `terminal summary did not contain the native question answer marker: ${bounded(terminal)}`
  )
  assertSubsequence(
    context.client.statusTransitions(threadId),
    ['running', 'waiting-for-user', 'running', 'completed'],
    'public execution transitions'
  )
  assert.equal(interaction.questions[0].multiple, false)
  return {
    threadId,
    executionId: terminal.executionId,
    interactionId: interaction.id,
    selected: response.expectedLabel
  }
}

export function questionPrompt(context) {
  return [
    `This is a native ${context.harness} question-response acceptance case.`,
    `Use the ${context.provider.questionTool} tool exactly once. Do not answer the question yourself.`,
    'Ask one single-select question with id "choice", header "Choice", and prompt "Select the acceptance value".',
    `Offer exactly three options in this order: Alpha-${context.token}, Beta-${context.token}, Gamma-${context.token}.`,
    `After the native answer arrives, output exactly QUESTION_OK:${context.token}:<selected option label>.`,
    'Do not run shell commands.'
  ].join('\n')
}

function multiSelectPrompt(context) {
  return [
    `This is a native ${context.harness} multi-select response acceptance case.`,
    `Use the ${context.provider.questionTool} tool exactly once. Do not answer the question yourself.`,
    'Ask one multi-select question with id "choice", header "Choice", and prompt "Select two acceptance values".',
    `Offer exactly three options in this order: Alpha-${context.token}, Beta-${context.token}, Gamma-${context.token}.`,
    `After the native answer arrives, output exactly QUESTION_MULTI_OK:${context.token}:<selected option labels joined by | in offered order>.`,
    'Do not run shell commands.'
  ].join('\n')
}
