import { backgroundSuite } from './background.mjs'
import { hostSuite } from './host.mjs'
import { combinationSuite } from './combination.mjs'
import { lifecycleSuite } from './lifecycle.mjs'
import { permissionSuite } from './permission.mjs'
import { questionSuite } from './question.mjs'
import { reportsSuite } from './reports.mjs'
import { resilienceSuite } from './resilience.mjs'
import { scheduleSuite } from './schedule.mjs'
import { terminalHistorySuite } from './terminal-history.mjs'
import { workspaceSuite } from './workspace.mjs'

/**
 * Declaration order is the default execution order inside one worker: cheap
 * observation first, composed journeys last.
 */
export const SUITES = [
  hostSuite,
  lifecycleSuite,
  permissionSuite,
  questionSuite,
  backgroundSuite,
  workspaceSuite,
  reportsSuite,
  scheduleSuite,
  resilienceSuite,
  terminalHistorySuite,
  combinationSuite
]

export const TIERS = ['core', 'extended', 'complex']

export function suiteById(id) {
  return SUITES.find(suite => suite.id === id)
}

export function suitesForTier(tier) {
  return SUITES.filter(suite => suite.tier === tier)
}
