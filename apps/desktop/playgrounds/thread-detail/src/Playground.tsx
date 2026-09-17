import { useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleHelp,
  FileText,
  Link2,
  Maximize2,
  Menu,
  Minimize2,
  Monitor,
  Moon,
  PanelLeftClose,
  RotateCcw,
  SlidersHorizontal,
  Sun,
  X
} from 'lucide-react'
import {
  harnesses,
  scenarios,
  type ScenarioId,
  type ThreadKind
} from './fixtures'
import { copyText, ThreadDetail } from './ThreadDetail'
import { NativePreview } from './NativePreview'
import { ThreadDetailFrame } from '@openagent/plugin-kit/renderer'

type Options = {
  scenario: ScenarioId
  renderer: 'design' | 'plugin'
  harness: string
  kind: ThreadKind
  width: 'auto' | '960' | '640'
  density: 'comfortable' | 'compact'
  theme: 'light' | 'dark'
  annotations: boolean
  focus: boolean
}

function readOptions(): Options {
  const params = new URLSearchParams(window.location.search)
  return {
    renderer: params.get('renderer') === 'design' ? 'design' : 'plugin',
    scenario:
      scenarios.find((item) => item.id === params.get('scenario'))?.id ??
      'completed',
    harness:
      harnesses.find((item) => item.id === params.get('harness'))?.id ??
      'codex',
    kind: params.get('kind') === 'bart' ? 'bart' : 'agent',
    width:
      params.get('width') === '960'
        ? '960'
        : params.get('width') === '640'
          ? '640'
          : 'auto',
    density: params.get('density') === 'compact' ? 'compact' : 'comfortable',
    theme: params.get('theme') === 'dark' ? 'dark' : 'light',
    annotations: params.get('annotations') === 'true',
    focus: params.get('focus') === 'true'
  }
}

