import type { AgentThreadRecord } from '@openagent/contracts'
import type { Phase } from '../fixtures'

export interface NativePreviewInput {
  readonly threadId: string
  readonly phase: Phase
  readonly answer: string
  readonly localFive?: boolean
  readonly history: boolean
}

export type NativePreviewFixture = Pick<AgentThreadRecord, 'sessionState' | 'observation'>
