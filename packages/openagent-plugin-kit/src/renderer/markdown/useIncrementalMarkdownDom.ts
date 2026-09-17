import { find, html } from 'property-information'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { postMarkdownWorker, subscribeMarkdownWorker } from './markdown-worker-client.js'
import type {
  MarkdownDomNode,
  MarkdownDomOperation,
  MarkdownRenderResponse,
  MarkdownWorkerMetrics
} from './markdown-worker-types.js'

const MAIN_THREAD_BUDGET_MS = 4
const MERMAID_HOST_CLASS = 'markdown-mermaid'
let nextClientId = 1

interface PendingRevision {
  response: MarkdownRenderResponse
  operationIndex: number
  batchDurations: number[]
}

interface MermaidRecord {
  id: number
  generation: number
  host: HTMLElement
  source: string
  closed: boolean
}

/**
 * A chart placeholder the worker owns positionally, paired with the React
 * subtree rendered into it.
 */
export interface MarkdownMermaidHost {
  readonly id: number
  /** Identity of this chart slot; changes whenever the host element is replaced. */
  readonly generation: number
  readonly host: HTMLElement
  readonly source: string
  /** False while the fence is still streaming and has no closing marker yet. */
  readonly renderable: boolean
}

export interface IncrementalMarkdownOptions {
  /** Whether `mermaid` fences become chart hosts instead of code blocks. */
  mermaid?: boolean
  onTelemetry?: (telemetry: MarkdownRenderTelemetry) => void
  /**
   * Reports whether a worker revision is still being committed, so the caller
   * can fold the DOM pipeline into its own readiness signal.
   */
  onRevisionPending?: (pending: boolean) => void
}

export interface MarkdownRenderTelemetry extends MarkdownWorkerMetrics {
  revision: number
  streaming: boolean
  mainThreadBatches: number[]
  mainThreadDuration: number
}

