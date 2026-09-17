import { parseThreadPublicObservation, type HarnessSessionStateAdapter, type JsonValue } from '@openagent/contracts'
import type {
  AgentThreadRecord,
  DeepReadonly,
  HarnessThreadOpenContext,
  ThreadPublicObservation
} from '@openagent/contracts'
import type { BartTelemetryLedgerCapability } from '@openagent/contracts'

/**
 * Test-only capture shape for the public plugin boundary.  `state` is the
 * opaque plugin payload; `observation` is the Core-facing projection.  The
 * derived lifecycle field keeps older behavioral assertions readable without
 * reintroducing lifecycle into the production Agent Thread contract.
 */
export interface TestAgentChange {
  readonly state?: JsonValue
  readonly observation?: ThreadPublicObservation
  readonly lifecycle?:
    | { readonly type: 'started'; readonly executionId: string }
    | {
        readonly type: 'terminal'
        readonly executionId: string
        readonly outcome: 'completed' | 'failed' | 'interrupted'
      }
}

export function createAgentOpenContext<
  Id extends string,
  ThreadSettings
>(input: {
  readonly sessionState: HarnessSessionStateAdapter
  readonly getRecord: () => AgentThreadRecord<Id, ThreadSettings>
  readonly setRecord: (record: AgentThreadRecord<Id, ThreadSettings>) => void
  readonly changes?: TestAgentChange[]
  readonly signal?: AbortSignal
  readonly createExecutionId?: () => string
  readonly telemetryLedger?: BartTelemetryLedgerCapability
  readonly onChange?: (change: TestAgentChange) => void | Promise<void>
}): HarnessThreadOpenContext<Id, ThreadSettings> {
  let queue: Promise<void> = Promise.resolve()
  let startedExecutionId: string | undefined
  let pendingClaim: { readonly executionId: string; abandoned: boolean } | undefined
  let claimSequence = 0

  const emit = async (change: TestAgentChange): Promise<void> => {
    await input.onChange?.(change)
    input.changes?.push(structuredClone(change))
  }

  return {
    thread: {
      id: input.getRecord().id,
      read: () => input.getRecord() as DeepReadonly<AgentThreadRecord<Id, ThreadSettings>>
    },
    sessionState: {
      read: () => input.getRecord().sessionState,
      commit: data => {
        let state: JsonValue
        let observation: ThreadPublicObservation
        try {
          state = structuredClone(data)
          observation = parseThreadPublicObservation(input.sessionState.project(state))
        } catch (error) {
          return Promise.reject(error)
        }
        const operation = queue.then(async () => {
          const current = input.getRecord()
          if (JSON.stringify(current.observation) === JSON.stringify(observation) &&
              JSON.stringify(current.sessionState) === JSON.stringify(state)) return
          const execution = observation.latestExecution
          const previousExecution = current.observation.latestExecution
          let lifecycle: TestAgentChange['lifecycle']
          if (
            execution &&
            (execution.status === 'running' || execution.status === 'waiting-for-user') &&
            startedExecutionId !== execution.executionId
          ) {
            lifecycle = { type: 'started', executionId: execution.executionId }
          } else if (
            execution &&
            (
              startedExecutionId === execution.executionId ||
              (
                previousExecution?.executionId === execution.executionId &&
                (previousExecution.status === 'running' ||
                  previousExecution.status === 'waiting-for-user')
              )
            ) &&
            (execution.status === 'completed' ||
              execution.status === 'failed' ||
              execution.status === 'interrupted')
          ) {
            lifecycle = {
              type: 'terminal',
              executionId: execution.executionId,
              outcome: execution.status
            }
          }
          await emit({
            state,
            observation,
            lifecycle
          })
          input.setRecord({
            ...current,
            revision: current.revision + 1,
            updatedAt: current.updatedAt + 1,
            sessionState: state,
            observation
          })
          if (lifecycle?.type === 'started') {
            startedExecutionId = lifecycle.executionId
            if (pendingClaim?.executionId === lifecycle.executionId) pendingClaim = undefined
          } else if (lifecycle?.type === 'terminal') {
            startedExecutionId = undefined
          }
        })
        queue = operation.catch(() => undefined)
        return operation
      }
    },
    executionClaims: {
      claim: () => {
        if (startedExecutionId || pendingClaim) {
          throw new Error('Thread 已有 active 或 pending Execution')
        }
        const executionId = input.createExecutionId?.() ??
          `test-native-execution-${++claimSequence}`
        const claim = { executionId, abandoned: false }
        pendingClaim = claim
        return {
          executionId,
          abandon: () => {
            if (claim.abandoned || pendingClaim !== claim) return
            claim.abandoned = true
            pendingClaim = undefined
          }
        }
      }
    },
    executionAdmission: {
      admit: async () => undefined
    },
    telemetryLedger: input.telemetryLedger ?? {
      record: async () => undefined,
      read: () => ({ windows: [] })
    },
    signal: input.signal ?? new AbortController().signal
  }
}
