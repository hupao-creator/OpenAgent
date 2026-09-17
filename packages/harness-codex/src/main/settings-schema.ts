import type { JsonObject } from '@openagent/contracts'
import {
  CODEX_PERMISSION_MODES,
  type CodexModelOption
} from '../shared/types.js'

/** GUI catalog examples guide selection; the actual target environment validates choices. */
export function describeCodexThreadSettings(models: readonly CodexModelOption[]): JsonObject {
  const efforts = [...new Set(models.flatMap(model => model.supportedReasoningEfforts.map(entry => entry.value)))]
  const serviceTiers = [...new Set(models.flatMap(model => model.serviceTiers.map(entry => entry.value)))]
  return {
    type: 'object',
    description: 'Creation options for the target Thread. Catalog examples reflect only the configured executable and workspace used to describe this schema. A different target executable or workspace may support other choices; final validation uses that target environment.',
    additionalProperties: false,
    properties: {
      model: {
        ...identifier(256),
        ...(models.length ? { examples: models.map(model => model.value) } : {}),
        description: 'Exact model identifier supported by the target Codex executable and workspace. Examples come from the description environment. Omit to inherit the Thread default or native selection.'
      },
      effort: {
        ...identifier(64),
        ...(efforts.length ? { examples: efforts } : {}),
        description: 'Reasoning effort supported by the selected model in the target environment. Examples combine capabilities observed in the description environment and may not apply to every model. Changing model clears inherited effort.'
      },
      serviceTier: {
        ...identifier(128),
        ...(serviceTiers.length ? { examples: serviceTiers } : {}),
        description: 'Native service tier supported by the selected model in the target environment. Examples combine capabilities observed in the description environment and may not apply to every model. Changing model clears inherited service tier.'
      },
      permissionMode: {
        type: 'string', enum: [...CODEX_PERMISSION_MODES],
        description: 'ask-for-approval: workspace-write, on-request, user approval. approve-for-me: workspace-write, on-request, native auto-review agent; fails when unavailable. full-access: danger-full-access, never. Omit to inherit app defaults; approve-for-me when unset.'
      }
    }
  }
}

function identifier(maxLength: number): JsonObject {
  return { type: 'string', minLength: 1, maxLength, pattern: '^\\S(?:[^\\u0000]*\\S)?$' }
}
