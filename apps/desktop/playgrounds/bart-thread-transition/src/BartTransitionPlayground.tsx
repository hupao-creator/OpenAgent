import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AppShell,
  SubscribedBartDock,
  SubscribedBartThreadView,
  SubscribedConversationOverview
} from '../../../src/renderer/src/components/RendererSurfaces'
import { createBartComposerStore } from '../../../src/renderer/src/bart-composer-store'
import type { OverviewView } from '../../../src/renderer/src/conversation-overview-layout'
import { createOverviewOrchestrationStore } from '../../../src/renderer/src/overview-orchestration-store'
import { RendererStoreProvider, useRendererState } from '../../../src/renderer/src/renderer-store-context'
import { createRendererStateStore, hydrateRendererStateStore } from '../../../src/shared/renderer-store'
import { BART_THREAD_ID, createFakeRendererState } from './fake-state'
import { DEFAULT_DURATION } from '../../../src/renderer/src/bart-thread-transition/transitions'
import { BART_REACTION } from '../../../src/renderer/src/bart-thread-transition/eye-dive'
import { useCameraTransition } from '../../../src/renderer/src/bart-thread-transition/use-camera-transition'

const cwd = '/demo/bart-transition'
const MOTION_SCENE_KEY = 'playground:bart-transition'

interface PlaygroundParams {
  readonly duration: number | null
}

function readParams(): PlaygroundParams {
  const params = new URLSearchParams(location.search)
  const rawDuration = params.get('dur') ? Number(params.get('dur')) : null
  const duration = rawDuration !== null && Number.isFinite(rawDuration)
    ? Math.min(1800, Math.max(600, rawDuration))
    : null
  return { duration }
}

export function BartTransitionPlayground(): React.JSX.Element {
  const initial = useMemo(readParams, [])
  const [store] = useState(() => {
    const created = createRendererStateStore(cwd)
    hydrateRendererStateStore(created, createFakeRendererState())
    return created
  })
  return <RendererStoreProvider store={store}>
    <BartTransitionWorkspace initial={initial} />
  </RendererStoreProvider>
}

