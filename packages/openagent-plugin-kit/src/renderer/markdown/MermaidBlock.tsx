import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n.js'
import {
  cancelMermaidRender,
  MermaidRenderError,
  renderMermaidChart,
  type MermaidFailureReason,
  type MermaidTheme
} from './mermaid-runtime.js'

export type MermaidStatus = 'drawing' | 'ready' | 'failed'

interface MermaidBlockProps {
  source: string
  /** False while the fence is still open in a streaming message. */
  renderable: boolean
  generation: number
  onStatusChange: (generation: number, status: MermaidStatus) => void
}

type Fit = 'fit' | 'actual'

const FAILURE_MESSAGES: Record<MermaidFailureReason, string> = {
  empty: '图表源码为空。',
  'too-large': '图表源码超过 50,000 字符，已回退为源码。',
  external: '图表需要访问外部资源，已回退为源码。',
  timeout: '图表渲染超时，已回退为源码。',
  load: '图表加载失败，已回退为源码。',
  syntax: '图表语法有误，已回退为源码。',
  render: '图表渲染失败，已回退为源码。',
  superseded: '正在绘制图表…'
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function MermaidBlockComponent({
  source,
  renderable,
  generation,
  onStatusChange
}: MermaidBlockProps): React.JSX.Element {
  const { t } = useI18n()
  // Slot keys must be unique across every chart on the page: two messages on
  // one screen number their generations independently, and a shared key would
  // make one chart's render supersede the other's.
  const slot = useId()
  const canvasRef = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<MermaidTheme>(() => (prefersDark() ? 'dark' : 'light'))
  const [view, setView] = useState<'chart' | 'source'>('chart')
  const [fit, setFit] = useState<Fit>('fit')
  const [failure, setFailure] = useState<MermaidFailureReason | undefined>(undefined)
  // Which source the current failure belongs to, so a later correction to the
  // same slot can tell a repaired fence from the one that failed.
  const [failedSource, setFailedSource] = useState<string | undefined>(undefined)
  const [attempt, setAttempt] = useState(0)
  const [drawn, setDrawn] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const statusRef = useRef(onStatusChange)
  statusRef.current = onStatusChange

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const sync = (): void => setTheme(media.matches ? 'dark' : 'light')
    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  // A failure belongs to the source that caused it. Streamed text that repairs
  // its own fence arrives as a new source on the same slot, and the fallback
  // is what unmounts the canvas — so the retry below would never run and the
  // chart would stay a code block until someone asked for it by hand.
  if (failure !== undefined && failedSource !== source) {
    setFailure(undefined)
    setFailedSource(undefined)
  }

  useLayoutEffect(() => {
    // Unmounted whenever the block is not renderable, so an unfinished fence
    // never reports itself as drawn. A layout effect so that a redraw — a theme
    // change, a retry — reports itself as drawing before the frame that still
    // shows the previous chart is painted; the host reads that status as its
    // readiness.
    const canvas = canvasRef.current
    if (!canvas) return
    let active = true
    const key = `${slot}:${generation}`
    const run = async (): Promise<void> => {
      setDrawn(false)
      setFailure(undefined)
      setFailedSource(undefined)
      statusRef.current(generation, 'drawing')
      try {
        const { svg } = await renderMermaidChart({
          key,
          source,
          theme,
          fontFamily: getComputedStyle(canvas).fontFamily || 'sans-serif',
          label: t('Mermaid 图表')
        })
        if (!active) return
        canvas.replaceChildren(svg)
        setDrawn(true)
        statusRef.current(generation, 'ready')
      } catch (error) {
        if (!active) return
        const reason = error instanceof MermaidRenderError ? error.reason : 'render'
        if (reason === 'superseded') return
        setFailure(reason)
        setFailedSource(source)
        statusRef.current(generation, 'failed')
      }
    }
    void run()
    return () => {
      active = false
      // The job may still be waiting its turn behind another chart; dropping it
      // keeps a diagram nobody is looking at from delaying the ones on screen.
      cancelMermaidRender(key)
    }
  }, [generation, renderable, source, theme, attempt, t])

  useEffect(() => {
    if (copyState === 'idle') return
    const timer = setTimeout(() => setCopyState('idle'), 2000)
    return () => clearTimeout(timer)
  }, [copyState])

  const copySource = useCallback(async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(source)
      setCopyState('copied')
    } catch {
      // A rejected write must not read as success; the source stays selectable.
      setCopyState('failed')
    }
  }, [source])

  const showChart = renderable && failure === undefined
  // Reached only while no chart is on screen, so either a fence is still open
  // (nothing failed yet) or a chart failed.
  const fallbackStatus = failure === undefined ? t('图表生成中…') : t(FAILURE_MESSAGES[failure])

  return (
    <div className="markdown-mermaid-figure">
      <div className="markdown-mermaid-toolbar">
        <span className="markdown-mermaid-label">{t('Mermaid 图表')}</span>
        <button
          type="button"
          className="markdown-mermaid-action"
          aria-pressed={view === 'source'}
          onClick={() => setView((current) => (current === 'chart' ? 'source' : 'chart'))}
        >
          {view === 'chart' ? t('图表源码') : t('图表')}
        </button>
        <button type="button" className="markdown-mermaid-action" onClick={() => void copySource()}>
          {copyState === 'copied' ? t('已复制') : t('复制源码')}
        </button>
      </div>

      {copyState === 'failed' ? (
        <p className="markdown-mermaid-status" role="status">
          {t('复制失败，请手动选择源码。')}
        </p>
      ) : null}

      {showChart ? (
        // The canvas stays mounted while the source view is showing; unmounting
        // it would drop the drawn SVG and force a re-render on every toggle.
        <div className="markdown-mermaid-view" hidden={view === 'source'}>
          <div className="markdown-mermaid-scroll">
            <div className="markdown-mermaid-canvas" data-fit={fit} ref={canvasRef} />
            {drawn ? null : (
              <p className="markdown-mermaid-status" role="status">
                {t('正在绘制图表…')}
              </p>
            )}
          </div>
          {drawn ? (
            // Sizing belongs to the chart area, not the top bar.
            <div className="markdown-mermaid-viewbar">
              <button
                type="button"
                className="markdown-mermaid-action"
                onClick={() => setFit((current) => (current === 'fit' ? 'actual' : 'fit'))}
              >
                {fit === 'fit' ? t('原始大小') : t('适应宽度')}
              </button>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="markdown-mermaid-fallback">
          <p className="markdown-mermaid-status" role="status">
            {fallbackStatus}
          </p>
          {failure !== undefined ? (
            <button
              type="button"
              className="markdown-mermaid-action"
              onClick={() => {
                setFailure(undefined)
                setAttempt((current) => current + 1)
              }}
            >
              {t('重试')}
            </button>
          ) : null}
        </div>
      )}

      {view === 'source' || !showChart ? (
        <pre className="markdown-mermaid-source">
          <code>{source}</code>
        </pre>
      ) : null}
    </div>
  )
}

export default MermaidBlockComponent
