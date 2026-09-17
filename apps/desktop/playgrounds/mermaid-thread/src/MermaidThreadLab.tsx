import { useState } from 'react'
import { MarkdownBody } from '@openagent/plugin-kit/renderer'
import { STREAM_CHUNKS, UNTERMINATED_FENCE, scenes } from './scenes'

const COLUMNS = [
  { id: 'wide', label: '常规消息列', width: 720 },
  { id: 'narrow', label: '窄窗口', width: 420 }
] as const

type ColumnId = (typeof COLUMNS)[number]['id']

function param(name: string, allowed: readonly string[]): string | undefined {
  const value = new URLSearchParams(location.search).get(name)
  return value && allowed.includes(value) ? value : undefined
}

/**
 * A real message column running the production `MarkdownBody`, so the browser
 * can check what jsdom cannot: the dynamic Mermaid import, real layout, real
 * network behaviour and real theme switches.
 */
export function MermaidThreadLab(): React.JSX.Element {
  const sceneIds = scenes.map((scene) => scene.id)
  const [sceneId, setSceneId] = useState(() => param('scene', sceneIds) ?? 'types')
  const [columnId, setColumnId] = useState<ColumnId>(
    () => (param('column', COLUMNS.map((column) => column.id)) ?? 'wide') as ColumnId
  )
  const [mermaid, setMermaid] = useState(() => param('mermaid', ['on', 'off']) !== 'off')
  const [unterminated, setUnterminated] = useState(() => param('mode', ['chunks', 'unterminated']) === 'unterminated')
  const [step, setStep] = useState(() => Number(param('step', ['0', '1', '2', '3', '4']) ?? 0))
  const [streaming, setStreaming] = useState(true)
  const scene = scenes.find((candidate) => candidate.id === sceneId) ?? scenes[0]
  const column = COLUMNS.find((candidate) => candidate.id === columnId) ?? COLUMNS[0]

  const isStream = scene.id === 'stream'
  const content = !isStream ? scene.content : unterminated ? UNTERMINATED_FENCE : STREAM_CHUNKS[step]

  return (
    <div className="lab" data-scene={scene.id} data-streaming={String(isStream && streaming)} data-step={String(step)}>
      <header className="lab-bar">
        <strong>Mermaid Thread Lab</strong>
        <nav>
          {scenes.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              aria-pressed={candidate.id === scene.id}
              onClick={() => setSceneId(candidate.id)}
            >
              {candidate.label}
            </button>
          ))}
        </nav>
        <label>
          列宽
          <select value={columnId} onChange={(event) => setColumnId(event.target.value as ColumnId)}>
            {COLUMNS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}（{candidate.width}px）
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={mermaid} onChange={(event) => setMermaid(event.target.checked)} />
          启用 Mermaid
        </label>
        {isStream ? (
          <span className="lab-stream">
            <button type="button" onClick={() => setStreaming((current) => !current)}>
              {streaming ? '结束流式' : '回到流式'}
            </button>
            <button
              type="button"
              disabled={!streaming || step >= STREAM_CHUNKS.length - 1}
              onClick={() => setStep((current) => current + 1)}
            >
              下一段
            </button>
            <button
              type="button"
              aria-pressed={unterminated}
              onClick={() => {
                setUnterminated((current) => !current)
                setStep(0)
              }}
            >
              无闭合行
            </button>
            <button type="button" onClick={() => setStep(0)}>
              重放
            </button>
          </span>
        ) : null}
      </header>

      <p className="lab-expectation">{scene.expectation}</p>

      <main className="lab-column" style={{ width: column.width }}>
        <MarkdownBody content={content} streaming={isStream && streaming} mermaid={mermaid} />
      </main>
    </div>
  )
}
