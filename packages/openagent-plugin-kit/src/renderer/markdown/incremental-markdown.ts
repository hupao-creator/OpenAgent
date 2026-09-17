import type { Nodes as HastNode, Properties, Root as HastRoot } from 'hast'
import { urlAttributes } from 'html-url-attributes'
import type { Root as MdastRoot, RootContent as MdastRootContent } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { unified } from 'unified'
import type {
  MarkdownDomNode,
  MarkdownDomOperation,
  MarkdownWorkerMetrics
} from './markdown-worker-types.js'

interface PositionedNode {
  position?: {
    start: { line: number; column: number; offset?: number }
    end: { line: number; column: number; offset?: number }
  }
}

interface CachedMarkdown {
  content: string
  mdast: MdastRoot
  dom: DomRoot
  nextNodeId: number
  mermaid: boolean
}

type DomTree = DomElement | DomText | DomMermaid

interface DomRoot {
  id: 0
  type: 'root'
  children: DomTree[]
}

interface DomElement {
  id: number
  type: 'element'
  tagName: string
  properties: Properties
  children: DomTree[]
}

interface DomText {
  id: number
  type: 'text'
  value: string
}

interface DomMermaid {
  id: number
  type: 'mermaid'
  source: string
  closed: boolean
}

export interface IncrementalRenderOptions {
  /** Whether `mermaid` fences convert to chart nodes instead of code blocks. */
  mermaid?: boolean
}

interface DomBuildContext {
  content: string
  mermaid: boolean
}

interface ParseResult {
  tree: MdastRoot
  parsedChars: number
}

interface IncrementalMarkdownResult {
  operations: MarkdownDomOperation[]
  metrics: MarkdownWorkerMetrics
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i
const TABLE_ELEMENTS = new Set(['table', 'tbody', 'thead', 'tfoot', 'tr'])

export class IncrementalMarkdownProcessor {
  private cache: CachedMarkdown | undefined

  render(
    content: string,
    forceReset = false,
    options: IncrementalRenderOptions = {}
  ): IncrementalMarkdownResult {
    const mermaid = options.mermaid !== false
    const reset =
      forceReset ||
      !this.cache ||
      this.cache.mermaid !== mermaid ||
      !content.startsWith(this.cache.content)
    const parseStarted = performance.now()
    const parsed = reset ? this.parseAll(content) : this.parseAppend(content, this.cache as CachedMarkdown)
    const parseDuration = performance.now() - parseStarted

    const transformStarted = performance.now()
    const hast = processor.runSync(parsed.tree) as HastRoot
    normalizeHast(hast)
    const nextDom = hastToDom(hast, { content, mermaid })
    const transformDuration = performance.now() - transformStarted

    const diffStarted = performance.now()
    const operations: MarkdownDomOperation[] = []
    let nextNodeId = reset ? 1 : (this.cache as CachedMarkdown).nextNodeId
    let dom: DomRoot

    if (reset) {
      operations.push({ type: 'clear' })
      dom = { id: 0, type: 'root', children: [] }
      reconcileChildren(dom, nextDom.children, operations, () => nextNodeId++)
    } else {
      dom = (this.cache as CachedMarkdown).dom
      reconcileChildren(dom, nextDom.children, operations, () => nextNodeId++)
    }

    const diffDuration = performance.now() - diffStarted
    this.cache = { content, mdast: parsed.tree, dom, nextNodeId, mermaid }

    return {
      operations,
      metrics: {
        parseDuration,
        transformDuration,
        diffDuration,
        parsedChars: parsed.parsedChars,
        reusedChars: Math.max(0, content.length - parsed.parsedChars),
        operationCount: operations.length
      }
    }
  }

  snapshotMdast(): MdastRoot | undefined {
    return this.cache?.mdast
  }

  private parseAll(content: string): ParseResult {
    return { tree: processor.parse(content) as MdastRoot, parsedChars: content.length }
  }

