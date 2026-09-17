import fc from 'fast-check'
import { expect, it } from 'vitest'
import { IncrementalMarkdownProcessor } from '../../../../packages/openagent-plugin-kit/src/renderer/markdown/incremental-markdown'
import { check } from './check'

const text = fc.array(fc.constantFrom('a', ' ', '中', '😀', '\\*', '&amp;', '`x`'), { maxLength: 8 }).map(xs => xs.join(''))
const fragment = fc.tuple(text, fc.constantFrom('paragraph', 'quote', 'list', 'table', 'fence', 'reference')).map(([s, kind]) => {
  switch (kind) {
    case 'quote': return `> ${s}\n>\n> - nested\n`
    case 'list': return `- ${s}\n  continuation\n- second\n`
    case 'table': return `| a | b |\n| --- | ---: |\n| ${s} | escaped \\| pipe |\n`
    case 'fence': return `\x60\x60\x60ts\n${s}\n\x60\x60\x60\n`
    case 'reference': return `[${s || 'link'}][target]\n\n> [target]: /target "title"\n`
    default: return `${s}\n\nheading\n---\n`
  }
})
const document = fc.array(fragment, { minLength: 1, maxLength: 6 }).map(xs => xs.join('\n'))
const steps = fc.array(fc.integer({ min: 1, max: 32 }), { minLength: 1, maxLength: 16 })
const semantic = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => key === 'position' ? undefined : value))

it('markdown prefixes match full semantic parsing', () => {
  check('markdown prefixes', fc.property(document, steps, (source, sizes) => {
    const incremental = new IncrementalMarkdownProcessor()
    let cursor = 0
    let index = 0
    while (true) {
      const prefix = source.slice(0, cursor) // UTF-16 cuts include partial surrogate pairs.
      incremental.render(prefix)
      const fresh = new IncrementalMarkdownProcessor()
      fresh.render(prefix)
      expect(semantic(incremental.snapshotMdast())).toEqual(semantic(fresh.snapshotMdast()))
      if (cursor === source.length) break
      cursor = Math.min(source.length, cursor + sizes[index++ % sizes.length])
    }
  }))
}, 130_000)
