import { z } from 'zod'
import {
  type DeepReadonly,
  type JsonObject
} from '@openagent/contracts'

export const MAX_THREAD_TITLE_LENGTH = 60
export const MAX_THREAD_TAG_LENGTH = 32
export const MAX_THREAD_TAG_DESCRIPTION_LENGTH = 120
export const MAX_THREAD_SEMANTIC_TAGS = 1

export const GeneratedThreadTagSchema = z.strictObject({
  name: z.string(),
  description: z.string()
})
export const ThreadMetadataStructureSchema = z.strictObject({
  title: z.string(),
  emoji: z.string(),
  tags: z.array(GeneratedThreadTagSchema)
})
export type GeneratedThreadTag = Readonly<z.infer<typeof GeneratedThreadTagSchema>>
export type ParsedThreadMetadata = DeepReadonly<z.infer<typeof ThreadMetadataStructureSchema>>

// Model constraints guide generation; runtime only parses the closed structure.
// Empty/overlong/semantically invalid metadata must still reach title/emoji
// fallbacks and tag preservation. Semantic lengths count Unicode code points.
const ThreadMetadataModelSchema = ThreadMetadataStructureSchema.extend({
  title: ThreadMetadataStructureSchema.shape.title.min(1).max(MAX_THREAD_TITLE_LENGTH)
    .describe('A concise recognizable summary, not a copy of the task.'),
  emoji: ThreadMetadataStructureSchema.shape.emoji.min(1).max(32)
    .describe('Exactly one emoji representing the task, without text or Markdown.'),
  tags: z.array(GeneratedThreadTagSchema.extend({
    name: GeneratedThreadTagSchema.shape.name.min(1).max(MAX_THREAD_TAG_LENGTH),
    description: GeneratedThreadTagSchema.shape.description.min(1).max(MAX_THREAD_TAG_DESCRIPTION_LENGTH)
  })).min(1).max(MAX_THREAD_SEMANTIC_TAGS)
})

// Zod rejects transforms/custom schemas, but can silently omit refinements and
// overwrites. Only the representable length checks used by these model contracts
// are admitted here; adding a different check requires an explicit conversion
// decision. The override visits nested schemas as well as the root. Draft 7
// preserves the existing nullable anyOf shape consumed by completions.
export function modelJsonSchema(schema: z.ZodType): JsonObject {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, {
    target: 'draft-7',
    unrepresentable: 'throw',
    override: ({ zodSchema, jsonSchema }) => {
      // JSON object keys are already strings. Omit this unconstrained record-key
      // tautology to preserve the native completion schema's existing vocabulary;
      // constrained propertyNames remain intact and key refinements still fail.
      const propertyNames = jsonSchema.propertyNames
      if (typeof propertyNames === 'object' && propertyNames !== null &&
          propertyNames.type === 'string' && Object.keys(propertyNames).length === 1) {
        delete jsonSchema.propertyNames
      }
      for (const check of zodSchema._zod.def.checks ?? []) {
        if (!['min_length', 'max_length'].includes(check._zod.def.check)) {
          throw new Error(`Model output schema check requires explicit JSON Schema conversion: ${check._zod.def.check}`)
        }
      }
    }
  })
  return result as JsonObject
}

export const THREAD_METADATA_OUTPUT_SCHEMA = modelJsonSchema(ThreadMetadataModelSchema)