  private parseAppend(content: string, cache: CachedMarkdown): ParseResult {
    if (content === cache.content) return { tree: cache.mdast, parsedChars: 0 }
    // CommonMark only creates reference nodes for definitions known by EOF.
    // A newly appended link/footnote definition can therefore change any
    // earlier block. This is a real global invalidation, not an open-tail
    // change, so rebuild the MDAST in the worker for correctness.
    const definitionProbeStart = cache.content.lastIndexOf('\n') + 1
    if (/^ {0,3}\[[^\]]+\]:/m.test(content.slice(definitionProbeStart))) {
      return this.parseAll(content)
    }
    const last = cache.mdast.children[cache.mdast.children.length - 1]
    const offset = last?.position?.start.offset
    if (offset === undefined) return this.parseAll(content)

    if (last.type === 'table' && last.children.length > 1) {
      const tableResult = this.parseTableAppend(content, cache, last)
      if (tableResult) return invalidateForDefinitionChanges(content, cache, tableResult)
    }

    const definitionContext = rootDefinitionContext(cache.mdast, cache.content, offset)
    const prefix = definitionContext ? `${definitionContext}\n\n` : ''
    const tail = processor.parse(prefix + content.slice(offset)) as MdastRoot
    if (prefix) {
      tail.children = tail.children.filter((node) => (node.position?.start.offset ?? 0) >= prefix.length)
    }
    shiftPositions(tail, offset - prefix.length)
    return invalidateForDefinitionChanges(content, cache, {
      tree: rootWithChildren(content, [
        ...cache.mdast.children.slice(0, -1),
        ...tail.children
      ]),
      parsedChars: content.length - offset + prefix.length
    })
  }

  private parseTableAppend(
    content: string,
    cache: CachedMarkdown,
    table: Extract<MdastRootContent, { type: 'table' }>
  ): ParseResult | undefined {
    const tableStart = table.position?.start.offset
    const lastRowStart = table.children[table.children.length - 1]?.position?.start.offset
    if (tableStart === undefined || lastRowStart === undefined) return undefined

    const headerLineEnd = content.indexOf('\n', tableStart)
    if (headerLineEnd === -1) return undefined
    const delimiterLineEnd = content.indexOf('\n', headerLineEnd + 1)
    const headerEnd = delimiterLineEnd === -1 ? content.length : delimiterLineEnd + 1
    if (headerEnd > lastRowStart) return undefined

    const tableContext = content.slice(tableStart, headerEnd)
    const definitions = rootDefinitionContext(cache.mdast, cache.content, tableStart)
    const prefix = definitions ? `${definitions}\n\n` : ''
    const synthetic = prefix + tableContext + content.slice(lastRowStart)
    const parsedTail = processor.parse(synthetic) as MdastRoot
    const tableIndex = parsedTail.children.findIndex((node) => node.type === 'table')
    const parsedTable = parsedTail.children[tableIndex]
    if (parsedTable?.type !== 'table' || parsedTable.children.length < 2) return undefined

    const delta = lastRowStart - prefix.length - tableContext.length
    const replacementRows = parsedTable.children.slice(1)
    for (const row of replacementRows) shiftPositions(row, delta)
    const trailing = parsedTail.children.slice(tableIndex + 1)
    for (const node of trailing) shiftPositions(node, delta)

    const mergedTable: typeof table = {
      ...parsedTable,
      children: [...table.children.slice(0, -1), ...replacementRows],
      position: {
        start: table.position!.start,
        end: shiftPoint(parsedTable.position?.end, delta) ?? table.position!.end
      }
    }
    return {
      tree: rootWithChildren(content, [
        ...cache.mdast.children.slice(0, -1),
        mergedTable,
        ...trailing
      ]),
      parsedChars: synthetic.length
    }
  }
}

function rootDefinitionContext(root: MdastRoot, source: string, beforeOffset: number): string {
  const definitions: string[] = []
  const collect = (node: MdastRoot | MdastRootContent): void => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start !== undefined && end !== undefined && end <= beforeOffset) {
        definitions.push(source.slice(start, end))
      }
      return
    }
    if ('children' in node) for (const child of node.children) collect(child as MdastRootContent)
  }
  collect(root)
  return definitions.join('\n')
}

function invalidateForDefinitionChanges(
  content: string,
  cache: CachedMarkdown,
  parsed: ParseResult
): ParseResult {
  return JSON.stringify(definitionSignatures(cache.mdast)) !==
    JSON.stringify(definitionSignatures(parsed.tree))
    ? { tree: processor.parse(content) as MdastRoot, parsedChars: content.length }
    : parsed
}

