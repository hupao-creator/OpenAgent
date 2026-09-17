import { createHash } from 'node:crypto'
import { isJsonValue, threadDirectoryTag, type HarnessThreadRecord, type BartThreadRecord, type DeepReadonly, type JsonObject } from '@openagent/contracts'

export function publicThreadEnvelope(
  thread: DeepReadonly<HarnessThreadRecord>
): JsonObject {
  const observation = thread.observation
  if (!isJsonValue(observation)) throw new Error('Harness 返回了非 JSON value')
  const directoryTag = threadDirectoryTag(thread)
  return {
    threadId: thread.id,
    title: thread.title,
    tags: [...thread.tags],
    harnessId: thread.harnessId,
    workspace: {
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      ...(thread.worktree?.cwd ? { worktreeCwd: thread.worktree.cwd } : {}),
      ...(directoryTag ? { directoryTag } : {})
    },
    updatedAt: thread.updatedAt,
    observation: structuredClone(observation)
  }
}

export function bartTranscriptFingerprint(
  record: DeepReadonly<BartThreadRecord>
): string {
  return createHash('sha256')
    .update(JSON.stringify(record.transcript))
    .digest('hex')
}
