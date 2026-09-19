/** Assign runs before a Harness projects away hidden native timeline entries. */
export function threadExecutionRunIds<T extends { readonly id: string }>(
  items: readonly T[],
  isExecution: (item: T) => boolean
): Map<string, string> {
  const ids = new Map<string, string>()
  let start: string | undefined
  for (const item of items) {
    if (!isExecution(item)) {
      start = undefined
      continue
    }
    start ??= item.id
    ids.set(item.id, start)
  }
  return ids
}

/** One settled failure makes the whole row visible; every Harness shares the rule. */
export function activityRowKind(
  activities: readonly { readonly status: string }[]
): 'attention' | 'work' {
  return activities.some((activity) => activity.status === 'failed') ? 'attention' : 'work'
}

export type ExecutionRowRun<T> =
  | { readonly kind: 'row'; readonly row: T }
  | { readonly kind: 'execution'; readonly id: string; readonly rows: readonly T[] }

/** The Harness supplies membership; work alone does not imply reasoning/tool work. */
export function partitionExecutionRows<T extends { readonly id: string; readonly kind: string }>(
  rows: readonly T[],
  runIds: ReadonlyMap<string, string>
): readonly ExecutionRowRun<T>[] {
  const result: ExecutionRowRun<T>[] = []
  let current: { kind: 'execution'; id: string; rows: T[] } | undefined
  let currentRunId: string | undefined
  for (const row of rows) {
    const runId = row.kind === 'work' ? runIds.get(row.id) : undefined
    if (runId === undefined) {
      current = undefined
      currentRunId = undefined
      result.push({ kind: 'row', row })
    } else if (current && currentRunId === runId) {
      current.rows.push(row)
    } else {
      // The run id, not the first surviving row, so the group keeps its identity
      // when that row later leaves the run.
      current = { kind: 'execution', id: runId, rows: [row] }
      currentRunId = runId
      result.push(current)
    }
  }
  return result
}