export function useIncrementalMarkdownDom(
  containerRef: RefObject<HTMLDivElement | null>,
  content: string,
  streaming: boolean,
  options: IncrementalMarkdownOptions = {}
): MarkdownMermaidHost[] {
  const clientIdRef = useRef(`markdown-${nextClientId++}`)
  const revisionRef = useRef(0)
  const minimumRevisionRef = useRef(0)
  const lastContentRef = useRef<string | undefined>(undefined)
  const wasStreamingRef = useRef(streaming)
  const nodesRef = useRef(new Map<number, Node>())
  const nodeIdsRef = useRef(new WeakMap<Node, number>())
  const mermaidRef = useRef(new Map<number, MermaidRecord>())
  const generationRef = useRef(0)
  const pendingRef = useRef<PendingRevision[]>([])
  const frameRef = useRef<number | undefined>(undefined)
  const optionsRef = useRef(options)
  const streamingByRevisionRef = useRef(new Map<number, boolean>())
  const [hosts, setHosts] = useState<MarkdownMermaidHost[]>([])
  optionsRef.current = options
  const mermaidEnabled = options.mermaid !== false
  const previousMermaidRef = useRef(mermaidEnabled)

  const publish = (revisionStreaming: boolean): void => {
    const next: MarkdownMermaidHost[] = []
    for (const record of mermaidRef.current.values()) {
      next.push({
        id: record.id,
        generation: record.generation,
        host: record.host,
        source: record.source,
        // A half-typed fence keeps its code block until the closing marker
        // arrives, so the chart never reflows on every streamed keystroke.
        renderable: record.closed || !revisionStreaming
      })
    }
    setHosts((previous) => (hostsEqual(previous, next) ? previous : next))
  }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    nodesRef.current.set(0, container)
    nodeIdsRef.current.set(container, 0)

    const schedule = (): void => {
      if (frameRef.current !== undefined) return
      frameRef.current = scheduleFrame(flush)
    }

    const settle = (revision: number): void => {
      if (revision !== revisionRef.current) return
      optionsRef.current.onRevisionPending?.(false)
    }

    const flush = (): void => {
      frameRef.current = undefined
      const pending = pendingRef.current[0]
      if (!pending) return
      const started = performance.now()
      let applied = 0
      while (pending.operationIndex < pending.response.operations.length) {
        const operation = pending.response.operations[pending.operationIndex]
        applyOperation(operation, nodesRef.current, nodeIdsRef.current, mermaidRef.current, () =>
          ++generationRef.current
        )
        pending.operationIndex += 1
        applied += 1
        if (applied > 0 && performance.now() - started >= MAIN_THREAD_BUDGET_MS) break
      }
      pending.batchDurations.push(performance.now() - started)
      if (pending.operationIndex >= pending.response.operations.length) {
        const revisionStreaming =
          streamingByRevisionRef.current.get(pending.response.revision) ?? false
        finishRevision(pending, streamingByRevisionRef.current, optionsRef.current.onTelemetry)
        pendingRef.current.shift()
        settle(pending.response.revision)
        publish(revisionStreaming)
      }
      if (pendingRef.current.length > 0) schedule()
    }

    return subscribeMarkdownWorker(clientIdRef.current, (response) => {
      if (response.type === 'error') {
        if (response.revision === revisionRef.current) optionsRef.current.onRevisionPending?.(false)
        console.error('Incremental Markdown worker failed:', response.message)
        return
      }
      if (response.revision < minimumRevisionRef.current) return
      pendingRef.current.push({ response, operationIndex: 0, batchDurations: [] })
      schedule()
    })
  }, [containerRef])

  useEffect(() => {
    const previousContent = lastContentRef.current
    const statusChanged = streaming !== wasStreamingRef.current
    const restarted = streaming && !wasStreamingRef.current
    const chartsToggled = mermaidEnabled !== previousMermaidRef.current
    wasStreamingRef.current = streaming
    previousMermaidRef.current = mermaidEnabled
    if (content === previousContent && !restarted && !chartsToggled) {
      if (!statusChanged) return
    }
    // Turning charts on or off re-decides every fence in the message, so the
    // worker is given the same content with nothing to diff against.
    const reset =
      chartsToggled || previousContent === undefined || !content.startsWith(previousContent)
    options.onRevisionPending?.(true)
    const revision = ++revisionRef.current
    lastContentRef.current = content
    streamingByRevisionRef.current.set(revision, streaming)
    if (reset) {
      minimumRevisionRef.current = revision
      pendingRef.current = []
      const container = containerRef.current
      if (container) container.replaceChildren()
      nodesRef.current.clear()
      nodeIdsRef.current = new WeakMap()
      mermaidRef.current.clear()
      setHosts([])
      if (container) {
        nodesRef.current.set(0, container)
        nodeIdsRef.current.set(container, 0)
      }
    }
    postMarkdownWorker({
      type: 'render',
      clientId: clientIdRef.current,
      revision,
      content,
      reset,
      mermaid: mermaidEnabled
    })
  }, [containerRef, content, streaming, mermaidEnabled])

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelFrame(frameRef.current)
      pendingRef.current = []
      lastContentRef.current = undefined
      mermaidRef.current.clear()
      postMarkdownWorker({ type: 'cancel', clientId: clientIdRef.current })
    },
    []
  )

  return hosts
}

function hostsEqual(previous: MarkdownMermaidHost[], next: MarkdownMermaidHost[]): boolean {
  if (previous.length !== next.length) return false
  for (let index = 0; index < next.length; index += 1) {
    const left = previous[index]
    const right = next[index]
    if (
      left.id !== right.id ||
      left.generation !== right.generation ||
      left.host !== right.host ||
      left.source !== right.source ||
      left.renderable !== right.renderable
    ) {
      return false
    }
  }
  return true
}

