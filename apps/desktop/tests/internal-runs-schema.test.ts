import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { modelJsonSchema } from '../src/main/internal-run-schemas'
import {
  DEFAULT_THREAD_EMOJI,
  type JsonObject,
  type JsonValue
} from '@openagent/contracts'
import {
  ATTACHMENT_ONLY_THREAD_TITLE,
  FALLBACK_THREAD_TITLE,
  buildThreadMetadataPrompt,
  parseThreadMetadataOutput,
  placeholderThreadTitle,
  validateThreadMetadata,
  type ThreadMetadataPromptInput
} from '../src/main/internal-runs'

const input: ThreadMetadataPromptInput = {
  thread: {
    id: 'metadata-thread', harnessId: 'test', archived: false, revision: 1,
    sessionState: null, observation: { latestExecution: null, backgroundWork: null },
    title: 'Pending', tags: ['Existing'], cwd: '/workspace/project', settings: {},
    createdAt: 1, updatedAt: 1
  },
  userInput: { parts: [{ kind: 'text', text: 'Help redesign the database query planner.' }] },
  tagPool: [{ name: 'Existing', description: 'Previous classification' }]
}
const PLACEHOLDER_TITLE = 'Help redesign the database query…'
const metadata = (patch: JsonObject = {}): JsonObject => ({
  title: 'Query planner', emoji: '🔍',
  tags: [{ name: 'Database', description: 'Database query planning' }], ...patch
})
const validated = (value: JsonValue, context = input) =>
  validateThreadMetadata(parseThreadMetadataOutput(value), context)
