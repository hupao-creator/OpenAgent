export interface AgentAttachment {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly kind: 'image' | 'document' | 'file'
}

/** Renderer-local Bart draft state; only ready attachments cross IPC. */
export type BartDraftAttachment =
  | {
      readonly id: string
      readonly status: 'pending'
      readonly name: string
      readonly size: number
      readonly mimeType: string
    }
  | {
      readonly id: string
      readonly status: 'ready'
      readonly attachment: AgentAttachment
    }
  | {
      readonly id: string
      readonly status: 'failed'
      readonly name: string
      readonly error: string
    }

export type { BartAttachmentImport } from '@openagent/contracts'
