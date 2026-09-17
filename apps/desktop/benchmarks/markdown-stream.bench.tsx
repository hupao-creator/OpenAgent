import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import '../src/renderer/src/fonts.css'
import '../src/renderer/src/styles.css'
import { MarkdownBody } from '@openagent/plugin-kit/renderer'
import type { MarkdownRenderTelemetry } from '../../../packages/openagent-plugin-kit/src/renderer/markdown/useIncrementalMarkdownDom'

interface SampleResult {
  scenario: string
  sample: number
  workerParse: number[]
  workerTransform: number[]
  workerDiff: number[]
  mainBatches: number[]
  longTasks: number[]
  inputDelay: number[]
  frameGaps: number[]
  droppedFrames: number
  settledBatches: number[]
  settledMainDuration: number
  equivalent: boolean
}

interface ScenarioSummary {
  scenario: string
  samples: number
  parser: Percentiles
  workerTransform: Percentiles
  workerDiff: Percentiles
  mainThreadCommit: Percentiles
  longTasks: number
  maxLongTask: number
  taskDuration: number
  inputDelay: Percentiles
  frameGap: Percentiles
  droppedFrames: number
  settledMainBatch: Percentiles
  settledTotalMain: Percentiles
  equivalent: boolean
}

interface Percentiles {
  p50: number
  p95: number
  p99: number
  max: number
}

const UPDATE_HZ = 30
const STREAM_MS = 2_000
const UPDATE_COUNT = UPDATE_HZ * (STREAM_MS / 1_000)
const SAMPLE_COUNT = Number(new URLSearchParams(location.search).get('samples') || 5)

function BenchmarkApp(): React.JSX.Element {
  const [status, setStatus] = useState('Preparing production Chromium benchmark…')
  const [content, setContent] = useState('')
  const [streaming, setStreaming] = useState(true)
  const [renderKey, setRenderKey] = useState(0)
  const telemetryRef = useRef<MarkdownRenderTelemetry[]>([])
  const currentResolveRef = useRef<(() => void) | undefined>(undefined)

  const onTelemetry = useCallback((telemetry: MarkdownRenderTelemetry) => {
    telemetryRef.current.push(telemetry)
    if (!telemetry.streaming) currentResolveRef.current?.()
  }, [])

  useEffect(() => {
    void run()

    async function run(): Promise<void> {
      // `playwright-cli open` captures an initial accessibility snapshot. Keep
      // that setup work outside every measured interaction window.
      setStatus('Warming up Chromium…')
      await wait(8_000)
      const scenarios = [
        { name: '10k-gfm-table', content: makeTableFixture(10_000) },
        { name: '50k-gfm-table', content: makeTableFixture(50_000) },
        { name: '50k-adversarial-boundaries', content: makeAdversarialFixture(50_000) }
      ]
      const results: SampleResult[] = []
      for (const scenario of scenarios) {
        for (let sample = 1; sample <= SAMPLE_COUNT; sample += 1) {
          setStatus(`${scenario.name}: sample ${sample}/${SAMPLE_COUNT}`)
          results.push(await runSample(scenario.name, scenario.content, sample))
        }
      }
      const summaries = scenarios.map((scenario) =>
        summarize(scenario.name, results.filter((result) => result.scenario === scenario.name))
      )
      const report = {
        environment: {
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency,
          updateHz: UPDATE_HZ,
          streamMs: STREAM_MS,
          samples: SAMPLE_COUNT
        },
        summaries,
        samples: results
      }
      document.querySelector('#benchmark-json')!.textContent = JSON.stringify(report, null, 2)
      document.body.dataset.benchmarkComplete = 'true'
      ;(window as Window & { __MARKDOWN_BENCHMARK__?: unknown }).__MARKDOWN_BENCHMARK__ = report
      setStatus('Complete')
    }

    async function runSample(
      scenario: string,
      finalText: string,
      sample: number
    ): Promise<SampleResult> {
      telemetryRef.current = []
      setRenderKey((value) => value + 1)
      setContent('')
      setStreaming(true)
      await nextFrames(2)

      const longTasks: number[] = []
      const observer = observeLongTasks(longTasks)
      const inputDelay: number[] = []
      const frameGaps: number[] = []
      let probing = true
      const stopInputProbe = startInputProbe(inputDelay, () => probing)
      const stopFrameProbe = startFrameProbe(frameGaps, () => probing)
      const chunks = appendOnlyChunks(finalText, UPDATE_COUNT)
      const started = performance.now()
      for (let index = 0; index < chunks.length; index += 1) {
        setContent(chunks[index])
        await waitUntil(started + ((index + 1) * 1_000) / UPDATE_HZ)
      }

      const settled = new Promise<void>((resolve) => {
        currentResolveRef.current = resolve
      })
      setStreaming(false)
      await Promise.race([settled, wait(10_000)])
      currentResolveRef.current = undefined
      await nextFrames(2)
      probing = false
      stopInputProbe()
      stopFrameProbe()
      observer?.disconnect()

      const telemetry = telemetryRef.current
      const streamingTelemetry = telemetry.filter((entry) => entry.streaming)
      const settledTelemetry = telemetry.filter((entry) => !entry.streaming).at(-1)
      const equivalent = await compareWithDirect(finalText)
      return {
        scenario,
        sample,
        workerParse: streamingTelemetry.map((entry) => entry.parseDuration),
        workerTransform: streamingTelemetry.map((entry) => entry.transformDuration),
        workerDiff: streamingTelemetry.map((entry) => entry.diffDuration),
        mainBatches: telemetry.flatMap((entry) => entry.mainThreadBatches),
        longTasks,
        inputDelay,
        frameGaps,
        droppedFrames: frameGaps.filter((gap) => gap > 25).length,
        settledBatches: settledTelemetry?.mainThreadBatches ?? [],
        settledMainDuration: settledTelemetry?.mainThreadDuration ?? 0,
        equivalent
      }
    }
  }, [])

  return (
    <main>
      <h1>Streaming Markdown production benchmark</h1>
      <p id="benchmark-status" aria-live="polite">
        {status}
      </p>
      <button id="input-probe" type="button">
        Input probe
      </button>
      <section id="benchmark-surface">
        <MarkdownBody
          key={renderKey}
          content={content}
          streaming={streaming}
          onRenderTelemetry={onTelemetry}
        />
      </section>
      <pre id="benchmark-json" />
    </main>
  )
}

