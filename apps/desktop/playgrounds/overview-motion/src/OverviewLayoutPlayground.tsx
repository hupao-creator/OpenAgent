import { useState } from 'react'
import fc from 'fast-check'
import { ArrowLeft, ArrowRight, Download, RotateCcw, Shuffle } from 'lucide-react'
import { layoutOverview, type LayoutMember, type LayoutPlacement, type LayoutResult } from '../../../src/renderer/src/overview-layout'
import { overviewLayoutCaseArbitrary, type OverviewLayoutCase } from '../../../tests/property/overview-layout-cases'
import { layoutCases, parseLayoutCase } from './layout-cases'
import './layout-playground.css'

interface Frame {
  readonly previous: readonly LayoutPlacement[]
  readonly result: LayoutResult
}
interface Replay {
  readonly testCase: OverviewLayoutCase
  readonly frames: readonly Frame[]
  readonly index: number
}
const scale = 0.4
const begin = (testCase: OverviewLayoutCase): Replay => ({ testCase, index: 0,
  frames: [{ previous: testCase.previous, result: layoutOverview(testCase.previous, testCase.steps[0]!.members, testCase.geometry) }] })
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function OverviewLayoutPlayground(): React.JSX.Element {
  const [replay, setReplay] = useState(() => begin(layoutCases[0]!))
  const [preset, setPreset] = useState('0')
  const [seed, setSeed] = useState('20260910')
  const [json, setJson] = useState('')
  const [error, setError] = useState('')
  const [target, setTarget] = useState('01')
  const [showBefore, setShowBefore] = useState(true)
  const [progress, setProgress] = useState(1)
  const frame = replay.frames[replay.index]!
  const step = replay.testCase.steps[replay.index]!
  const { result, previous } = frame
  const { geometry } = replay.testCase
  const old = new Map(previous.map(p => [p.id, p]))
  const current = new Set(result.placements.map(p => p.id))
  const shifted = new Set(result.shiftedIds)
  const selected = result.placements.some(p => p.id === target) ? target : result.placements[0]?.id ?? ''
  const survivors = result.placements.filter(p => old.has(p.id)).length
  const added = result.placements.filter(p => !old.has(p.id)).length
  const deleted = previous.filter(p => !current.has(p.id)).length
  const displayed = progress === 1 ? result.placements : result.placements.flatMap(p => {
    const before = old.get(p.id)
    if (!before) return []
    const index = result.moveOrder.indexOf(p.id)
    const fraction = index < 0 ? 1 : Math.max(0, Math.min(1, progress * result.moveOrder.length - index))
    return [{ ...p, col: before.col + (p.col - before.col) * fraction, row: before.row + (p.row - before.row) * fraction,
      cols: Math.min(before.cols, p.cols), rows: Math.min(before.rows, p.rows) }]
  })
  const context = [...result.placements, ...previous]
  const extentCols = Math.max(1, ...context.map(p => p.col + p.cols))
  const extentRows = Math.max(1, ...context.map(p => p.row + p.rows))
  const pitchX = geometry.columnWidth + geometry.gap
  const pitchY = geometry.rowHeight + geometry.gap
  const style = (p: LayoutPlacement) => ({ left: p.col * pitchX * scale, top: p.row * pitchY * scale,
    width: (p.cols * pitchX - geometry.gap) * scale, height: (p.rows * pitchY - geometry.gap) * scale })

  const load = (testCase: OverviewLayoutCase, presetId = 'custom'): void => {
    try { const state = begin(testCase); setReplay(state); setPreset(presetId); setError(''); setProgress(1); setTarget(state.frames[0]!.result.placements[0]?.id ?? '') }
    catch (cause) { setError(message(cause)) }
  }
  const go = (index: number): void => {
    try {
      if (index < replay.frames.length) { setReplay({ ...replay, index }); setError(''); setProgress(1); return }
      const before = result.placements
      const next = layoutOverview(before, replay.testCase.steps[index]!.members, geometry)
      setReplay({ ...replay, index, frames: [...replay.frames, { previous: before, result: next }] }); setError(''); setProgress(1)
    } catch (cause) { setError(message(cause)) }
  }
  const change = (members: readonly LayoutMember[], label: string): void => {
    try {
      const next = layoutOverview(result.placements, members, geometry)
      setReplay({ testCase: { ...replay.testCase, steps: [...replay.testCase.steps.slice(0, replay.index + 1), { label, members }] },
        index: replay.index + 1, frames: [...replay.frames.slice(0, replay.index + 1), { previous: result.placements, result: next }] })
      setError(''); setProgress(1)
    } catch (cause) { setError(message(cause)) }
  }
  const download = (): void => {
    const data = JSON.stringify(replay.testCase, null, 2)
    setJson(data)
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = 'overview-layout-case.json'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return <main className="motion-playground layout-playground">
    <header className="motion-header">
      <div className="motion-brand"><span>OPENAGENT / PLAYGROUNDS</span><h1>Overview Layout</h1></div>
      <nav className="layout-nav" aria-label="Playground"><a href="?scene=lifecycle">动画</a><a href="?scene=layout" aria-current="page">Layout</a><a href="?scene=liquid">Liquid</a><a href="?scene=liquid-live">Liquid Live</a></nav>
    </header>
    <div className="layout-workspace">
      <section className="layout-view" aria-label="布局实验">
        <div className="layout-summary">
          <div><span>宽高接近 1:1</span><strong><output aria-label="布局比例">{result.aspect?.toFixed(3) ?? '—'}</output></strong></div>
          <div><span>整体包围盒</span><strong><output aria-label="布局宽高">{result.bounds.width} × {result.bounds.height}</output><small> px</small></strong></div>
          <div><span>总位移距离</span><strong><output aria-label="总位移距离">{result.totalShiftDistance.toFixed(1)}</output><small> px</small></strong></div>
        </div>
        <div className="layout-canvas-scroll" aria-label="布局平面，可横向和纵向滚动">
          <div className="layout-canvas" style={{ width: extentCols * pitchX * scale + 64, height: extentRows * pitchY * scale + 64 }}>
            <span className="layout-origin">0, 0</span>
            <div className="layout-plane">
              {showBefore && previous.filter(p => shifted.has(p.id) || !current.has(p.id)).map(p => <div key={`old:${p.id}`} className="layout-before" style={style(p)} aria-hidden="true"><span>{p.id} · 原位</span></div>)}
              {!!result.placements.length && <div className="layout-bounds" aria-hidden="true" style={{
                left: result.bounds.col * pitchX * scale - 3, top: result.bounds.row * pitchY * scale - 3,
                width: result.bounds.width * scale + 6, height: result.bounds.height * scale + 6
              }} />}
              {displayed.map(p => <button type="button" key={p.id} className="layout-member" style={style(p)}
                data-layout-id={p.id} data-col={p.col} data-row={p.row} data-cols={p.cols} data-rows={p.rows}
                data-state={shifted.has(p.id) ? 'shifted' : old.has(p.id) ? 'stable' : 'added'}
                aria-label={`选择卡片 ${p.id}`} aria-pressed={selected === p.id} onClick={() => setTarget(p.id)}>
                <span className="layout-member-id">{p.id}</span><span>{p.cols} × {p.rows}<small>({p.col}, {p.row})</small></span>
              </button>)}
              {!result.placements.length && <p className="layout-empty">布局为空，下一步将继续回放。</p>}
            </div>
          </div>
        </div>
        <footer className="layout-footer"><span><i data-state="stable" />保留原位</span><span><i data-state="added" />新增 {added}</span><span><i data-state="shifted" />移动 <output aria-label="移动成员数">{result.shiftedIds.length}</output> / {survivors}</span><span>移除 {deleted}</span><span>示意比例 40% · 距离按原始像素计</span></footer>
      </section>
      <aside className="motion-inspector">
        <section className="motion-section">
          <h2>布局场景</h2>
          <select aria-label="布局场景" value={preset} onChange={event => load(layoutCases[Number(event.target.value)]!, event.target.value)}>
            {layoutCases.map((c, i) => <option key={c.name} value={i}>{c.name}</option>)}
            {preset === 'custom' && <option value="custom">{replay.testCase.name}</option>}
          </select>
          <p className="layout-contract">无内部空洞，直线全程无碰撞。在此基础上先接近 1:1，再缩短总位移。宽度和列数不设上限。</p>
          <label className="layout-checkbox"><input type="checkbox" checked={showBefore} onChange={event => setShowBefore(event.target.checked)} />显示移动、移除前的位置</label>
        </section>
        <section className="motion-section">
          <div className="motion-section-heading"><h2>逐步回放</h2><span>{replay.index + 1} / {replay.testCase.steps.length}</span></div>
          <p className="layout-step" aria-live="polite">{step.label}</p>
          <div className="motion-transport">
            <button type="button" title="上一步" aria-label="上一步" disabled={replay.index === 0} onClick={() => go(replay.index - 1)}><ArrowLeft size={15} /></button>
            <button type="button" className="motion-primary" aria-label="下一步" disabled={replay.index + 1 === replay.testCase.steps.length} onClick={() => go(replay.index + 1)}>下一步<ArrowRight size={15} /></button>
            <button type="button" title="重置布局场景" aria-label="重置布局场景" onClick={() => load(replay.testCase, preset)}><RotateCcw size={15} /></button>
          </div>
          <p className="layout-shifts">{result.shiftedIds.length ? `移动成员：${result.shiftedIds.join('、')}` : '本次没有现有成员移动。'}</p>
        </section>
        <section className="motion-section layout-movement-preview">
          <h2>直线移动过程</h2>
          <label className="layout-progress-label">{progress === 1 ? '最终布局' : `第 ${Math.min(result.moveOrder.length, Math.floor(progress * result.moveOrder.length) + 1)} 段直线移动`}
            <input aria-label="移动进度" type="range" min="0" max="1" step="0.001" value={progress} disabled={!result.moveOrder.length} onChange={event => setProgress(Number(event.target.value))} />
          </label>
          <p className="layout-shifts">移动顺序：<output aria-label="移动顺序">{result.moveOrder.join(' → ') || '无需移动'}</output></p>
          <p className="layout-certainty" role="status">{result.distanceOptimal ? '零位移 · 总距离已证明最优'
            : result.searchComplete ? '搜索已完成 · 浮点结果，未认证精确最优' : '合法方案 · 搜索尚未完成'}</p>
          <p className="layout-shifts">搜索计步：<output aria-label="搜索计步">{result.work.steps}</output> · 候选阶段：<output aria-label="候选搜索计步">{result.work.candidateSteps}</output></p>
        </section>
        <section className="motion-section">
          <h2>修改输入</h2>
          <label className="layout-target">成员<select aria-label="操作成员" value={selected} onChange={event => setTarget(event.target.value)} disabled={!result.placements.length}>
            {!result.placements.length && <option value="">无成员</option>}
            {result.placements.map(p => <option key={p.id}>{p.id}</option>)}
          </select></label>
          <div className="motion-actions">
            <button type="button" onClick={() => { let i = 1; while (current.has(`new-${i}`)) i++; change([...step.members, { id: `new-${i}`, cols: 1, rows: 1 }], `新增 new-${i}`) }}>新增 1×1</button>
            <button type="button" disabled={!selected} onClick={() => change(step.members.filter(p => p.id !== selected), `移除 ${selected}`)}>移除</button>
            {[1, 2].map(size => <button type="button" disabled={!selected} key={size} onClick={() => change(step.members.map(p => p.id === selected ? { ...p, cols: size, rows: size } : p), `${selected} → ${size}×${size}`)}>{size}×{size}</button>)}
          </div>
        </section>
        <section className="motion-section">
          <h2>生成与保存</h2>
          <label className="layout-target">Seed<input aria-label="随机种子" value={seed} onChange={event => setSeed(event.target.value)} /></label>
          <div className="motion-actions"><button type="button" onClick={() => {
            try { const number = Number(seed); if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647 || !seed.trim()) throw new Error('Seed 需要是 32 位整数')
              load({ ...fc.sample(overviewLayoutCaseArbitrary(20), { seed: number, numRuns: 1 })[0]!, name: `Seed ${number}` })
            } catch (cause) { setError(message(cause)) }
          }}><Shuffle size={13} />生成序列</button><button type="button" onClick={download}><Download size={13} />导出 JSON</button></div>
          <details className="layout-import"><summary>导入场景或 PBT 反例</summary>
            <textarea aria-label="场景 JSON" value={json} onChange={event => setJson(event.target.value)} spellCheck={false} placeholder="粘贴完整 case 或 sequence property 的 counterexample JSON" />
            <button type="button" onClick={() => { try { load(parseLayoutCase(json)) } catch (cause) { setError(message(cause)) } }}>载入 JSON</button>
          </details>
        </section>
        <section className="motion-section layout-test-note"><h2>独立 PBT</h2><p>独立检查无内部空洞、每段直线与移动顺序、最优比例和总位移。小规模穷举最优距离；大规模显示搜索是否完成。生成序列用于探索，测试结果以终端为准。</p><code>pnpm test:layout</code></section>
        {error && <div role="alert" className="layout-error">{error}</div>}
      </aside>
    </div>
  </main>
}