export function Playground(): React.JSX.Element {
  const [options, setOptions] = useState(readOptions)
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')
  const [navOpen, setNavOpen] = useState(false)
  const [guide, setGuide] = useState(false)
  const [width, setWidth] = useState(0)
  const viewportRef = useRef<HTMLElement>(null)
  const scenario =
    scenarios.find((item) => item.id === options.scenario) ?? scenarios[0]
  const harness =
    harnesses.find((item) => item.id === options.harness) ?? harnesses[0]

  const update = <K extends keyof Options>(key: K, value: Options[K]): void => {
    setOptions((current) => ({ ...current, [key]: value }))
  }

  useEffect(() => {
    const params = new URLSearchParams()
    Object.entries(options).forEach(([key, value]) =>
      params.set(key, String(value))
    )
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params}`
    )
  }, [options])

  useEffect(() => {
    const onPopState = (): void => setOptions(readOptions())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 3500)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width))
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setGuide(false)
        setNavOpen(false)
        setOptions((current) =>
          current.focus ? { ...current, focus: false } : current
        )
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      className="pg-app"
      data-theme={options.theme}
      data-focus={options.focus}
      data-density={options.density}
    >
      <aside
        className="pg-sidebar"
        data-open={navOpen}
        aria-label="Playground 控制"
      >
        <div className="pg-brand">
          <span className="pg-brand-mark">O</span>
          <strong>OpenAgent</strong>
          <button
            className="pg-icon pg-nav-close"
            type="button"
            aria-label="关闭场景导航"
            onClick={() => setNavOpen(false)}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <div className="pg-workspace-label">
          <FileText size={14} />
          <span>Thread 详情</span>
          <span className="pg-draft-label">草稿</span>
        </div>
        <div className="pg-sidebar-scroll">
          <section className="pg-control-section">
            <h2>预览入口</h2>
            <div className="pg-kind-tabs" aria-label="渲染视图">
              <button type="button" aria-pressed={options.renderer === 'plugin'} onClick={() => update('renderer', 'plugin')}>插件接入</button>
              <button type="button" aria-pressed={options.renderer === 'design'} onClick={() => update('renderer', 'design')}>设计稿</button>
            </div>
            <div className="pg-kind-tabs" aria-label="Thread 类型">
              {(
                [
                  { id: 'agent', label: 'Thread' },
                  { id: 'bart', label: 'Bart' }
                ] as const
              ).map((item) => (
                <button
                  type="button"
                  aria-pressed={options.kind === item.id}
                  key={item.id}
                  onClick={() => update('kind', item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <label className="pg-select-label">
              Harness
              <select
                aria-label="Harness"
                value={options.harness}
                onChange={(event) =>
                  update('harness', event.currentTarget.value)
                }
              >
                {harnesses.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </section>
          <nav className="pg-scenarios" aria-label="预览场景">
            <h2>
              场景<span>{String(scenarios.length).padStart(2, '0')}</span>
            </h2>
            {scenarios.map((item) => (
              <button
                type="button"
                className="pg-scenario"
                aria-current={options.scenario === item.id ? 'page' : undefined}
                key={item.id}
                onClick={() => {
                  update('scenario', item.id)
                  setNavOpen(false)
                }}
              >
                <span className="pg-scenario-number">{item.number}</span>
                <span>{item.label}</span>
                {options.scenario === item.id ? (
                  <ChevronRight size={13} />
                ) : null}
              </button>
            ))}
          </nav>
          <section className="pg-control-section pg-appearance">
            <h2>展示设置</h2>
            <label className="pg-select-label">
              画布宽度
              <select
                aria-label="画布宽度"
                value={options.width}
                onChange={(event) =>
                  update('width', event.currentTarget.value as Options['width'])
                }
              >
                <option value="auto">自适应</option>
                <option value="960">960 px</option>
                <option value="640">640 px</option>
              </select>
            </label>
            <label className="pg-select-label">
              内容间距
              <select
                aria-label="内容间距"
                value={options.density}
                onChange={(event) =>
                  update(
                    'density',
                    event.currentTarget.value as Options['density']
                  )
                }
              >
                <option value="comfortable">舒适</option>
                <option value="compact">紧凑</option>
              </select>
            </label>
            {options.renderer === 'design' ? <label className="pg-switch-label">
              <span>
                <SlidersHorizontal size={13} />
                布局标注
              </span>
              <input
                type="checkbox"
                checked={options.annotations}
                onChange={(event) =>
                  update('annotations', event.currentTarget.checked)
                }
              />
              <span className="pg-switch" aria-hidden="true" />
            </label> : null}
          </section>
        </div>
        <div className="pg-sidebar-footer">
          <a
            href="https://github.com/VoltAgent/awesome-design-md/blob/main/design-md/notion/DESIGN.md"
            target="_blank"
            rel="noreferrer"
          >
            <span className="pg-reference-mark">N</span>
            <span>
              Notion 风格<small>设计参考 ↗</small>
            </span>
          </a>
          <button
            className="pg-icon"
            type="button"
            aria-label="使用说明"
            aria-expanded={guide}
            onClick={() => setGuide(!guide)}
          >
            <CircleHelp size={16} />
          </button>
        </div>
      </aside>
      {navOpen ? (
        <button
          className="pg-nav-scrim"
          type="button"
          aria-label="关闭场景导航遮罩"
          onClick={() => setNavOpen(false)}
        />
      ) : null}

      <div className="pg-main">
        <header className="pg-topbar">
          <div className="pg-breadcrumb">
            <button
              className="pg-icon pg-mobile-menu"
              type="button"
              aria-label="打开场景导航"
              onClick={() => setNavOpen(true)}
            >
              <Menu size={17} />
            </button>
            <span>Playground</span>
            <ChevronRight size={13} />
            <strong>{scenario.label}</strong>
            <span className="pg-version">v0.1</span>
          </div>
          <div className="pg-topbar-actions">
            <span className="pg-local-label">
              <span />
              本地样例
            </span>
            <button
              className="pg-icon"
              type="button"
              aria-label={options.theme === 'light' ? '切换深色' : '切换浅色'}
              onClick={() =>
                update('theme', options.theme === 'light' ? 'dark' : 'light')
              }
            >
              {options.theme === 'light' ? (
                <Moon size={15} />
              ) : (
                <Sun size={15} />
              )}
            </button>
            <button
              className="pg-icon"
              type="button"
              aria-label="复制当前场景链接"
              onClick={() => void copyText(window.location.href, setNotice)}
            >
              <Link2 size={15} />
            </button>
            <button
              className="pg-focus-button"
              type="button"
              onClick={() => update('focus', !options.focus)}
            >
              {options.focus ? (
                <Minimize2 size={14} />
              ) : (
                <Maximize2 size={14} />
              )}
              <span>{options.focus ? '退出专注' : '专注预览'}</span>
            </button>
          </div>
        </header>
        <div className="pg-stage-header">
          <div>
            <span className="pg-design-label">THREAD DETAIL</span>
            <span className="pg-stage-title">{scenario.description}</span>
          </div>
          <button
            type="button"
            className="pg-reset"
            onClick={() => {
              setRevision((value) => value + 1)
              setNotice('已恢复当前场景。')
            }}
          >
            <RotateCcw size={12} />
            重置场景
          </button>
        </div>
        <div className="pg-stage">
          <ThreadDetailFrame
            ref={viewportRef}
            className="pg-viewport"
            style={{
              maxWidth:
                options.width === 'auto' ? undefined : `${options.width}px`
            }}
          >
            {options.renderer === 'plugin' ? <NativePreview
              key={`${options.harness}:${options.kind}:${options.scenario}:${revision}`}
              harness={harness}
              scenario={scenario}
              kind={options.kind}
              onNotice={setNotice}
              onBack={() => { update('focus', false); setNavOpen(true) }}
            /> : <ThreadDetail
              key={`${options.kind}:${options.scenario}:${revision}`}
              harness={harness}
              scenario={scenario}
              kind={options.kind}
              annotations={options.annotations}
              onNotice={setNotice}
              onBack={() => {
                update('focus', false)
                setNavOpen(true)
                document
                  .querySelector<HTMLButtonElement>(
                    '.pg-scenario[aria-current="page"]'
                  )
                  ?.focus()
              }}
            />}
          </ThreadDetailFrame>
        </div>
        <footer className="pg-stage-footer">
          <span>
            <Monitor size={12} />
            {width} px<span className="pg-footer-separator">/</span>
            {options.density === 'comfortable' ? '舒适间距' : '紧凑间距'}
          </span>
          <span>
            交互仅作用于样例<span className="pg-footer-separator">·</span>
            {options.renderer === 'plugin' ? '正式插件渲染器' : '设计参考'}
          </span>
        </footer>
      </div>

      {guide ? (
        <section className="pg-guide" role="dialog" aria-label="使用说明">
          <header>
            <strong>评审这个版本</strong>
            <button
              className="pg-icon"
              type="button"
              aria-label="关闭使用说明"
              onClick={() => setGuide(false)}
            >
              <X size={15} />
            </button>
          </header>
          <ol>
            <li>切换场景，检查内容和状态层级。</li>
            <li>切换 Harness，检查正式插件；切到设计稿可对照原型。</li>
            <li>展开工具、计划和文件变更。</li>
            <li>切换宽度与间距，检查阅读体验。</li>
            <li>设计稿支持布局标注；复制链接可反馈当前视图与场景。</li>
          </ol>
          <p>
            样例中的审批、输入和续写会模拟状态变化，回复内容为固定样例。此页面不连接
            Agent。
          </p>
          <a
            href="https://github.com/xinyuan0801/OpenAgent/pull/15"
            target="_blank"
            rel="noreferrer"
          >
            查看接入 PR ↗
          </a>
        </section>
      ) : null}
      {notice ? (
        <div className="pg-toast" role="status">
          <Check size={14} />
          {notice}
        </div>
      ) : null}
    </div>
  )
}