function summarize(scenario: string, samples: SampleResult[]): ScenarioSummary {
  const longTasks = samples.flatMap((sample) => sample.longTasks)
  const frameGaps = samples.flatMap((sample) => sample.frameGaps)
  return {
    scenario,
    samples: samples.length,
    parser: percentiles(samples.flatMap((sample) => sample.workerParse)),
    workerTransform: percentiles(samples.flatMap((sample) => sample.workerTransform)),
    workerDiff: percentiles(samples.flatMap((sample) => sample.workerDiff)),
    mainThreadCommit: percentiles(samples.flatMap((sample) => sample.mainBatches)),
    longTasks: longTasks.length,
    maxLongTask: Math.max(0, ...longTasks),
    taskDuration: sum(longTasks),
    inputDelay: percentiles(samples.flatMap((sample) => sample.inputDelay)),
    frameGap: percentiles(frameGaps),
    droppedFrames: samples.reduce((total, sample) => total + sample.droppedFrames, 0),
    settledMainBatch: percentiles(samples.flatMap((sample) => sample.settledBatches)),
    settledTotalMain: percentiles(samples.map((sample) => sample.settledMainDuration)),
    equivalent: samples.every((sample) => sample.equivalent)
  }
}

function percentiles(values: number[]): Percentiles {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (quantile: number): number => {
    if (sorted.length === 0) return 0
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]
  }
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }
}

function appendOnlyChunks(content: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    content.slice(0, Math.ceil((content.length * (index + 1)) / count))
  )
}

function makeTableFixture(targetLength: number): string {
  const header = '| index | code | link | status |\n| ---: | --- | --- | :---: |\n'
  let content = header
  let index = 0
  while (content.length < targetLength) {
    content += `| ${index} | \`const value_${index} = ${index}\` | [docs][reference] | ${index % 2 ? 'ready' : 'pending'} |\n`
    index += 1
  }
  return `${content.slice(0, targetLength - 42)}\n\n[reference]: https://example.com "Docs"\n`
}

