import {
  settleOverviewReflow, settleOverviewResize, startOverviewReflowAnimations,
  startOverviewResizeAnimations, type OverviewCardMotion
} from './card-layout-motion'

export interface PlannedLayoutBeat {
  readonly owner: string
  readonly start: () => Animation[]
  readonly settle: () => void
}

/** Pure beat expansion within the existing stage FIFO; no timers or second scheduler. */
export function plannedOverviewMotionBeats(
  cards: readonly OverviewCardMotion[],
  moveOrder: readonly string[],
  clickBlockUntil: Map<string, number>
): PlannedLayoutBeat[] {
  const survivors = cards.filter(card => !card.inserted)
  const beats: PlannedLayoutBeat[] = []
  for (const card of survivors) {
    const from = card.from!
    const width = Math.min(from.width, card.to.width)
    const height = Math.min(from.height, card.to.height)
    if (from.width - width < 0.01 && from.height - height < 0.01) continue
    const shrink = { ...card, to: { ...card.to, width, height } }
    beats.push({ owner: `overview-layout:shrink:${card.id}`,
      start: () => startOverviewResizeAnimations([shrink], clickBlockUntil),
      settle: () => {
        settleOverviewResize([shrink])
        if (card.to.width > width + 0.01 || card.to.height > height + 0.01)
          card.element.dataset.overviewMotionRecomposing = 'true'
      } })
  }
  const byId = new Map(survivors.map(card => [card.id, card]))
  for (const id of moveOrder) {
    const card = byId.get(id)
    if (!card) continue
    const straight = { ...card, reflowMode: 'straight' as const }
    beats.push({ owner: `overview-layout:reflow:${id}`,
      start: () => startOverviewReflowAnimations([straight], clickBlockUntil),
      settle: () => settleOverviewReflow([straight]) })
  }
  for (const card of survivors) {
    const from = card.from!
    const width = Math.min(from.width, card.to.width)
    const height = Math.min(from.height, card.to.height)
    if (card.to.width - width < 0.01 && card.to.height - height < 0.01) continue
    const grow = { ...card, from: { ...from, width, height } }
    beats.push({ owner: `overview-layout:grow:${card.id}`,
      start: () => startOverviewResizeAnimations([grow], clickBlockUntil, true),
      settle: () => settleOverviewResize([grow], true) })
  }
  return beats
}
