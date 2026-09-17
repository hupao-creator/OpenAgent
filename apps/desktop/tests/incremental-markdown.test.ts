import { describe, expect, it } from 'vitest'
import { IncrementalMarkdownProcessor } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/incremental-markdown'

describe('IncrementalMarkdownProcessor', () => {
  it('matches a fresh parse at every adversarial append boundary', () => {
    const fixture = [
      '# Boundary fixture',
      '',
      'paragraph that can become a setext heading',
      '---',
      '',
      '> quote',
      '> lazy continuation',
      '>',
      '> - nested list',
      '',
      '- first',
      '  continuation',
      '- second',
      '',
      '| a | b |',
      '| --- | ---: |',
      '| escaped \\| pipe | `code` |',
      '| final | row |',
      '',
      '```ts',
      'const fence = `still open`',
      '```',
      '',
      '<div>',
      'raw html',
      '</div>',
      '',
      '[forward reference][later]',
      '[^footnote-like-reference]',
      '',
      '[later]: https://example.com "title"'
    ].join('\n')
    const incremental = new IncrementalMarkdownProcessor()
    const boundaries = irregularBoundaries(fixture.length)

    for (const boundary of boundaries) {
      const content = fixture.slice(0, boundary)
      incremental.render(content)
      const fresh = new IncrementalMarkdownProcessor()
      fresh.render(content)
      expect(withoutPositions(incremental.snapshotMdast())).toEqual(
        withoutPositions(fresh.snapshotMdast())
      )
    }
  })

  it('reuses closed rows in an append-only 50k GFM table', () => {
    const header = '| index | value |\n| ---: | --- |\n'
    const rows = Array.from(
      { length: 1_500 },
      (_, index) => `| ${index} | row-${index.toString().padStart(4, '0')}-${'x'.repeat(16)} |\n`
    )
    const processor = new IncrementalMarkdownProcessor()
    const initial = header + rows.slice(0, -1).join('')
    processor.render(initial)
    const final = initial + rows[rows.length - 1]
    const result = processor.render(final)

    expect(final.length).toBeGreaterThan(50_000)
    expect(result.metrics.parsedChars).toBeLessThan(500)
    expect(result.metrics.reusedChars).toBeGreaterThan(49_000)
    const fresh = new IncrementalMarkdownProcessor()
    fresh.render(final)
    expect(withoutPositions(processor.snapshotMdast())).toEqual(withoutPositions(fresh.snapshotMdast()))
  })

  it('re-resolves cached table references when a trailing definition arrives', () => {
    const targetLength = 10_000
    const header = '| index | link |\n| ---: | --- |\n'
    let body = header
    while (body.length < targetLength) body += `| ${body.length} | [docs][reference] |\n`
    const final = `${body.slice(0, targetLength - 42)}\n\n[reference]: https://example.com "Docs"\n`
    const incremental = new IncrementalMarkdownProcessor()
    let lastOperations: ReturnType<IncrementalMarkdownProcessor['render']>['operations'] = []
    for (const chunk of Array.from({ length: 60 }, (_, index) =>
      final.slice(0, Math.ceil((final.length * (index + 1)) / 60))
    )) {
      lastOperations = incremental.render(chunk).operations
    }
    const fresh = new IncrementalMarkdownProcessor()
    fresh.render(final)
    expect(withoutPositions(incremental.snapshotMdast())).toEqual(withoutPositions(fresh.snapshotMdast()))
    expect(
      lastOperations.some(
        (operation) =>
          operation.type === 'insert' &&
          operation.node.type === 'element' &&
          operation.node.tagName === 'a'
      )
    ).toBe(true)
  })

  it('reparses earlier references when a definition arrives inside a container', () => {
    const prefix = '[x]\n\n> '
    const final = '[x]\n\n> [x]: /'
    const incremental = new IncrementalMarkdownProcessor()
    incremental.render(prefix)
    const result = incremental.render(final)
    const fresh = new IncrementalMarkdownProcessor()
    fresh.render(final)

    expect(result.metrics.parsedChars).toBe(final.length)
    expect(withoutPositions(incremental.snapshotMdast())).toEqual(
      withoutPositions(fresh.snapshotMdast())
    )
    expect(
      result.operations.some(
        (operation) =>
          operation.type === 'insert' &&
          operation.node.type === 'element' &&
          operation.node.tagName === 'a'
      )
    ).toBe(true)
  })

  it('matches fresh parsing for container definitions and randomized append boundaries', () => {
    const corpus = [
      '[link][target] and ![image][asset]\n\n> [target]: https://example.com/link\n> [asset]: https://example.com/image.png\n',
      '[link][target] and ![image][asset]\n\n- item\n  [target]: /list-link\n  [asset]: /list-image.png\n',
      '> [target]: /early-link\n> [asset]: /early-image.png\n\nclosed paragraph\n\n[link][target] and ![image][asset]\n',
      '[link][a\\]b] and ![image][asset]\n\n> [a\\]b]: /escaped\n> [asset]: /asset.png "Asset"\n'
    ]

    for (const [corpusIndex, document] of corpus.entries()) {
      for (let sample = 0; sample < 3; sample += 1) {
        const incremental = new IncrementalMarkdownProcessor()
        for (const boundary of randomAppendBoundaries(document.length, corpusIndex * 97 + sample)) {
          const content = document.slice(0, boundary)
          incremental.render(content)
          const fresh = new IncrementalMarkdownProcessor()
          fresh.render(content)
          expect(withoutPositions(incremental.snapshotMdast())).toEqual(
            withoutPositions(fresh.snapshotMdast())
          )
        }
      }
    }
  })
})

function irregularBoundaries(length: number): number[] {
  const boundaries = new Set<number>([0, 1, length])
  let cursor = 0
  const steps = [1, 2, 7, 3, 19, 5, 31, 11]
  let index = 0
  while (cursor < length) {
    cursor = Math.min(length, cursor + steps[index % steps.length])
    boundaries.add(cursor)
    index += 1
  }
  return [...boundaries].sort((left, right) => left - right)
}

function randomAppendBoundaries(length: number, seed: number): number[] {
  const boundaries = [0]
  let cursor = 0
  let state = (seed + 1) >>> 0
  while (cursor < length) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    cursor = Math.min(length, cursor + 1 + (state % 17))
    boundaries.push(cursor)
  }
  return boundaries
}

function withoutPositions(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, nested) => (key === 'position' ? undefined : nested)))
}
