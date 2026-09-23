import { createStore } from 'zustand/vanilla'
import type { AgentAttachment, BartDraftAttachment } from '../../shared/attachments'
import type { DesktopApi } from '../../shared/desktop-api'
import { buildAgentInput } from './components/BartThreadView'
import { directoryMentionParts, insertDirectoryMention, reconcileDirectoryMentions, type DirectoryMention, type MentionQuery } from './directory-mentions'
import type { KnownDirectory } from '../../shared/known-directory'

const MAX_BART_ATTACHMENTS = 20
// At most 101 interleaved text/mention parts plus 20 attachments: below the 128-part wire limit.
const MAX_DIRECTORY_MENTIONS = 50
export const ATTACHMENT_LIMIT_ERROR = '附件数量不能超过 20 个'
export const ATTACHMENT_IMPORT_BUSY_ERROR = '附件正在处理中，请稍候'

export function createBartComposerStore() {
  const store = createStore(() => ({
    text: '',
    mentions: [] as readonly DirectoryMention[],
    editRevision: 0,
    attachments: [] as readonly BartDraftAttachment[],
    submitting: false,
    clearing: false,
    importing: false
  }))
  const updateAttachments = (update: (current: readonly BartDraftAttachment[]) => readonly BartDraftAttachment[]) =>
    store.setState(state => ({ attachments: update(state.attachments) }))
  const setText = (text: string) =>
    store.setState(state => ({ text, mentions: reconcileDirectoryMentions(state.text, text, state.mentions), editRevision: state.editRevision + 1 }))
  const clearSubmitted = (revision: number, submitted: readonly BartDraftAttachment[]) =>
    store.setState(state => ({
      text: state.editRevision === revision ? '' : state.text,
      mentions: state.editRevision === revision ? [] : state.mentions,
      attachments: state.attachments.filter(draft => !submitted.some(item =>
        item === draft || (item.status === 'pending' && item.id === draft.id)))
    }))
  return Object.assign(store, {
    setText,
    insertMention(query: MentionQuery, directory: KnownDirectory): number | undefined {
      const state = store.getState()
      const inserted = insertDirectoryMention(state.text, state.mentions, query, directory)
      if (inserted.mentions.length > MAX_DIRECTORY_MENTIONS) return undefined
      store.setState({ text: inserted.text, mentions: inserted.mentions, editRevision: state.editRevision + 1 })
      return inserted.caret
    },
    removeAttachment: (id: string) => updateAttachments(current => current.filter(draft =>
      (draft.status === 'ready' ? draft.attachment.id : draft.id) !== id)),
    async chooseFiles(api: DesktopApi, cwd: string) {
      const state = store.getState()
      if (state.importing) throw new Error(ATTACHMENT_IMPORT_BUSY_ERROR)
      const remaining = remainingBartAttachmentCapacity(state.attachments)
      if (!remaining) throw new Error(ATTACHMENT_LIMIT_ERROR)
      store.setState({ importing: true })
      try {
        const selected = await api.chooseFiles(cwd, remaining)
        updateAttachments(current => mergeReadyAttachments(current, selected))
      } finally { store.setState({ importing: false }) }
    },
    async pasteFiles(api: DesktopApi, files: File[]) {
      if (!files.length) return
      const state = store.getState()
      if (state.importing) throw new Error(ATTACHMENT_IMPORT_BUSY_ERROR)
      if (files.length > remainingBartAttachmentCapacity(state.attachments)) throw new Error(ATTACHMENT_LIMIT_ERROR)
      store.setState({ importing: true })
      const pending = files.map(file => ({
        id: `pending:${crypto.randomUUID()}`, status: 'pending' as const,
        name: file.name, size: file.size, mimeType: file.type || 'application/octet-stream'
      }))
      updateAttachments(current => [...current, ...pending])
      try {
        const staged = await api.stageBartAttachments(files)
        updateAttachments(current => resolvePending(current, pending, staged))
      } catch (cause) {
        updateAttachments(current => failPending(current, pending, cause))
        throw cause
      } finally { store.setState({ importing: false }) }
    },
    async submit(api: DesktopApi, directoryTag: string) {
      const state = store.getState()
      if (state.submitting || state.clearing || state.attachments.some(draft => draft.status === 'pending')) return
      const ready = state.attachments.flatMap(draft => draft.status === 'ready' ? [draft.attachment] : [])
      if (!state.text.trim() && !ready.length) return
      store.setState({ submitting: true })
      try {
        await api.submitBartMessage({
          input: { parts: [...directoryMentionParts(state.text, state.mentions), ...buildAgentInput('', ready).parts] },
          ...(directoryTag ? { directoryTag } : {})
        })
        clearSubmitted(state.editRevision, state.attachments.filter(draft => draft.status === 'ready'))
      } finally { store.setState({ submitting: false }) }
    },
    async clear(api: DesktopApi) {
      const state = store.getState()
      if (state.clearing || state.submitting) return
      store.setState({ clearing: true })
      try {
        await api.clearBartSession()
        clearSubmitted(state.editRevision, state.attachments)
      } finally { store.setState({ clearing: false }) }
    }
  })
}
export type BartComposerStore = ReturnType<typeof createBartComposerStore>

function mergeReadyAttachments(
  current: readonly BartDraftAttachment[],
  selected: readonly AgentAttachment[]
): BartDraftAttachment[] {
  const existing = new Set(current.flatMap((draft) =>
    draft.status === 'ready' ? [draft.attachment.id] : []
  ))
  const merged = [
    ...current,
    ...selected.filter((attachment) => !existing.has(attachment.id)).map((attachment) => ({
      id: attachment.id,
      status: 'ready' as const,
      attachment
    }))
  ]
  if (merged.length > MAX_BART_ATTACHMENTS) throw new Error(ATTACHMENT_LIMIT_ERROR)
  return merged
}

function resolvePending(
  current: readonly BartDraftAttachment[],
  pending: ReadonlyArray<Extract<BartDraftAttachment, { status: 'pending' }>>,
  staged: readonly AgentAttachment[]
): BartDraftAttachment[] {
  const indexes = new Map(pending.map((item, index) => [item.id, index]))
  return current.map((draft) => {
    if (draft.status !== 'pending') return draft
    const index = indexes.get(draft.id)
    const attachment = index === undefined ? undefined : staged[index]
    return attachment
      ? { id: draft.id, status: 'ready' as const, attachment }
      : draft
  })
}

function remainingBartAttachmentCapacity(
  current: readonly BartDraftAttachment[]
): number {
  return Math.max(0, MAX_BART_ATTACHMENTS - current.length)
}

function failPending(
  current: readonly BartDraftAttachment[],
  pending: ReadonlyArray<Extract<BartDraftAttachment, { status: 'pending' }>>,
  cause: unknown
): BartDraftAttachment[] {
  const pendingById = new Map(pending.map((item) => [item.id, item]))
  const message = errorMessage(cause)
  return current.map((draft) => {
    const item = draft.status === 'pending' ? pendingById.get(draft.id) : undefined
    return item ? { id: item.id, status: 'failed', name: item.name, error: message } : draft
  })
}


function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
