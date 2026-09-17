import { describe, expect, it } from 'vitest'
import { IncrementalMarkdownProcessor } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/incremental-markdown'
import type {
  MarkdownDomNode,
  MarkdownDomOperation
} from '../../../packages/openagent-plugin-kit/src/renderer/markdown/markdown-worker-types'

describe('Mermaid fences in the incremental Markdown pipeline', () => {
  it('keeps a fence open until its closing line is complete', () => {
    const cases: [string, string, boolean | undefined][] = [
      ['closed at top level', '```mermaid\ngraph TD\n  A-->B\n```\n', true],
      ['still streaming', '```mermaid\ngraph TD\n', false],
      ['missing the final newline', '```mermaid\ngraph TD\n```', false],
      ['tilde fences', '~~~mermaid\ngraph TD\n~~~\n', true],
      ['a longer closing fence', '```mermaid\ngraph TD\n`````\n', true],
      ['a shorter closing fence', '````mermaid\ngraph TD\n```\n', false],
      ['an indented closing fence', '```mermaid\ngraph TD\n   ```\n', true],
      // The closing fence picks its own indentation; the opening line's is not
      // part of the container the closer has to stay inside.
      ['an indented opener with an unindented closer', '   ```mermaid\n   graph TD\n```\n', true],
      ['two-space indentation with an unindented closer', '  ```mermaid\n  graph TD\n```\n', true],
      ['an indented opener with a differently indented closer', '   ```mermaid\n   graph TD\n ```\n', true],
      ['inside a block quote', '> ```mermaid\n> graph TD\n> ```\n', true],
      ['closed without the space after the quote marker', '> ```mermaid\n> graph TD\n>```\n', true],
      ['opened without the space after the quote marker', '>```mermaid\n>graph TD\n>```\n', true],
      ['opened and closed with opposite padding', '>```mermaid\n> graph TD\n> ```\n', true],
      ['still outside a list item that a bare fence ended', '> - ```mermaid\n>   graph TD\n> ```\n', false],
      // A list item's indentation is what keeps the closer inside it, so it may
      // not be dropped the way a fence's own indentation may.
      ['a list item ended by a bare fence', '- ```mermaid\n  graph TD\n```\n', false],
      ['quoted and indented, closed at the container', '>   ```mermaid\n>   graph TD\n> ```\n', true],
      ['a quote that never closes', '> ```mermaid\n> graph TD\n', false],
      ['a quote ended by a bare fence', '> ```mermaid\n> graph TD\n```\n', false],
      ['a quote ended by a blank line', '> ```mermaid\n> graph TD\n\nafter\n', false],
      ['inside a list item', '- ```mermaid\n  graph TD\n  ```\n', true],
      ['inside an ordered list item', '1. ```mermaid\n   graph TD\n   ```\n', true],
      ['inside a list inside a quote', '> - ```mermaid\n>   graph TD\n>   ```\n', true],
      ['an unfinished list item', '- ```mermaid\n  graph TD\n', false],
      // A tab reaches past the item's two columns, so a closer indented with
      // one still sits inside the item the way its content does.
      ['a tab-indented closer inside a list item', '- ```mermaid\n\tgraph TD\n\t```\n', true],
      ['a tab-indented opener line inside a list item', '-\t```mermaid\n\tgraph TD\n\t```\n', true],
      ['a tab-indented closer deeper than the content line', '- ```mermaid\n  graph TD\n\t```\n', true],
      ['followed by a sibling block', '```mermaid\ngraph TD\n```\nafter\n', true],
      // The parser accepts `\n`, `\r\n` and a lone `\r` as line endings, so a
      // fence written with either of the other two is closed just the same.
      ['CR-only line endings', '```mermaid\rgraph TD\r```\r', true],
      ['CR-only line endings missing the final break', '```mermaid\rgraph TD\r```', false],
      ['CRLF line endings', '```mermaid\r\ngraph TD\r\n```\r\n', true],
      ['a CR-only closer inside a list item', '- ```mermaid\r  graph TD\r  ```\r', true]
    ]

    for (const [name, content, closed] of cases) {
      const operations = new IncrementalMarkdownProcessor().render(content).operations
      expect(mermaidNodes(operations)[0]?.closed, name).toBe(closed)
    }
  })

  it('only treats an exact mermaid info string as a chart', () => {
    const names = ['```mermaid-extra\ngraph TD\n```\n', '```typescript\nconst a = 1\n```\n', '```\nplain\n```\n']

    for (const content of names) {
      const operations = new IncrementalMarkdownProcessor().render(content).operations
      expect(mermaidNodes(operations)).toEqual([])
      expect(insertedTags(operations)).toContain('pre')
    }
  })

  it('leaves mermaid fences as code when charts are turned off', () => {
    const content = '```mermaid\ngraph TD\n  A-->B\n```\n'
    const operations = new IncrementalMarkdownProcessor().render(content, false, {
      mermaid: false
    }).operations

    expect(mermaidNodes(operations)).toEqual([])
    expect(insertedTags(operations)).toEqual(['pre', 'code'])
  })

  it('resets when chart handling is switched for the same content', () => {
    const content = '```mermaid\ngraph TD\n```\n'
    const processor = new IncrementalMarkdownProcessor()
    processor.render(content, false, { mermaid: false })
    const operations = processor.render(content, false, { mermaid: true }).operations

    expect(operations[0]).toEqual({ type: 'clear' })
    expect(mermaidNodes(operations)).toHaveLength(1)
  })

  it('updates a chart in place as its source streams', () => {
    const processor = new IncrementalMarkdownProcessor()
    processor.render('```mermaid\ngraph TD\n')
    const operations = processor.render('```mermaid\ngraph TD\n  A-->B\n```\n').operations

    expect(operations.filter((operation) => operation.type === 'insert')).toEqual([])
    expect(operations.filter((operation) => operation.type === 'update-mermaid')).toEqual([
      { type: 'update-mermaid', nodeId: 1, source: 'graph TD\n  A-->B\n', closed: true }
    ])
  })

  it('keeps the chart node identity when later blocks append after it', () => {
    const processor = new IncrementalMarkdownProcessor()
    const first = processor.render('```mermaid\ngraph TD\n```\n')
    const chartId = mermaidNodes(first.operations)[0]?.id
    const operations = processor.render('```mermaid\ngraph TD\n```\n\nafter\n').operations

    expect(mermaidNodes(operations)).toEqual([])
    expect(operations.some((operation) => operation.type === 'update-mermaid')).toBe(false)
    expect(chartId).toBe(1)
    expect(collapsedText(operations)).toBe('after')
  })
})

function mermaidNodes(operations: MarkdownDomOperation[]): MermaidDomNode[] {
  return operations.flatMap((operation) =>
    operation.type === 'insert' && operation.node.type === 'mermaid' ? [operation.node] : []
  )
}

type MermaidDomNode = Extract<MarkdownDomNode, { type: 'mermaid' }>

function insertedTags(operations: MarkdownDomOperation[]): string[] {
  return operations.flatMap((operation) =>
    operation.type === 'insert' && operation.node.type === 'element' ? [operation.node.tagName] : []
  )
}

function collapsedText(operations: MarkdownDomOperation[]): string {
  return operations
    .flatMap((operation) =>
      operation.type === 'insert' && operation.node.type === 'text' ? [operation.node.value] : []
    )
    .join('')
    .replace(/\s+/g, '')
}