function BartTransitionWorkspace(props: {
  readonly initial: PlaygroundParams
}): React.JSX.Element {
  const [composer] = useState(createBartComposerStore)
  const [orchestration] = useState(createOverviewOrchestrationStore)

  const [duration, setDuration] = useState(props.initial.duration ?? DEFAULT_DURATION)
  const [slow, setSlow] = useState(false)
  const [panelCollapsed, setPanelCollapsed] = useState(false)
  const camera = useCameraTransition({ duration, slow })
  const { open: bartOpen, active: transitioning, toggle, play } = camera
  const [bartInputOpen, setBartInputOpen] = useState(false)
  const [loop, setLoop] = useState(false)
  const [view, setView] = useState<OverviewView>('default')
  const [notice, setNotice] = useState('')

  const agentThreads = useRendererState((state) => state.agentThreads)
  const reports = useRendererState((state) => state.reports)
  const settings = useRendererState((state) => state.settings)
  const threadInputs = useMemo(() => agentThreads.map((thread) => ({
    thread, displayPolicy: { hideInterventions: settings.bart.autoIntervention }
  })), [agentThreads, settings.bart.autoIntervention])

  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('preset', 'eye-dive')
    url.searchParams.set('reaction', BART_REACTION.id)
    url.searchParams.set('dur', String(duration))
    url.searchParams.delete('ease')
    history.replaceState(null, '', url)
  }, [duration])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing) return
      // 与生产同源的两条守卫：输入法组合中不触发；焦点落在输入控件里时 ⌘B 不抢键。
      const target = event.target
      const inEditable = target instanceof HTMLElement
        && Boolean(target.closest('input, textarea, select, [contenteditable]'))
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'b') {
        if (inEditable) return
        event.preventDefault()
        toggle()
        return
      }
      if (event.key === 'Escape' && (bartOpen || transitioning)) {
        if (inEditable) return
        event.preventDefault()
        play(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bartOpen, transitioning, toggle, play])

  useEffect(() => {
    if (!loop || transitioning) return
    const timer = window.setTimeout(toggle, 1000)
    return () => window.clearTimeout(timer)
  }, [loop, bartOpen, transitioning, toggle])

  const record = useCallback((action: string): void => setNotice(action), [])
  const respond = useCallback(async (): Promise<undefined> => undefined, [])

  return <div className="pg-stage" ref={camera.stageRef} data-camera-active={transitioning || undefined} data-camera-inside={bartOpen || undefined}>
      <AppShell
        className={'app-shell ' + (bartOpen && !transitioning ? 'bart-thread-active' : 'thread-overview-active')}
        data-pg-preset="eye-dive"
        data-pg-reaction={BART_REACTION.id}
      >
        <main className="app-workspace">
          <div className="pg-session-layer" data-bart-camera-session inert={!bartOpen || transitioning} aria-hidden={!bartOpen || transitioning}>
            <SubscribedBartThreadView
              composer={composer}
              error=""
              execution={null}
              onBack={() => play(false)}
              onCancel={async () => record('记录停止 Bart 请求')}
              onChooseFiles={() => record('记录选择文件')}
              onClear={() => record('记录清空 Bart session')}
              onPasteFiles={() => record('记录粘贴文件')}
              onRemoveAttachment={composer.removeAttachment}
              onSettings={() => record('记录打开设置')}
              onSubmit={() => record('记录发送 Bart 消息')}
              respond={respond}
              threadId={BART_THREAD_ID}
            />
          </div>
          <div className="pg-overview-layer" data-bart-camera-overview inert={bartOpen || transitioning} aria-hidden={bartOpen || transitioning}>
            <SubscribedConversationOverview
              orchestration={orchestration}
              embedded={false}
              initialLayoutContext={orchestration.getState().layoutContext}
              interrupt={async () => record('记录停止 Thread')}
              motionSceneKey={MOTION_SCENE_KEY}
              onGenerationMotionQueued={orchestration.enqueue}
              onLayoutContextChange={orchestration.setLayoutContext}
              onLayoutRevisionsConsumed={orchestration.consumeRevisions}
              onDeletePlaceholdersConsumed={orchestration.clearDeletedIndexes}
              onOpenReport={(id) => record(`记录打开报告 ${id}`)}
              onSelect={(id) => record(`记录打开 ${id}（playground 只演示 Bart 入口）`)}
              onSettings={() => record('记录打开设置')}
              reportRelationThreads={threadInputs}
              reports={reports}
              respond={respond}
              threads={threadInputs}
              transitionId={null}
              view={view}
              onViewChange={setView}
            />
          </div>
        </main>

        <div className="pg-dock-layer" data-bart-camera-dock inert={bartOpen || transitioning} aria-hidden={bartOpen || transitioning}>
        <SubscribedBartDock
          composer={composer}
          inputDisabled={false}
          inputOpen={bartInputOpen}
          onChooseFiles={() => record('记录选择文件')}
          onInputOpenChange={setBartInputOpen}
          onInteractionResponse={async () => record('记录回应 Dock 交互')}
          onPasteFiles={() => record('记录粘贴文件')}
          onRemoveBartAttachment={composer.removeAttachment}
          onSubmit={() => record('记录发送 Bart 消息')}
          onThreadOpenChange={play}
          passiveVisible={!bartOpen || camera.busy}
          presentationCovered={bartOpen || camera.active}
          running={false}
          threadOpen={bartOpen && !camera.busy}
        />
        </div>
      </AppShell>


      <aside className="pg-panel" aria-label="镜头实验控制台" data-collapsed={panelCollapsed || undefined}>
        <header className="pg-panel-head">
          <div><span className="pg-eyebrow">OVERVIEW → BART</span><strong>穿过眼睛 <span className="pg-locked">已锁定</span></strong></div>
          <button className="pg-collapse" type="button" aria-expanded={!panelCollapsed} onClick={() => setPanelCollapsed(!panelCollapsed)}>{panelCollapsed ? '展开' : '收起'}</button>
        </header>
        <span className="pg-flight" data-on={transitioning || undefined}>{camera.preparing ? '准备画面' : transitioning ? '镜头移动中' : bartOpen ? '内部' : '俯瞰'} · {BART_REACTION.label}</span>
        <p className="pg-reaction">01 · {BART_REACTION.label}<span className="pg-locked">已锁定</span></p>
        <p className="pg-passage">{BART_REACTION.passage}</p>
        <label className="pg-field">
          <span>时长 <output>{duration} ms</output></span>
          <input aria-label="时长" max={1800} min={600} step={50} type="range" value={duration}
            onChange={(event) => setDuration(Number(event.target.value))} />
        </label>
        <div className="pg-actions" role="group" aria-label="播放镜头">
          <button type="button" disabled={bartOpen && !transitioning} onClick={() => play(true)}>进入 Bart ↗</button>
          <button type="button" disabled={!bartOpen && !transitioning} onClick={() => play(false)}>↙ 返回俯瞰</button>
        </div>
        <div className="pg-transport">
          <button type="button" onClick={() => { camera.reset(); setLoop(false) }}>回到起点</button>
        </div>
        <div className="pg-options">
          <label className="pg-loop"><input checked={slow} type="checkbox" onChange={(event) => setSlow(event.target.checked)} />⅓ 慢速</label>
          <label className="pg-loop"><input checked={loop} type="checkbox" onChange={(event) => setLoop(event.target.checked)} />自动往返</label>
        </div>
        {camera.error ? <output className="pg-notice" role="alert">{camera.error}</output> : null}
        {notice ? <output className="pg-notice" aria-live="polite">{notice}</output> : null}
        <footer className="pg-hint">完整 Worker 演出 · ⌘/Ctrl B 切换 · Esc 返回</footer>
      </aside>
    </div>
}
