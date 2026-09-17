import type { PublicInteraction, PublicInteractionQuestion } from '@openagent/contracts'

export const EMPTY_PUBLIC_INTERACTIONS: ReadonlyMap<string, PublicInteraction> = new Map()

/** Join private presentation to response authority by identity, never array position. */
export function bindPublicInteractions<Native extends { readonly id: string }>(
  native: readonly Native[],
  observed: readonly PublicInteraction[],
  project: (interaction: Native) => PublicInteraction
): ReadonlyMap<string, PublicInteraction> {
  const byId = new Map(observed.map(interaction => [interaction.id, interaction]))
  if (native.length !== observed.length || byId.size !== observed.length) return EMPTY_PUBLIC_INTERACTIONS
  const result = new Map<string, PublicInteraction>()
  for (const interaction of native) {
    const expected = project(interaction)
    const actual = byId.get(expected.id)
    if (!actual || result.has(interaction.id) || !sameInteraction(expected, actual)) return EMPTY_PUBLIC_INTERACTIONS
    result.set(interaction.id, actual)
    byId.delete(expected.id)
  }
  return byId.size || result.size === 0 ? EMPTY_PUBLIC_INTERACTIONS : result
}

function sameInteraction(expected: PublicInteraction, actual: PublicInteraction): boolean {
  return expected.id === actual.id && expected.kind === actual.kind &&
    expected.title === actual.title && expected.description === actual.description &&
    expected.actions.length === actual.actions.length &&
    expected.actions.every((action, index) => {
      const other = actual.actions[index]!
      return action.id === other.id && action.intent === other.intent && action.label === other.label
    }) && expected.questions.length === actual.questions.length &&
    expected.questions.every((question, index) => sameQuestion(question, actual.questions[index]!))
}

function sameQuestion(expected: PublicInteractionQuestion, actual: PublicInteractionQuestion): boolean {
  return expected.id === actual.id && expected.prompt === actual.prompt &&
    expected.header === actual.header && expected.multiple === actual.multiple &&
    expected.allowOther === actual.allowOther && expected.secret === actual.secret &&
    expected.options.length === actual.options.length &&
    expected.options.every((option, index) => {
      const other = actual.options[index]!
      return option.value === other.value && option.label === other.label &&
        option.description === other.description
    })
}