function finishRevision(
  pending: PendingRevision,
  streamingByRevision: Map<number, boolean>,
  onTelemetry: ((telemetry: MarkdownRenderTelemetry) => void) | undefined
): void {
  const mainThreadDuration = pending.batchDurations.reduce((sum, duration) => sum + duration, 0)
  onTelemetry?.({
    ...pending.response.metrics,
    revision: pending.response.revision,
    streaming: streamingByRevision.get(pending.response.revision) ?? false,
    mainThreadBatches: pending.batchDurations,
    mainThreadDuration
  })
  streamingByRevision.delete(pending.response.revision)
}

function scheduleFrame(callback: () => void): number {
  return typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(callback)
    : window.setTimeout(callback, 0)
}

function cancelFrame(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle)
  else clearTimeout(handle)
}

function applyOperation(
  operation: MarkdownDomOperation,
  nodes: Map<number, Node>,
  nodeIds: WeakMap<Node, number>,
  mermaid: Map<number, MermaidRecord>,
  nextGeneration: () => number
): void {
  if (operation.type === 'clear') {
    const root = nodes.get(0)
    if (root instanceof Element) root.replaceChildren()
    nodes.clear()
    mermaid.clear()
    if (root) {
      nodes.set(0, root)
      nodeIds.set(root, 0)
    }
    return
  }
  if (operation.type === 'remove') {
    const parent = nodes.get(operation.parentId)
    const child = parent?.childNodes[operation.index]
    if (child) {
      forgetSubtree(child, nodes, nodeIds, mermaid)
      parent?.removeChild(child)
    }
    return
  }
  if (operation.type === 'insert') {
    const parent = nodes.get(operation.parentId)
    if (!parent) return
    const node = createNode(operation.node, mermaid, nextGeneration)
    parent.insertBefore(node, parent.childNodes[operation.index] ?? null)
    nodes.set(operation.node.id, node)
    nodeIds.set(node, operation.node.id)
    return
  }
  if (operation.type === 'update-mermaid') {
    const record = mermaid.get(operation.nodeId)
    if (record) {
      record.source = operation.source
      record.closed = operation.closed
    }
    return
  }
  const node = nodes.get(operation.nodeId)
  if (operation.type === 'set-text') {
    if (node) node.nodeValue = operation.value
  } else if (node instanceof HTMLElement) {
    applyProperties(node, operation.properties)
  }
}

function createNode(
  node: MarkdownDomNode,
  mermaid: Map<number, MermaidRecord>,
  nextGeneration: () => number
): Node {
  if (node.type === 'text') return document.createTextNode(node.value)
  if (node.type === 'mermaid') {
    const host = document.createElement('div')
    host.className = MERMAID_HOST_CLASS
    // The worker owns this element's position; React owns only its contents.
    host.setAttribute('data-mermaid-id', String(node.id))
    mermaid.set(node.id, {
      id: node.id,
      generation: nextGeneration(),
      host,
      source: node.source,
      closed: node.closed
    })
    return host
  }
  const element = document.createElement(node.tagName)
  applyProperties(element, node.properties)
  return element
}

function applyProperties(element: HTMLElement, properties: Record<string, unknown>): void {
  for (const name of element.getAttributeNames()) element.removeAttribute(name)
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined || value === null || value === false) continue
    const info = find(html, key)
    const attribute = info.attribute
    if (info.boolean || (info.overloadedBoolean && value === true)) {
      element.setAttribute(attribute, '')
      if (info.mustUseProperty) Reflect.set(element, info.property, true)
      continue
    }
    const serialized = Array.isArray(value)
      ? value.join(info.commaSeparated || info.commaOrSpaceSeparated ? ', ' : ' ')
      : String(value)
    element.setAttribute(attribute, serialized)
    if (info.mustUseProperty) Reflect.set(element, info.property, value)
  }
}

function forgetSubtree(
  root: Node,
  nodes: Map<number, Node>,
  nodeIds: WeakMap<Node, number>,
  mermaid: Map<number, MermaidRecord>
): void {
  for (const child of root.childNodes) forgetSubtree(child, nodes, nodeIds, mermaid)
  const id = nodeIds.get(root)
  if (id !== undefined) {
    nodes.delete(id)
    mermaid.delete(id)
  }
  nodeIds.delete(root)
}
