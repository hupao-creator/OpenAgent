import type { JsonObject } from '@openagent/contracts'
import type { HarnessBartForeground } from '@openagent/contracts/renderer'

export const CODEX_PERMISSION_MODES = ['ask-for-approval', 'approve-for-me', 'full-access'] as const
export type CodexPermissionMode = (typeof CODEX_PERMISSION_MODES)[number]
export const CODEX_DEFAULT_PERMISSION_MODE: CodexPermissionMode = 'approve-for-me'
export const CODEX_APPROVALS_REVIEWERS = ['user', 'auto_review'] as const

export const CODEX_PERSONALITIES = ['none', 'friendly', 'pragmatic'] as const
export const CODEX_APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'] as const
export const CODEX_SANDBOXES = [
  'read-only',
  'workspace-write',
  'danger-full-access'
] as const
export const CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const

export type CodexPersonality = (typeof CODEX_PERSONALITIES)[number]
export type CodexApprovalPolicy = (typeof CODEX_APPROVAL_POLICIES)[number]
export type CodexSandboxMode = (typeof CODEX_SANDBOXES)[number]
export type CodexReasoningSummary = (typeof CODEX_REASONING_SUMMARIES)[number]

export type CodexSandboxPolicy =
  | { readonly type: 'dangerFullAccess' }
  | { readonly type: 'readOnly'; readonly networkAccess: boolean }
  | {
      readonly type: 'externalSandbox'
      readonly networkAccess: 'restricted' | 'enabled'
    }
  | {
      readonly type: 'workspaceWrite'
      readonly writableRoots: readonly string[]
      readonly networkAccess: boolean
      readonly excludeTmpdirEnvVar: boolean
      readonly excludeSlashTmp: boolean
    }

/** Settings persisted with a Codex thread and read by every reconstructed handle. */
export interface CodexThreadSettings {
  /** The executable identity is fixed with the Primary Native Session. */
  readonly executablePath?: string
  readonly model?: string
  readonly effort?: string
  readonly serviceTier?: string
  readonly personality?: CodexPersonality
  readonly approvalPolicy?: CodexApprovalPolicy
  readonly approvalsReviewer?: (typeof CODEX_APPROVALS_REVIEWERS)[number]
  readonly sandbox?: CodexSandboxMode
  readonly sandboxPolicy?: CodexSandboxPolicy
  readonly summary?: CodexReasoningSummary
  /** Public permission preset; resolved into native fields at creation. */
  readonly permissionMode?: CodexPermissionMode
}

/** Generic new-Thread choices, shared by UI creation and Core composition. */
export interface CodexThreadSettingsRequest {
  readonly model?: string
  readonly effort?: string
  readonly serviceTier?: string
  readonly permissionMode?: CodexPermissionMode
}

/** Renderer update DTO: null explicitly restores the corresponding native default. */
export interface CodexThreadSettingsUpdate {
  readonly model?: string | null
  readonly effort?: string | null
  readonly serviceTier?: string | null
  readonly personality?: CodexPersonality | null
  readonly approvalPolicy?: CodexApprovalPolicy | null
  readonly sandbox?: CodexSandboxMode | null
  readonly sandboxPolicy?: CodexSandboxPolicy | null
  readonly summary?: CodexReasoningSummary | null
  readonly permissionMode?: CodexPermissionMode | null
}

export interface CodexHarnessSettings {
  /** False while the settings page shows these Thread defaults for editing. */
  readonly useDefaultThreadSettings?: boolean
  readonly threadSettings: CodexThreadSettings
}

export interface CodexPromptSettings {
  readonly executablePath?: string
  readonly model?: string
  readonly effort?: string
  readonly serviceTier?: string
}

export interface CodexModelOption {
  readonly value: string
  readonly displayName: string
  readonly description?: string
  readonly isDefault?: boolean
  readonly defaultReasoningEffort?: string
  readonly supportedReasoningEfforts: readonly {
    readonly value: string
    readonly description?: string
  }[]
  readonly serviceTiers: readonly {
    readonly value: string
    readonly displayName?: string
  }[]
}