describe('internal model output boundaries', () => {
  it('fails loudly when model conversion encounters nested runtime refinements or transforms', () => {
    for (const text of [
      z.string().refine(value => !value.includes('x')),
      z.string().transform(value => value.trim()),
      z.string().trim()
    ]) {
      expect(() => modelJsonSchema(z.strictObject({ nested: z.array(text) }))).toThrow()
    }
  })

  it('omits tautological string record-key schemas but retains constrained keys', () => {
    expect(modelJsonSchema(z.record(z.string(), z.string()))).not.toHaveProperty('propertyNames')
    expect(modelJsonSchema(z.record(z.string().min(1), z.string())).propertyNames)
      .toEqual({ type: 'string', minLength: 1 })
    expect(() => modelJsonSchema(z.record(z.string().refine(key => key !== 'forbidden'), z.string())))
      .toThrow('requires explicit JSON Schema conversion')
  })

  it('delivers closed model structures through the completion prompts', () => {
    const metadataSchema = buildThreadMetadataPrompt(input).outputFormat.schema
    const metadataProperties = metadataSchema.properties as JsonObject
    expect(metadataSchema.required).toEqual(['title', 'emoji', 'tags'])
    expect(metadataSchema.additionalProperties).toBe(false)
    expect(metadataProperties.title).toMatchObject({ minLength: 1, maxLength: 60 })
    expect(metadataProperties.tags).toMatchObject({ minItems: 1, maxItems: 1 })
  })

  it('requires own envelope fields rather than accepting inherited required values', () => {
    const inheritedMetadata = Object.assign(Object.create({ title: 'Query planner' }), { emoji: '🔍', tags: [] })
    expect(() => parseThreadMetadataOutput(inheritedMetadata)).toThrow('封闭 JSON object')
  })

  it.each(['name', 'description'])('rejects inherited or nonenumerable tag %s', field => {
    const tag = { name: 'Database', description: 'Database planning' }
    const inheritedTag = Object.assign(Object.create({ [field]: tag[field as keyof typeof tag] }), tag)
    delete inheritedTag[field]
    expect(() => parseThreadMetadataOutput(metadata({ tags: [inheritedTag] }))).toThrow('tag 形状无效')
    Object.defineProperty(tag, field, { enumerable: false })
    expect(() => parseThreadMetadataOutput(metadata({ tags: [tag] }))).toThrow('tag 形状无效')
  })

  it('rejects nonenumerable required metadata envelope fields', () => {
    for (const field of ['title', 'emoji', 'tags']) {
      const value = metadata()
      Object.defineProperty(value, field, { enumerable: false })
      expect(() => parseThreadMetadataOutput(value)).toThrow('封闭 JSON object')
    }
  })

  it('normalizes metadata and reuses the first valid tag without adding extra candidates to the pool', () => {
    expect(validated(metadata({ title: '  ## Query **planner**  ', tags: [
      { name: 'existing', description: '' },
      { name: '# Database', description: ' Database\n query planning ' },
      { name: 'DATABASE', description: 'Duplicate' }
    ] }))).toEqual({
      title: 'Query planner', emoji: '🔍', tags: ['Existing'],
      tagPool: input.tagPool
    })
  })

  it('skips invalid candidates and adds only the first valid new tag to the pool', () => {
    expect(validated(metadata({ tags: [
      { name: 'Development', description: 'Broad category' },
      { name: 'project', description: 'Workspace name' },
      { name: 'Invalid', description: '' },
      { name: '# Database', description: ' Database\n query planning ' },
      { name: 'SQL', description: 'SQL query syntax' }
    ] }))).toEqual({
      title: 'Query planner', emoji: '🔍', tags: ['Database'],
      tagPool: [...input.tagPool, { name: 'Database', description: 'Database query planning' }]
    })
  })

  it.each([
    null,
    [],
    { title: 'Title', emoji: '🔍' },
    metadata({ extra: true }),
    metadata({ title: null }),
    metadata({ emoji: 1 }),
    metadata({ tags: null }),
    metadata({ tags: [{ name: 'Database' }] }),
    metadata({ tags: [{ name: 'Database', description: 'Valid', extra: true }] }),
    metadata({ tags: [{ name: null, description: 'Valid' }] })
  ])('rejects malformed metadata structure %#', (value) => {
    expect(() => parseThreadMetadataOutput(value)).toThrow('Thread metadata')
  })

  it.each(['', 'x'.repeat(61), 'unsafe\0title', 'https://example.com', '/private/project',
    'pnpm install', 'Help redesign the database query planner.'])('uses the first-prompt placeholder for %j', title => {
    expect(validated(metadata({ title }))).toMatchObject({
      title: PLACEHOLDER_TITLE, emoji: '🔍', tags: ['Database']
    })
  })

  it('builds a single-line first-prompt placeholder that fits the Thread title bound', () => {
    expect(placeholderThreadTitle({ parts: [{ kind: 'text', text: 'Fix the login bug' }] }))
      .toBe('Fix the login bug')
    expect(placeholderThreadTitle({ parts: [{ kind: 'text', text: 'a'.repeat(80) }] }))
      .toBe(`${'a'.repeat(33)}…`)
    expect(placeholderThreadTitle({ parts: [{ kind: 'text', text: '\n  Fix\t\nthe bug  \n' }] }))
      .toBe('Fix the bug')
    for (const title of [
      placeholderThreadTitle({ parts: [{ kind: 'text', text: '🎉'.repeat(80) }] }),
      placeholderThreadTitle({ parts: [{ kind: 'text', text: `Fix\0the bug ${'x'.repeat(80)}` }] })
    ]) {
      expect(title.length).toBeLessThanOrEqual(60)
      expect(title.trim()).toBe(title)
      expect(title).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
    expect(placeholderThreadTitle({ parts: [{ kind: 'image-url', url: 'https://example.com/a.png' }] }))
      .toBe(ATTACHMENT_ONLY_THREAD_TITLE)
    expect(placeholderThreadTitle({ parts: [{ kind: 'text', text: '   ' }] }))
      .toBe(FALLBACK_THREAD_TITLE)
  })

  it('preserves tags when model guidance is violated and defaults only invalid emoji', () => {
    for (const tags of [[], [{ name: '', description: '' }],
      [{ name: 'Development', description: 'Broad category' }],
      [{ name: 'project', description: 'Workspace name' }],
      [{ name: 'x'.repeat(33), description: 'Overlong name' }],
      [{ name: 'Database', description: 'x'.repeat(121) }],
      [{ name: 'Bad\0tag', description: 'Contains NUL' }]]) {
      expect(validated(metadata({ emoji: 'not an emoji', tags }))).toEqual({
        title: 'Query planner', emoji: DEFAULT_THREAD_EMOJI,
        tags: ['Existing'], tagPool: input.tagPool
      })
    }
    expect(validated(metadata({ title: '', tags: [], emoji: '' }), {
      ...input, userInput: { parts: [{ kind: 'image-url', url: 'https://example.com/image.png' }] }
    }).title).toBe(ATTACHMENT_ONLY_THREAD_TITLE)
  })

  it('counts metadata title/tag/description Unicode code points and keeps only one valid tag', () => {
    const astral = '𠮷'
    expect(validated(metadata({ title: astral.repeat(60), tags: [
      { name: astral.repeat(32), description: astral.repeat(120) },
      { name: 'SQL', description: 'SQL query syntax' },
      { name: 'Indexing', description: 'Database indexes' },
      { name: 'Storage', description: 'Storage format' }
    ] }))).toMatchObject({
      title: astral.repeat(60), tags: [astral.repeat(32)]
    })
    expect(validated(metadata({ title: astral.repeat(61) })).title).toBe(PLACEHOLDER_TITLE)
    expect(validated(metadata({ tags: [{ name: astral.repeat(33), description: 'Too long' }] })).tags)
      .toEqual(['Existing'])
  })

})
