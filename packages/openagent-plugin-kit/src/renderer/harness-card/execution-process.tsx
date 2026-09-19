import { Wrench } from 'lucide-react'
import { useI18n } from '../i18n.js'
import type { ThreadDetailRow } from './thread-detail.js'
import { HarnessToolActivityGroup } from './timeline.js'
import { partitionExecutionRows } from './execution-groups.js'

/** Merge only explicitly classified adjacent work; never inspect opaque native nodes. */
export function groupThreadExecutionRows(
  rows: readonly ThreadDetailRow[],
  runIds: ReadonlyMap<string, string>
): ThreadDetailRow[] {
  return partitionExecutionRows(rows, runIds).map((run) => run.kind === 'row' ? run.row : {
    id: `execution-process:${run.id}`,
    kind: 'work',
    node: <ThreadExecutionProcess groupId={run.id} rows={run.rows} />
  })
}

function ThreadExecutionProcess(props: {
  readonly groupId: string
  readonly rows: readonly ThreadDetailRow[]
}): React.JSX.Element {
  const { t } = useI18n()
  return <HarnessToolActivityGroup
    alwaysGroup
    groupId={`execution-process:${props.groupId}`}
    className="thread-execution-process"
    summary={t('执行过程')}
    summaryLabel={t('执行过程')}
    summaryState={<Wrench size={13} />}
    // Do not pin live children outside the disclosure. A mixed run has one
    // entry, even while native reasoning and tools continue streaming.
    items={props.rows.map((row) => ({
      id: row.id,
      node: <div data-thread-row-id={row.id}>{row.node}</div>
    }))}
  />
}