function makeAdversarialFixture(targetLength: number): string {
  const unit = [
    '> quote with a lazy',
    '> continuation and **emphasis**',
    '',
    '- list item',
    '  - nested item with [reference][later]',
    '',
    '| escaped | value |',
    '| --- | ---: |',
    '| a \\| pipe | `code` |',
    '',
    '```ts',
    'const fence = "``` inside a string"',
    '```',
    '',
    '<section>raw HTML remains text</section>',
    '',
    '[^footnote-like-reference]',
    '',
    '[later]: https://example.com/path',
    ''
  ].join('\n')
  return unit.repeat(Math.ceil(targetLength / unit.length)).slice(0, targetLength)
}

function observeLongTasks(target: number[]): PerformanceObserver | undefined {
  if (typeof PerformanceObserver === 'undefined') return undefined
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) target.push(entry.duration)
    })
    observer.observe({ type: 'longtask', buffered: false })
    return observer
  } catch {
    return undefined
  }
}

function startInputProbe(target: number[], active: () => boolean): () => void {
  let timer = 0
  let expected = performance.now() + 16
  const tick = (): void => {
    if (!active()) return
    const now = performance.now()
    target.push(Math.max(0, now - expected))
    expected = now + 16
    timer = window.setTimeout(tick, 16)
  }
  timer = window.setTimeout(tick, 16)
  return () => clearTimeout(timer)
}

function startFrameProbe(target: number[], active: () => boolean): () => void {
  let frame = 0
  let previous = performance.now()
  const tick = (now: number): void => {
    if (!active()) return
    target.push(now - previous)
    previous = now
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

async function compareWithDirect(content: string): Promise<boolean> {
  const incremental = document.querySelector('#benchmark-surface .markdown-body')
  if (!incremental) return false
  const direct = document.createElement('div')
  document.body.appendChild(direct)
  const root = createRoot(direct)
  root.render(<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>)
  await nextFrames(2)
  const equal =
    incremental.childNodes.length === direct.childNodes.length &&
    Array.from(incremental.childNodes).every((node, index) => node.isEqualNode(direct.childNodes[index]))
  if (!equal) {
    const benchmarkWindow = window as Window & { __MARKDOWN_MISMATCHES__?: unknown[] }
    benchmarkWindow.__MARKDOWN_MISMATCHES__ ??= []
    benchmarkWindow.__MARKDOWN_MISMATCHES__.push(
      incremental.childNodes.length !== direct.childNodes.length
        ? { actualChildren: incremental.childNodes.length, expectedChildren: direct.childNodes.length }
        : Array.from(incremental.childNodes)
            .map((node, index) => firstDomDifference(node, direct.childNodes[index], `root[${index}]`))
            .find(Boolean)
    )
  }
  root.unmount()
  direct.remove()
  return equal
}

function firstDomDifference(actual: Node, expected: Node, path: string): unknown {
  if (actual.nodeType !== expected.nodeType || actual.nodeName !== expected.nodeName) {
    return { path, actual: actual.nodeName, expected: expected.nodeName }
  }
  if (actual instanceof Element && expected instanceof Element) {
    const actualAttributes = [...actual.attributes].map(({ name, value }) => [name, value]).sort()
    const expectedAttributes = [...expected.attributes].map(({ name, value }) => [name, value]).sort()
    if (JSON.stringify(actualAttributes) !== JSON.stringify(expectedAttributes)) {
      return { path, actualAttributes, expectedAttributes }
    }
  } else if (actual.nodeValue !== expected.nodeValue) {
    return { path, actual: actual.nodeValue, expected: expected.nodeValue }
  }
  if (actual.childNodes.length !== expected.childNodes.length) {
    return { path, actualChildren: actual.childNodes.length, expectedChildren: expected.childNodes.length }
  }
  for (let index = 0; index < actual.childNodes.length; index += 1) {
    const child = firstDomDifference(
      actual.childNodes[index],
      expected.childNodes[index],
      `${path}/${actual.childNodes[index].nodeName}[${index}]`
    )
    if (child) return child
  }
  return undefined
}

function wait(duration: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, duration))
}

async function waitUntil(deadline: number): Promise<void> {
  await wait(Math.max(0, deadline - performance.now()))
}

async function nextFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

createRoot(document.querySelector('#root')!).render(<BenchmarkApp />)
