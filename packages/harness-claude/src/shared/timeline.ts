import type { ClaudeTimelineItem, ClaudeTurn } from './state.js'

const REPLACE_TIMELINE_KINDS = new Set<ClaudeTimelineItem['kind']>([
  'plan',
  'usage',
  'review'
])

/**
 * Project the current turn, rather than replaying checkpoint history. Entity
 * collections own current state; history supplies each entity's first position.
 * Keeping that original row identity also preserves expanded UI across updates.
 * A historical snapshot whose entity was removed cannot restore a live control.
 */
export function projectClaudeTimeline(turn: ClaudeTurn): ClaudeTimelineItem[] {
  const activities = new Map(turn.activities.map((activity) => [activity.id, activity]))
  const interactions = new Map(turn.interactions.map((interaction) => [interaction.id, interaction]))
  const lastReplaceIndexes = new Map<ClaudeTimelineItem['kind'], number>()
  turn.timeline.forEach((item, index) => {
    if (REPLACE_TIMELINE_KINDS.has(item.kind)) lastReplaceIndexes.set(item.kind, index)
  })

  const seenActivities = new Set<string>()
  const seenInteractions = new Set<string>()
  const projected: ClaudeTimelineItem[] = []
  turn.timeline.forEach((item, index) => {
    if (item.kind === 'diff') return
    if (item.kind === 'activity') {
      const activity = activities.get(item.activity.id)
      if (!activity || seenActivities.has(activity.id)) return
      seenActivities.add(activity.id)
      projected.push({ ...item, activity })
      return
    }
    if (item.kind === 'interaction') {
      const interaction = interactions.get(item.interaction.id)
      if (!interaction || seenInteractions.has(interaction.id)) return
      seenInteractions.add(interaction.id)
      projected.push({ ...item, interaction })
      return
    }
    if (
      REPLACE_TIMELINE_KINDS.has(item.kind) &&
      lastReplaceIndexes.get(item.kind) !== index
    ) return
    projected.push(item)
  })
  return projected
}

/**
 * The projected activities that begin a run of adjacent work. Projection drops
 * non-activity entries — diffs, superseded snapshots, entities that no longer
 * exist — so the projected array can no longer show where work was interrupted;
 * the original timeline still holds every boundary.
 *
 * A boundary is held until an activity snapshot that survives projection, which
 * is the first snapshot of an entity that still exists, so neither an
 * intervening duplicate nor a dropped snapshot can swallow the boundary that
 * preceded it.
 */
export function claudeActivityRunStarts(turn: ClaudeTurn): Set<string> {
  const current = new Set(turn.activities.map((activity) => activity.id))
  const starts = new Set<string>()
  const seen = new Set<string>()
  let boundary = true
  for (const item of turn.timeline) {
    if (item.kind !== 'activity') {
      boundary = true
      continue
    }
    // Mirror projection exactly: a snapshot of an entity that no longer exists
    // is dropped there, so it must not consume a boundary here either.
    if (!current.has(item.activity.id) || seen.has(item.activity.id)) continue
    seen.add(item.activity.id)
    if (boundary) starts.add(item.id)
    boundary = false
  }
  return starts
}
