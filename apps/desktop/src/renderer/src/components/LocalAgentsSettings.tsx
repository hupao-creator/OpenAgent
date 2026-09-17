import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { HARNESS_IDS, harnessDisplayName, type HarnessId } from '../../../shared/harnesses'
import type { HarnessInstallationMap, OpenAgentSettings } from '../../../shared/openagent-settings'
import { HarnessSettingsHost, type HarnessPresentationResources } from '../harness-composition'
import { HarnessIconButton } from './HarnessIconButton'

export function LocalAgentsSettings(props: {
  readonly installations: HarnessInstallationMap
  readonly onInstallationsChange: (value: HarnessInstallationMap) => void
  readonly defaultCwd: string
  readonly resources: HarnessPresentationResources
  readonly value: OpenAgentSettings
  readonly onChange: (value: OpenAgentSettings) => void
  readonly load: () => Promise<HarnessInstallationMap>
  /** True from the moment a roster probe leaves until it answers, however it answers. */
  readonly onProbeStateChange?: (probing: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { installations } = props
  const [installing, setInstalling] = useState<Partial<Record<HarnessId, boolean>>>({})
  const [errors, setErrors] = useState<Partial<Record<HarnessId, string>>>({})
  const [active, setActive] = useState<HarnessId | null>(null)
  const [pinned, setPinned] = useState(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const root = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const pending = useRef<Promise<void> | null>(null)
  const detailRefreshes = useRef(new Map<HarnessId, { requested: boolean; promise: Promise<void> }>())
  // The one read a detail must not force is its very first: it has not answered
  // yet, so a second native boot would only re-ask a question already in flight.
  // Which read that is belongs to the detail rather than to the refresh
  // operation that happens to observe it — a settings change can start an
  // ordinary reload long after the first read settled, and a refresh arriving
  // while that one is in flight still has to be a refresh.
  const initialLoads = useRef(new Set<HarnessId>())
  const installs = useRef(new Set<HarnessId>())
  const latest = useRef(props)
  latest.current = props
  const detailId = useId()
  const activeResult = active ? installations[active] : undefined
  const activeStatus = activeResult?.status
  const activePath = activeResult?.status === 'installed' ? activeResult.executablePath : undefined

  const refresh = useCallback((): Promise<void> => {
    if (pending.current) return pending.current
    // The caller is told a probe is out rather than left to read it off the result:
    // a roster that still answers every Harness is indistinguishable from one that
    // has answered, so a flight measuring against the seat could not tell a place
    // that is final from one that is about to move.
    latest.current.onProbeStateChange?.(true)
    const operation = Promise.resolve().then(() => latest.current.load()).then((value) => {
      if (mounted.current) {
        latest.current.onInstallationsChange(value)
        setErrors(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => value[id]?.status !== 'installed')))
      }
    }, (cause) => {
      if (!mounted.current) return
      latest.current.onInstallationsChange(Object.fromEntries(HARNESS_IDS.map(id =>
        [id, { status: 'error', message: errorMessage(cause) }]
      )))
    }).finally(() => {
      pending.current = null
      // Only a live instance speaks for the flag. Closing the page unmounts this
      // component while its probe is still out — the page keeps the flag across that —
      // so a completion arriving afterwards would clear the flag out from under the
      // probe the reopened page has just started, and the seat would read as settled
      // while it is still waiting to move.
      if (mounted.current) latest.current.onProbeStateChange?.(false)
    })
    pending.current = operation
    return operation
  }, [])

  const refreshDetails = useCallback((id: HarnessId): Promise<void> => {
    const pendingRefresh = detailRefreshes.current.get(id)
    if (pendingRefresh) {
      pendingRefresh.requested = true
      return pendingRefresh.promise
    }
    const request = { requested: true, promise: Promise.resolve() }
    detailRefreshes.current.set(id, request)
    request.promise = Promise.resolve().then(async () => {
      while (mounted.current && request.requested) {
        const resource = latest.current.resources[id]
        // Calls received while waiting share this fresh request; changes during
        // the request itself need another pass once it finishes.
        request.requested = false
        if (!initialLoads.current.has(id) && resource?.status === 'loading') {
          await resource.reload()
          initialLoads.current.add(id)
          continue
        }
        initialLoads.current.add(id)
        // A settled answer may predate what this caller just learned about: the
        // CLI may have been installed, replaced or reconfigured at the same path
        // since that answer was taken, which is exactly what a cached entry
        // cannot tell apart. A caller that arrived during the wait is asking
        // about the same thing, and the marker above is what keeps that wait
        // from being read as one more first pass and sparing the refresh.
        await resource?.reload({ refresh: true })
      }
    }).finally(() => { detailRefreshes.current.delete(id) })
    return request.promise
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    const onReturn = (): void => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    const onFocus = (): void => {
      onReturn()
      // Coming back to a detail that stayed open is the same request as an
      // explicit refresh: the CLI may have changed while the window was away.
      if (activeRef.current) void refreshDetails(activeRef.current)
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onReturn)
    const timer = window.setInterval(onReturn, 15_000)
    return () => {
      mounted.current = false
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [refresh, refreshDetails])

  useEffect(() => {
    // An external install (or one started before reopening settings) must also
    // refresh the visible version/path when automatic discovery catches up.
    if (active) void refreshDetails(active)
  }, [active, activeStatus, activePath, refreshDetails])

  useEffect(() => {
    if (!active) return
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setActive(null)
        setPinned(false)
      }
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [active])

  const install = async (id: HarnessId): Promise<void> => {
    if (installs.current.has(id)) return
    installs.current.add(id)
    setInstalling(value => ({ ...value, [id]: true }))
    setErrors(value => ({ ...value, [id]: undefined }))
    setActive(id)
    setPinned(true)
    try {
      await window.openAgent.installHarness(id)
      // A probe started before install completion must settle before the new one.
      await pending.current
      await refresh()
      if (mounted.current) void refreshDetails(id)
    } catch (cause) {
      if (mounted.current) setErrors(value => ({ ...value, [id]: errorMessage(cause) }))
    } finally {
      installs.current.delete(id)
      if (mounted.current) {
        setInstalling(value => ({ ...value, [id]: false }))
        void refresh()
      }
    }
  }

  const stateFor = (id: HarnessId): 'checking' | 'installed' | 'missing' | 'installing' | 'error' => {
    if (installing[id] || installations[id]?.status === 'installing') return 'installing'
    if (errors[id]) return 'error'
    return installations[id]?.status ?? 'checking'
  }
  const statusText = (id: HarnessId): string => {
    switch (stateFor(id)) {
      case 'checking': return t('正在检测…')
      case 'installed': return t('已安装')
      case 'missing': return t('未安装 · 点击安装')
      case 'installing': return t('正在安装…')
      case 'error': return errors[id] ? t('安装失败 · 点击重试') : t('检测失败 · 将自动重试')
    }
  }
  const activeState = active ? stateFor(active) : undefined
  const activeError = active ? errors[active] || (activeResult?.status === 'error' ? activeResult.message : '') : ''

  return <div className="local-agents" ref={root}
    onMouseLeave={() => {
      if (!pinned && !root.current?.contains(document.activeElement)) setActive(null)
    }}
    onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        setActive(null)
        setPinned(false)
      }
    }}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && active) {
        event.preventDefault()
        event.stopPropagation()
        root.current?.querySelector<HTMLButtonElement>(`[data-agent="${active}"]`)?.focus()
        setActive(null)
        setPinned(false)
      }
    }}>
    <div className="harness-icon-row" role="group" aria-label={t('本地 Agent')}>
      {HARNESS_IDS.map(id => {
        const state = stateFor(id)
        const busy = state === 'checking' || state === 'installing'
        const canInstall = state === 'missing' || Boolean(errors[id])
        return <HarnessIconButton key={id} harnessId={id} state={state} showStatus
          className={active === id ? 'is-active' : ''}
          aria-label={`${harnessDisplayName(id)} · ${statusText(id)}`}
          aria-expanded={active === id} aria-controls={active === id ? detailId : undefined}
          aria-haspopup="dialog" aria-disabled={busy || undefined}
          onMouseEnter={() => { if (!pinned) setActive(id) }}
          onFocus={() => setActive(id)}
          onClick={(event) => {
            if (busy) return
            if (canInstall) { void install(id); return }
            if (event.detail === 0) {
              setActive(id)
              setPinned(true)
              requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('.local-agent-detail input')?.focus())
              return
            }
            setActive(active === id && pinned ? null : id)
            setPinned(!(active === id && pinned))
          }} />
      })}
    </div>
    <span className="local-agent-live" role="status" aria-live="polite">
      {HARNESS_IDS.map(id => `${harnessDisplayName(id)}: ${statusText(id)}`).join('；')}
    </span>
    {active && <div className="local-agent-detail" id={detailId} role="dialog"
      aria-label={harnessDisplayName(active)}>
      <div className="local-agent-detail-surface">
        <header><strong>{harnessDisplayName(active)}</strong><span data-state={activeState}>{statusText(active)}</span></header>
        {activeState === 'missing' && <p>{t('点击图标即可安装，完成后自动检测。')}</p>}
        {activeState === 'installing' && <p>{t('正在下载并安装，你可以继续使用其他功能。')}</p>}
        {activeError && <p className="local-agent-error" role="alert">{activeError}</p>}
        {(activeState === 'installed' || (activeState === 'error' && !errors[active])) && <HarnessSettingsHost
          section="cli" harnessId={active} cwd={props.defaultCwd}
          resources={props.resources} value={props.value} change={props.onChange} />}
      </div>
    </div>}
  </div>
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
