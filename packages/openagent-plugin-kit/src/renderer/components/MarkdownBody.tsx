import { Component, memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStreamingCadence } from '../hooks/useStreamingCadence.js'
import {
  useIncrementalMarkdownDom,
  type MarkdownMermaidHost
} from '../markdown/useIncrementalMarkdownDom.js'
import type { MarkdownRenderTelemetry } from '../markdown/useIncrementalMarkdownDom.js'
import MermaidBlock, { type MermaidStatus } from '../markdown/MermaidBlock.js'
import { useI18n } from '../i18n.js'
import { useRendererCapabilities } from '../capabilities.js'

/**
 * A chart that throws while rendering must not take the message down with it,
 * and the slot has to settle either way: the boundary reports the failure so the
 * host stops reading the message as busy, and keeps the source on screen. A
 * retry remounts the boundary, which is the only way back out of a failed render.
 */
class MermaidBoundary extends Component<
  { readonly fallback: ReactNode; readonly onFailure: () => void; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    this.props.onFailure()
    console.error('Mermaid chart failed to render', error)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

interface MarkdownBodyProps {
  content: string
  streaming: boolean
  /**
   * Set to false on surfaces where a chart cannot be read or must not change
   * layout — excerpts, for instance. `mermaid` fences then stay code blocks.
   */
  mermaid?: boolean
  onRenderTelemetry?: (telemetry: MarkdownRenderTelemetry) => void
}

function MarkdownBodyComponent({
  content,
  streaming,
  mermaid = true,
  onRenderTelemetry
}: MarkdownBodyProps): React.JSX.Element {
  const { openExternal } = useRendererCapabilities()
  const { t } = useI18n()
  const renderedContent = useStreamingCadence(content, streaming)
  const containerRef = useRef<HTMLDivElement>(null)
  const [revisionPending, setRevisionPending] = useState(true)
  const [drawn, setDrawn] = useState<ReadonlySet<number>>(() => new Set())
  // Remounting the boundary is what clears its failure, so the attempt has to
  // change the key of the chart that failed and of no other: remounting the
  // whole message would drop every drawn SVG and re-queue every chart.
  const [renderAttempt, setRenderAttempt] = useState<ReadonlyMap<number, number>>(() => new Map())
  const hostsRef = useRef<MarkdownMermaidHost[]>([])

  const handleMermaidStatus = useCallback((generation: number, status: MermaidStatus): void => {
    setDrawn((previous) => {
      const next = new Set<number>()
      // Only charts that are still mounted count; a chart that reported for a
      // slot the worker has since replaced simply stops contributing.
      for (const host of hostsRef.current) {
        if (host.generation === generation ? status !== 'drawing' : previous.has(host.generation)) {
          next.add(host.generation)
        }
      }
      return sameGenerations(previous, next) ? previous : next
    })
  }, [])

  const retryMermaidRender = useCallback(
    (generation: number): void => {
      setRenderAttempt((current) => new Map(current).set(generation, (current.get(generation) ?? 0) + 1))
      // Back to drawing: the slot is busy again until it settles either way.
      handleMermaidStatus(generation, 'drawing')
    },
    [handleMermaidStatus]
  )

  const hosts = useIncrementalMarkdownDom(containerRef, renderedContent, streaming, {
    mermaid,
    onTelemetry: onRenderTelemetry,
    onRevisionPending: setRevisionPending
  })
  hostsRef.current = hosts

  const chartPending = hosts.some((host) => host.renderable && !drawn.has(host.generation))
  const busy = revisionPending || chartPending

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const link = target.closest('a')
      const href = link?.getAttribute('href')
      if (!link || !container.contains(link)) return
      // Sanitized/empty links must not navigate to the host page. Otherwise a
      // standalone browser keeps native navigation unless its host overrides it.
      if (!href || openExternal) event.preventDefault()
      if (href && openExternal) void openExternal(href)
    }
    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [openExternal])

  return (
    <div className="markdown-body" ref={containerRef} aria-busy={busy ? 'true' : 'false'}>
      {hosts.map((host) =>
        createPortal(
          <MermaidBoundary
            key={renderAttempt.get(host.generation) ?? 0}
            fallback={
              <div className="markdown-mermaid-figure">
                <p className="markdown-mermaid-status" role="status">
                  {t('图表组件出错，已回退为源码。')}
                </p>
                <button
                  type="button"
                  className="markdown-mermaid-action"
                  onClick={() => retryMermaidRender(host.generation)}
                >
                  {t('重试')}
                </button>
                <pre className="markdown-mermaid-source">
                  <code>{host.source}</code>
                </pre>
              </div>
            }
            onFailure={() => handleMermaidStatus(host.generation, 'failed')}
          >
            <MermaidBlock
              source={host.source}
              renderable={host.renderable}
              generation={host.generation}
              onStatusChange={handleMermaidStatus}
            />
          </MermaidBoundary>,
          host.host,
          host.generation
        )
      )}
    </div>
  )
}

export default memo(MarkdownBodyComponent)

function sameGenerations(previous: ReadonlySet<number>, next: ReadonlySet<number>): boolean {
  if (previous.size !== next.size) return false
  for (const generation of next) if (!previous.has(generation)) return false
  return true
}
