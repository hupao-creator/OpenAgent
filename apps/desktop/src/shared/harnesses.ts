/**
 * The Host Harness identity registry is code-generated from the aggregated
 * plugin module set (see scripts/generate-harness-registry.mjs). This module
 * preserves the historic `shared/harnesses` import surface.
 */
export {
  HARNESS_IDS,
  harnessDescriptors,
  harnessDisplayName,
  isHarnessId,
  type HarnessId,
  type HarnessPluginDescriptor
} from '../generated/harness-registry'

import { canHostBart } from '@openagent/contracts'
import { harnessDescriptors, isHarnessId } from '../generated/harness-registry'

export { canHostBart } from '@openagent/contracts'

export function harnessSupportsBartHost(harnessId: string): boolean {
  return isHarnessId(harnessId) && canHostBart(harnessDescriptors[harnessId].threadCapabilities)
}