function definitionSignatures(root: MdastRoot): string[] {
  const signatures: string[] = []
  const collect = (node: MdastRoot | MdastRootContent): void => {
    if (node.type === 'definition' || node.type === 'footnoteDefinition') {
      signatures.push(
        JSON.stringify(node, (key, value) => (key === 'position' ? undefined : value))
      )
      return
    }
    if ('children' in node) for (const child of node.children) collect(child as MdastRootContent)
  }
  collect(root)
  return signatures
}

function rootWithChildren(content: string, children: MdastRootContent[]): MdastRoot {
  const last = children[children.length - 1]
  return {
    type: 'root',
    children,
    position:
      content.length === 0
        ? undefined
        : {
            start: { line: 1, column: 1, offset: 0 },
            end: last?.position?.end ?? { line: 1, column: content.length + 1, offset: content.length }
          }
  }
}

function shiftPoint<T extends { line: number; column: number; offset?: number }>(
  point: T | undefined,
  delta: number
): T | undefined {
  if (!point || point.offset === undefined) return point
  return { ...point, offset: point.offset + delta }
}

function shiftPositions(node: unknown, delta: number): void {
  if (!node || typeof node !== 'object') return
  const positioned = node as PositionedNode & { children?: unknown[] }
  if (positioned.position) {
    positioned.position = {
      start: shiftPoint(positioned.position.start, delta) as typeof positioned.position.start,
      end: shiftPoint(positioned.position.end, delta) as typeof positioned.position.end
    }
  }
  for (const child of positioned.children ?? []) shiftPositions(child, delta)
}

function normalizeHast(node: HastNode): void {
  if (node.type === 'raw') {
    ;(node as HastNode & { type: string }).type = 'text'
    return
  }
  if (node.type === 'element') {
    if ((node.tagName === 'td' || node.tagName === 'th') && typeof node.properties.align === 'string') {
      node.properties.style = `text-align: ${node.properties.align};`
      delete node.properties.align
    }
    for (const [key, tags] of Object.entries(urlAttributes)) {
      if (Object.hasOwn(node.properties, key) && (tags === null || tags.includes(node.tagName))) {
        node.properties[key] = safeUrl(String(node.properties[key] || ''))
      }
    }
  }
  if ('children' in node) {
    for (const child of node.children) normalizeHast(child)
    if (node.type === 'element' && TABLE_ELEMENTS.has(node.tagName)) {
      node.children = node.children.filter(
        (child) => child.type !== 'text' || !/^\s*$/.test(child.value)
      )
    }
  }
}

function safeUrl(value: string): string {
  const colon = value.indexOf(':')
  const questionMark = value.indexOf('?')
  const numberSign = value.indexOf('#')
  const slash = value.indexOf('/')
  return colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    SAFE_PROTOCOL.test(value.slice(0, colon))
    ? value
    : ''
}

function hastToDom(root: HastRoot, context: DomBuildContext): DomRoot {
  return {
    id: 0,
    type: 'root',
    children: root.children.map((node) => hastNodeToDom(node, context))
  }
}

function hastNodeToDom(node: HastNode, context: DomBuildContext): DomTree {
  if (node.type === 'element') {
    const mermaid = context.mermaid ? mermaidFence(node, context.content) : undefined
    if (mermaid) {
      return { id: -1, type: 'mermaid', source: mermaid.source, closed: mermaid.closed }
    }
    return {
      id: -1,
      type: 'element',
      tagName: node.tagName,
      properties: node.properties,
      children: node.children.map((child) => hastNodeToDom(child, context))
    }
  }
  return { id: -1, type: 'text', value: 'value' in node ? String(node.value) : '' }
}

/**
 * Recognizes a fenced code block whose language is exactly `mermaid`, which
 * remark-rehype emits as `pre > code.language-mermaid`.
 */
function mermaidFence(
  node: HastNode & { type: 'element' },
  content: string
): { source: string; closed: boolean } | undefined {
  if (node.tagName !== 'pre') return undefined
  const significant = node.children.filter(
    (child) => child.type !== 'text' || child.value.trim() !== ''
  )
  if (significant.length !== 1) return undefined
  const code = significant[0]
  if (code.type !== 'element' || code.tagName !== 'code') return undefined
  if (!hasMermaidClass(code.properties.className)) return undefined
  const source = code.children
    .map((child) => (child.type === 'text' ? child.value : ''))
    .join('')
  const start = code.position?.start.offset
  const end = code.position?.end.offset
  return {
    source,
    closed: start !== undefined && end !== undefined && fenceClosed(content, start, end)
  }
}