export interface CodexSettingsPresentationData {
  readonly cli: {
    readonly available: boolean
    readonly executable?: string
    readonly version?: string
    readonly error?: string
  }
  readonly models: readonly CodexModelOption[]
  readonly modelsError?: string
}

export interface CodexAttachment {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly size: number
  readonly kind: 'image' | 'audio' | 'file'
}

export interface CodexMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly kind: 'prompt' | 'follow-up' | 'answer'
  readonly content: string
  readonly createdAt: number
  readonly attachments: readonly CodexAttachment[]
  readonly internal?: true
}

export interface CodexPlanStep {
  readonly step: string
  readonly status: 'pending' | 'inProgress' | 'completed'
}

export interface CodexActivity {
  readonly id: string
  readonly kind:
    | 'command'
    | 'file'
    | 'tool'
    | 'search'
    | 'agent'
    | 'subagent'
    | 'review'
    | 'hook'
  readonly label: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled'
  /** Canonical native tool name, present on tool-kind activities. */
  readonly toolName?: string
  readonly detail?: string
}

export interface CodexInteractionQuestion {
  readonly id: string
  readonly header?: string
  readonly prompt: string
  readonly secret: boolean
  readonly allowOther: boolean
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly description?: string
  }[]
}

interface CodexInteractionBase {
  readonly id: string
  readonly title: string
  readonly detail?: string
  readonly blocksTurn: boolean
  readonly status:
    | 'pending'
    | 'allowed'
    | 'denied'
    | 'submitted'
    | 'cancelled'
    | 'resolved'
  readonly resolution?: string
  readonly actions: readonly {
    readonly id: 'allow-once' | 'allow-session' | 'deny' | 'cancel' | 'submit'
    readonly intent: 'allow' | 'deny' | 'cancel' | 'submit'
    readonly label: string
  }[]
  readonly questions: readonly CodexInteractionQuestion[]
}

/** Native MCP semantics remain explicit inside the Codex plugin. */
export type CodexInteraction = CodexInteractionBase & (
  | {
      readonly kind: 'command-approval' | 'file-approval' | 'permissions' | 'user-input'
    }
  | {
      readonly kind: 'mcp-elicitation'
      readonly elicitation:
        | {
            readonly mode: 'form'
            readonly requestedSchema: JsonObject
            readonly questionId: string
          }
        | {
            readonly mode: 'url'
            readonly url: string
          }
    }
)

export interface CodexUsage {
  readonly inputTokens?: number
  readonly cachedInputTokens?: number
  readonly outputTokens?: number
  readonly reasoningTokens?: number
  readonly contextWindow?: number
}

export type CodexTimelineTextStatus =
  | 'complete'
  | 'streaming'
  | 'failed'
  | 'cancelled'

interface CodexTimelineItemBase {
  readonly id: string
  readonly createdAt: number
}

/** Codex-private occurrence order; Core never parses or persists a parallel event union. */
export type CodexTimelineItem =
  | (CodexTimelineItemBase & {
      readonly kind: 'user-message'
      readonly messageId: string
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'assistant'
      readonly itemId: string
      readonly content: string
      readonly status: CodexTimelineTextStatus
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'reasoning'
      readonly content: string
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'activity'
      readonly activityId: string
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'interaction'
      readonly interactionId: string
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'notice'
      readonly noticeId: string
    })
  | (CodexTimelineItemBase & {
      readonly kind: 'plan' | 'diff' | 'review' | 'context-compaction' | 'error'
    })

