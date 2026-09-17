import type { z } from 'zod'
import type { PublicAgentInputPartSchema, PublicAgentInputSchema } from '../command-schemas.js'

export type AgentInputPart = z.infer<typeof PublicAgentInputPartSchema>
export type AgentInputPresentation = NonNullable<z.infer<typeof PublicAgentInputSchema>['presentation']> | 'internal'

/** Internal Host input additionally permits an internal presentation intent. */
export type AgentInput = Omit<z.infer<typeof PublicAgentInputSchema>, 'presentation'> & {
  /** Host presentation intent; Harness-native input converters ignore this field. */
  presentation?: AgentInputPresentation
}
