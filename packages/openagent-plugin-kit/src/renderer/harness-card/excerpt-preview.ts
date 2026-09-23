import { unified } from 'unified'
import remarkParse from 'remark-parse'

const parser = unified().use(remarkParse)
interface PreviewNode {
  readonly type: string
  readonly position?: { readonly start: { readonly offset?: number }; readonly end: { readonly offset?: number } }
  readonly children?: readonly PreviewNode[]
}

/** Shorten complete prose links and same-line emphasis without interpreting the
 * displayed markup. Markdown positions protect code, including container fences. */
export function excerptPreview(source: string, precedingText = ''): string {
  // The preview is a bounded leaf, but a stream can carry megabytes of context.
  // Beyond this budget retain literal text: guessing a truncated Markdown state
  // could corrupt code, and parsing the full prefix on every append is unbounded.
  if (precedingText.length + source.length > 16_384) return source
  const input = precedingText + source
  const boundary = precedingText.length
  const code: Array<{ start: number; end: number }> = []
  const collect = (node: PreviewNode): void => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined) code.push({ start, end })
      return
    }
    for (const child of node.children ?? []) collect(child)
  }
  collect(parser.parse(input))
  let result = ''
  const emit = (start: number, end: number, replacement?: string): void => {
    if (end <= boundary) return
    // Do not transform a link or delimiter sliced by the visible window.
    result += start < boundary ? input.slice(boundary, end) : replacement ?? input.slice(start, end)
  }
  const prose = (start: number, end: number): void => {
    const text = input.slice(start, end)
    const tokens = /\\[^\r\n]|(?<!!)\[([^[\]\r\n]+)\]\((?:\\[^\r\n]|[^()\\\r\n]|\([^()\r\n]*\))*\)|(?<!\*)\*\*([^*`\r\n]+)\*\*(?!\*)/g
    let offset = 0
    for (const token of text.matchAll(tokens)) {
      emit(start + offset, start + token.index)
      emit(start + token.index, start + token.index + token[0].length, token[1] ?? token[2])
      offset = token.index + token[0].length
    }
    emit(start + offset, end)
  }
  let offset = 0
  for (const span of code) {
    prose(offset, span.start)
    emit(span.start, span.end)
    offset = span.end
  }
  prose(offset, input.length)
  return result
}