export interface CodexTurn {
  readonly executionId: string
  readonly createdAt: number
  readonly updatedAt: number
  /** Set once when foreground execution ends; later Session activity cannot change it. */
  readonly finishedAt?: number
  readonly status: 'running' | 'waiting-input' | 'completed' | 'failed' | 'interrupted'
  readonly statusLabel?: string
  /**
   * Foreground semantic activity, maintained where native events are accepted.
   * Absent until the first such event; a new Turn therefore starts clean.
   */
  readonly foreground?: HarnessBartForeground
  /**
   * A semantic event the timeline does not carry. Only the markers dedupe by
   * kind, so a repeated plan, diff or review update leaves the timeline as it
   * was — and would otherwise read as reasoning that never stopped. Cleared by
   * the next reasoning delta, whose arrival it ends.
   */
  readonly reasoningBreak?: boolean
  readonly runtimeModel?: string
  readonly messages: readonly CodexMessage[]
  readonly timeline: readonly CodexTimelineItem[]
  readonly answer: string
  readonly reasoning: string
  readonly plan: readonly CodexPlanStep[]
  readonly planExplanation?: string
  readonly activities: readonly CodexActivity[]
  readonly interactions: readonly CodexInteraction[]
  readonly notices: readonly {
    readonly id: string
    readonly level: 'info' | 'warning' | 'error'
    readonly message: string
  }[]
  readonly usage?: CodexUsage
  readonly diff?: string
  readonly review?: string
  readonly contextCompacted?: boolean
  readonly error?: string
}

export interface CodexNativeActivity {
  readonly status: string
  readonly detail?: string
  readonly updatedAt: number
}

/** Process-local Codex app-server fact; controls and process handles never enter state. */
export interface CodexBackgroundTerminal {
  readonly id: string
  readonly command: string
  readonly cwd: string
}

export interface CodexHarnessState {
  readonly schema: 'openagent.harness.codex.thread.v1'
  readonly primarySessionId?: string
  /** Native dynamic tool definitions are fixed when the Primary Session starts. */
  readonly nativeToolConfiguration?: string
  readonly nativeToolMode?: 'extend' | 'exclusive'
  /** Full prior native Thread items replayed as untrusted context after tool changes. */
  readonly nativeHistorySeed?: string
  readonly updatedAt: number
  readonly nativeActivity?: CodexNativeActivity
  readonly backgroundTerminals: readonly CodexBackgroundTerminal[]
  readonly turns: CodexTurn[]
}

export type CodexNativeEvent =
  | { readonly type: 'session'; readonly sessionId: string }
  | { readonly type: 'status'; readonly label?: string }
  | { readonly type: 'runtime-model'; readonly model: string }
  | { readonly type: 'text-delta'; readonly itemId: string; readonly delta: string }
  | {
      readonly type: 'text-final'
      readonly itemId: string
      /** Last native assistant item, retained for native parity. */
      readonly text: string
      /** Authoritative display aggregate when a turn has multiple items. */
      readonly displayText?: string
    }
  | { readonly type: 'reasoning-delta'; readonly delta: string }
  | {
      readonly type: 'plan'
      readonly steps: readonly CodexPlanStep[]
      readonly explanation?: string
    }
  | { readonly type: 'diff'; readonly diff: string }
  | { readonly type: 'review'; readonly review: string }
  | { readonly type: 'context-compacted' }
  | { readonly type: 'activity-start'; readonly activity: CodexActivity }
  | {
      readonly type: 'activity-update'
      readonly activityId: string
      readonly detail: string
    }
  | {
      readonly type: 'activity-end'
      readonly activityId: string
      readonly status: 'completed' | 'failed' | 'cancelled'
      readonly detail?: string
    }
  | { readonly type: 'interaction-opened'; readonly interaction: CodexInteraction }
  | {
      readonly type: 'interaction-closed'
      readonly interactionId: string
      readonly resolution: string
    }
  | { readonly type: 'usage'; readonly usage: CodexUsage }
  | {
      /** Plugin-private, additive usage for one native model response. */
      readonly type: 'generation-usage'
      /** Durable Codex thread/session identity; never exposed outside the Plugin. */
      readonly nativeSessionId: string
      readonly generationId: string
      readonly model: string
      readonly usage: {
        readonly inputTokens?: number
        readonly cachedInputTokens?: number
        readonly cacheWriteInputTokens?: number
        readonly outputTokens?: number
        readonly reasoningOutputTokens?: number
      }
    }
  | { readonly type: 'warning'; readonly message: string }
  | { readonly type: 'error'; readonly message: string }
  | {
      readonly type: 'done'
      readonly outcome: 'completed' | 'failed' | 'interrupted'
    }