function hasMermaidClass(className: Properties[string]): boolean {
  const names = Array.isArray(className)
    ? className
    : typeof className === 'string'
      ? className.split(/\s+/)
      : []
  return names.some(
    (name) => typeof name === 'string' && name.toLowerCase() === 'language-mermaid'
  )
}

/**
 * Decides whether the fence spanning `[start, end)` in `content` has a closing
 * fence line and is followed by a newline, so a half-typed block is never
 * mistaken for a finished one.
 *
 * The last line of the fence's range is not always a closing fence: while the
 * message streams it is chart source, and a quote that swallows the rest of the
 * document ends its range wherever the quote ends. Both are rejected by
 * requiring the trailing line to carry the opening line's container prefix and
 * to hold nothing but the closing marker.
 */
function fenceClosed(content: string, start: number, end: number): boolean {
  const lineStart = lastLineBreak(content, start - 1) + 1
  const continuations = continuationPrefixes(content.slice(lineStart, start))
  const region = content.slice(start, end)
  const openingBreak = region.search(LINE_BREAK)
  if (openingBreak === -1) return false
  const marker = /^(`{3,}|~{3,})/.exec(region.slice(0, openingBreak))
  if (!marker) return false
  const closingBreak = lastLineBreak(region, region.length - 1)
  if (closingBreak === -1) return false
  const closingLine = expandTabs(region.slice(closingBreak + 1))
  const remainder = continuations
    .map((prefix) => consumeContinuation(closingLine, prefix))
    .find((candidate) => candidate !== undefined)
  if (remainder === undefined) return false
  // CommonMark lets the closing fence be indented up to three spaces.
  const indent = /^[ \t]{0,3}/.exec(remainder)?.[0] ?? ''
  if (remainder[indent.length] === ' ' || remainder[indent.length] === '\t') return false
  const body = remainder.slice(indent.length)
  const fenceChar = marker[1][0]
  let cursor = 0
  while (body[cursor] === fenceChar) cursor += 1
  if (cursor < marker[1].length) return false
  if (body.slice(cursor).trim() !== '') return false
  return LINE_BREAK.test(content[end] ?? '')
}

/**
 * The line endings CommonMark accepts are `\n`, `\r\n`, and a lone `\r`. The
 * parser reads all three, so a fence written with CR line endings is a chart
 * there and has to be one here too.
 */
const LINE_BREAK = /[\r\n]/

/** The offset of the last line break at or before `from`, or `-1`. */
function lastLineBreak(text: string, from: number): number {
  return Math.max(text.lastIndexOf('\n', from), text.lastIndexOf('\r', from))
}

/**
 * CommonMark advances a tab to the next four-column stop, and the columns it
 * covers count towards the container the line sits in. Widening them here lets
 * the prefixes be compared byte for byte as before: `- ```mermaid` opens a fence
 * whose item is indented two columns, and a tab-indented closer still reaches
 * past both of them.
 */
const TAB_STOP = 4

function expandTabs(line: string): string {
  let expanded = ''
  let column = 0
  for (const character of line) {
    if (character === '\t') {
      const width = TAB_STOP - (column % TAB_STOP)
      expanded += ' '.repeat(width)
      column += width
    } else {
      expanded += character
      column += 1
    }
  }
  return expanded
}

/**
 * The prefixes a continuation line may carry inside the container that opened
 * on this line. A list marker occupies the opening line only; every later line
 * stands on plain indentation of the same width, while quote markers repeat.
 *
 * The fence's own indentation — up to three spaces beyond the container — is
 * not part of that: CommonMark reads the closing fence's indentation on its own
 * terms, so an unindented closer ends an indented block. Only a container-free
 * opening therefore offers the shorter prefixes; with a list marker present the
 * indentation is all that keeps the closer inside the item, and dropping it
 * would let a closer that ended the list read as one that closed the fence.
 */
function continuationPrefixes(opener: string): string[] {
  const container = expandTabs(opener).replace(/[^\s>]/g, ' ')
  if (/[^\s>]/.test(opener)) return [container]
  const trailing = /[ ]*$/.exec(container)?.[0].length ?? 0
  const kept = container.slice(0, container.length - trailing)
  const prefixes: string[] = []
  for (let indent = 0; indent <= Math.min(3, trailing); indent += 1) {
    prefixes.push(kept + ' '.repeat(trailing - indent))
  }
  return prefixes
}

/**
 * Consumes the opening line's container prefix from a candidate continuation
 * line, returning what follows it. CommonMark makes the space after each `>`
 * optional, so `> ` and `>` open the same container and a closer may use
 * either; the rest of the prefix is indentation and has to match exactly.
 */
function consumeContinuation(line: string, prefix: string): string | undefined {
  let cursor = 0
  for (let index = 0; index < prefix.length; index += 1) {
    const expected = prefix[index]
    if (line[cursor] === expected) {
      cursor += 1
      continue
    }
    if (expected !== '>' && prefix[index - 1] === '>') continue
    return undefined
  }
  return line.slice(cursor)
}

function reconcileChildren(
  parent: DomRoot | DomElement,
  nextChildren: DomTree[],
  operations: MarkdownDomOperation[],
  allocateId: () => number
): void {
  const common = Math.min(parent.children.length, nextChildren.length)
  for (let index = 0; index < common; index += 1) {
    const previous = parent.children[index]
    const next = nextChildren[index]
    if (!compatible(previous, next)) {
      operations.push({ type: 'remove', parentId: parent.id, index })
      const inserted = assignAndInsert(next, parent.id, index, operations, allocateId)
      parent.children[index] = inserted
      continue
    }
    reconcileNode(previous, next, operations, allocateId)
  }

  for (let index = parent.children.length - 1; index >= nextChildren.length; index -= 1) {
    operations.push({ type: 'remove', parentId: parent.id, index })
    parent.children.splice(index, 1)
  }
  for (let index = parent.children.length; index < nextChildren.length; index += 1) {
    parent.children.push(assignAndInsert(nextChildren[index], parent.id, index, operations, allocateId))
  }
}

function reconcileNode(
  previous: DomTree,
  next: DomTree,
  operations: MarkdownDomOperation[],
  allocateId: () => number
): void {
  if (previous.type === 'text' && next.type === 'text') {
    if (previous.value !== next.value) {
      previous.value = next.value
      operations.push({ type: 'set-text', nodeId: previous.id, value: next.value })
    }
    return
  }
  if (previous.type === 'mermaid' && next.type === 'mermaid') {
    if (previous.source !== next.source || previous.closed !== next.closed) {
      previous.source = next.source
      previous.closed = next.closed
      operations.push({
        type: 'update-mermaid',
        nodeId: previous.id,
        source: next.source,
        closed: next.closed
      })
    }
    return
  }
  if (previous.type !== 'element' || next.type !== 'element') return
  if (!propertiesEqual(previous.properties, next.properties)) {
    previous.properties = next.properties
    operations.push({ type: 'set-properties', nodeId: previous.id, properties: next.properties })
  }
  reconcileChildren(previous, next.children, operations, allocateId)
}

function compatible(previous: DomTree, next: DomTree): boolean {
  return (
    previous.type === next.type &&
    (previous.type !== 'element' || next.type !== 'element' || previous.tagName === next.tagName)
  )
}

function assignAndInsert(
  source: DomTree,
  parentId: number,
  index: number,
  operations: MarkdownDomOperation[],
  allocateId: () => number
): DomTree {
  const id = allocateId()
  if (source.type !== 'element') {
    const node = { ...source, id }
    operations.push({ type: 'insert', parentId, index, node: publicNode(node) })
    return node
  }
  const node: DomElement = { ...source, id, children: [] }
  operations.push({ type: 'insert', parentId, index, node: publicNode(node) })
  for (let childIndex = 0; childIndex < source.children.length; childIndex += 1) {
    node.children.push(
      assignAndInsert(source.children[childIndex], id, childIndex, operations, allocateId)
    )
  }
  return node
}

function publicNode(node: DomTree): MarkdownDomNode {
  return node.type === 'element'
    ? { id: node.id, type: 'element', tagName: node.tagName, properties: node.properties }
    : { ...node }
}

function propertiesEqual(left: Properties, right: Properties): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
