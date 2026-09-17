import type { BartDraftAttachment } from '../../shared/attachments'

/** 文本或至少一个 ready 附件可提交；任何 pending 暂存都先阻断发送。 */
export function isBartDraftSubmittable(
  text: string,
  attachments: readonly BartDraftAttachment[]
): boolean {
  const hasReadyAttachment = attachments.some((draft) => draft.status === 'ready')
  const hasPendingAttachment = attachments.some((draft) => draft.status === 'pending')
  return Boolean((text.trim() || hasReadyAttachment) && !hasPendingAttachment)
}
