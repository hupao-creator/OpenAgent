import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { ArrowLeft, Circle, RotateCcw, SlidersHorizontal, Trash2 } from 'lucide-react'
import {
  harnessDisplayName,
  HARNESS_IDS,
  harnessSupportsBartHost,
  isHarnessId,
  type HarnessId
} from '../../../shared/harnesses'
import type { HarnessInstallationMap, OpenAgentSettings } from '../../../shared/openagent-settings'
import {
  HarnessSettingsHost,
  harnessRendererTranslations,
  type HarnessPresentationResources
} from '../harness-composition'
import { useI18n } from '@openagent/plugin-kit/renderer'
import { AppI18nProvider } from '../i18n'
import { SettingsFormScope, SettingsGroup, SettingsRow, SettingsSelect, SettingsTextarea, SettingsToggle, SettingsNotice } from '@openagent/plugin-kit/renderer'
import { useSettingsPageTransition, type SettingsPagePhase } from './use-settings-page-transition'
import { invalidRoutingGuidance, useSettingsAutosave } from './use-settings-autosave'
import { LocalAgentsSettings } from './LocalAgentsSettings'
import { HarnessIconButton, type HarnessIconState } from './HarnessIconButton'
import { BartCoordinatorIdentity, type CoordinatorHandoff } from './BartCoordinatorIdentity'
import type { BartDispatchFeedback } from './use-bart-dispatch-feedback'
import { DispatchCanvas } from '../bart-motion/DispatchCanvas'
import type { DispatchDescription } from '../bart-motion/dispatch-canvas'
import './settings-page.css'

type SettingsSection = 'general' | 'bart'

const CORE_SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'bart',
  'general'
]

export interface HarnessSettingsPageProps {
  readonly activeHostHarnessId?: string
  /** The coordinator seat stays empty until the flying copy hands Bart over. */
  readonly bartInFlight?: boolean
  readonly defaultCwd: string
  readonly origin?: HTMLElement | null
  readonly originRect?: DOMRectReadOnly | null
  readonly open: boolean
  readonly value: OpenAgentSettings
  readonly resources: HarnessPresentationResources
  readonly loadHarnessInstallations: () => Promise<HarnessInstallationMap>
  readonly onClose: () => void
  /** Every page-transition phase, so the cross-page flight can follow the reveal. */
  readonly onPhaseChange?: (phase: SettingsPagePhase) => void
  readonly onSave: (settings: OpenAgentSettings) => Promise<void>
  /**
   * Reports a write that failed after the page was already closing, and hands
   * back the dismissal that takes that report down once the write it names
   * succeeds. The notice is one shared slot, so the app is the one that can say
   * which report is still up there: another operation may fail with the very
   * same text, and that failure is the one the reader still needs.
   */
  readonly onSaveError?: (message: string) => () => void
  readonly onClearHistory: () => Promise<void>
}

export function HarnessSettingsPage(
  props: HarnessSettingsPageProps
): React.JSX.Element | null {
  const autosave = useSettingsAutosave(props)
  const { draft } = autosave
  // This page stays mounted while its visible contents close and reopen.
  const [installations, setInstallations] = useState<HarnessInstallationMap>({})
  // The first probe has not answered yet, and every later one is a fresh window in
  // which the roster can still change: the discovery interval and the window's own
  // focus both re-probe long after the page has settled.
  const [probing, setProbing] = useState(true)
  const [section, setSection] = useState<SettingsSection>('bart')
  const fieldsRef = useRef<HTMLFieldSetElement>(null)
  const invalidField = (): HTMLElement | null =>
    fieldsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], :invalid') ??
    (invalidRoutingGuidance(draft)
      ? fieldsRef.current?.querySelector<HTMLElement>('[data-routing-guidance]') ?? null
      : null)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const [focusRequest, setFocusRequest] = useState(0)
  const [routingTouched, setRoutingTouched] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const revealingRef = useRef(false)
  // A write that failed after the page had closed reported itself on the
  // app-wide notice, because the page that knew the reason was gone. The
  // rejected draft stays here to be retried, and until it is, that notice is
  // the only remaining record of the failure: only this write's own success can
  // retire it, since nothing else knows the draft Main refused is the one it has
  // now accepted. What is kept is the app's own dismissal for that report, so a
  // replacement — even one that reads the same — is not this write's to clear.
  const reportedSaveError = useRef<(() => void) | null>(null)
  const [horizontalTabs, setHorizontalTabs] = useState(false)
  const transition = useSettingsPageTransition({ open: props.open, origin: props.origin, originRect: props.originRect, onClose: props.onClose })
  useLayoutEffect(() => {
    props.onPhaseChange?.(transition.phase)
  }, [props.onPhaseChange, transition.phase])
  const { t } = useI18n(draft.locale)
  const busy = clearing || transition.phase === 'closing'
  const settingsSections = CORE_SETTINGS_SECTIONS
  const activeSection = section
  const requestClose = (): void => {
    if (busy) return
    // A rejected close has to say why. The field that blocks it is the only
    // explanation the page has now that its status line is gone, and it may be
    // sitting on the tab the user is not looking at.
    const invalid = invalidField()
    if (invalid) {
      if (invalidRoutingGuidance(draft)) setRoutingTouched(true)
      const owner = invalid.closest<HTMLElement>('[data-section]')?.dataset.section
      if (owner === 'general' || owner === 'bart') {
        // Switching tabs normally returns the reader to the top of the new one;
        // here that would scroll the field being pointed at straight back out of
        // view, so this navigation keeps its position.
        if (owner !== section) revealingRef.current = true
        setSection(owner)
      }
      setFocusRequest(request => request + 1)
      return
    }
    if (autosave.composing.current) return
    // Leaving the page must not wait on a native round trip. Flushing here still
    // cancels the pending text debounce and starts the write before the
    // animation, so the draft survives. A write that fails once the page has
    // gone has only the app-wide notice left to report itself on.
    if (!autosave.settled) {
      void autosave.flush().then((saved) => {
        if (saved) return
        reportedSaveError.current = props.onSaveError?.(autosave.errorText.current) ?? null
      })
    }
    transition.close()
  }

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(max-width: 620px)')
    const update = (): void => setHorizontalTabs(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])

  useLayoutEffect(() => {
    if (!props.open) return
    setSection('bart')
    setClearing(false)
    setConfirmClear(false)
    setError('')
    setRoutingTouched(false)
    setFocusRequest(0)
  }, [props.open])

  useLayoutEffect(() => {
    if (focusRequest === 0) return
    const invalid = invalidField()
    invalid?.focus()
    invalid?.scrollIntoView?.({ block: 'center' })
  }, [focusRequest])

  // The notice sits above the fields, so a write that fails while the reader is
  // scrolled down to the field they just edited would report itself off-screen
  // and leave the retained draft looking saved.
  useEffect(() => {
    if (!(autosave.error || error)) return
    noticeRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [autosave.error, error])

  // The app-wide notice survives the page, so the write it names has to take it
  // down itself once Main accepts it. Only the report this page put there is
  // its to take down: another operation can fail in the meantime, and its
  // failure is the one the reader still needs to see.
  useEffect(() => {
    const dismiss = reportedSaveError.current
    if (dismiss === null || autosave.status !== 'saved') return
    reportedSaveError.current = null
    dismiss()
  }, [autosave.status, props.onSaveError])

  useLayoutEffect(() => {
    setConfirmClear(false)
    if (revealingRef.current) { revealingRef.current = false; return }
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [section])

  useEffect(() => {
    if (!props.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  if (!props.open) return null

  const clear = async (): Promise<void> => {
    if (busy) return
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setClearing(true)
    setError('')
    try {
      await props.onClearHistory()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setConfirmClear(false)
      setClearing(false)
    }
  }

  return (
    <AppI18nProvider
      locale={draft.locale}
      translations={harnessRendererTranslations}
    >
      <SettingsFormScope>
      <div className="settings-page" data-phase={transition.phase} ref={transition.rootRef}>
        <div className="settings-page-surface" ref={transition.surfaceRef} aria-hidden="true" />
        <section className="settings-page-content" aria-label={t('设置')} ref={transition.contentRef}>
          <aside className="settings-page-sidebar">
            <header className="settings-page-heading">
              <button aria-label={t('返回')} className="icon-button" disabled={busy}
                onClick={requestClose} ref={transition.returnRef} type="button"><ArrowLeft size={17} /></button>
              <h1>{t('设置')}</h1>
            </header>
          <nav
            aria-label={t('设置分类')}
            aria-orientation={horizontalTabs ? 'horizontal' : 'vertical'}
            className="settings-page-tabs"
            role="tablist"
          >
            {settingsSections.map((id, index) => (
              <div key={id}>
              <SettingsNavButton
                active={activeSection === id}
                id={id}
                index={index}
                key={id}
                label={id === 'general' ? t('通用') : 'Bart'}
                sections={settingsSections}
                onChange={setSection}
              />
              </div>
            ))}
          </nav>
          </aside>
          <div className="settings-page-main">
            <header className="settings-page-title">
              <h2>{activeSection === 'general' ? t('通用') : 'Bart'}</h2>
            </header>
          <div
            aria-labelledby={`settings-tab-${activeSection}`}
            className="settings-page-body"
            id="settings-panel"
            ref={bodyRef}
            role="tabpanel"
          >
            <div className="settings-page-form">
            {(autosave.error || error) && <div ref={noticeRef}>
              <SettingsNotice tone="error" action={autosave.error
                ? <button className="text-button" disabled={busy} onClick={autosave.retry} type="button">
                    {t('重试保存')}
                  </button>
                : undefined}>
                {autosave.error || error}
              </SettingsNotice>
            </div>}
            <fieldset className="settings-page-fields" disabled={busy} ref={fieldsRef} {...autosave.fieldEvents}>
            <div data-section="general" hidden={activeSection !== 'general'}>
              <GeneralSettings
                defaultCwd={props.defaultCwd}
                installations={installations}
                onInstallationsChange={setInstallations}
                onProbeStateChange={setProbing}
                loadHarnessInstallations={props.loadHarnessInstallations}
                resources={props.resources}
                value={draft}
                onChange={autosave.change}
                onClear={() => void clear()}
                onCancelClear={() => setConfirmClear(false)}
                clearPending={clearing}
                confirmClear={confirmClear}
                disabled={autosave.status === 'saving' || autosave.status === 'pending'}
              />
            </div>
            <div data-section="bart" hidden={activeSection !== 'bart'}>
              <BartSettings
                activeHostHarnessId={props.activeHostHarnessId}
                bartInFlight={props.bartInFlight}
                defaultCwd={props.defaultCwd}
                installations={installations}
                probing={probing}
                resources={props.resources}
                value={draft}
                onChange={autosave.change}
                routingTouched={routingTouched}
                onRoutingTouchedChange={setRoutingTouched}
              />
            </div>
            </fieldset>
            </div>
          </div>
          </div>
        </section>
      </div>
      </SettingsFormScope>
    </AppI18nProvider>
  )
}

function SettingsNavButton(props: {
  readonly active: boolean
  readonly id: SettingsSection
  readonly index: number
  readonly sections: readonly SettingsSection[]
  readonly label: string
  readonly onChange: (section: SettingsSection) => void
}): React.JSX.Element {
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    let nextIndex: number | undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIndex = (props.index + 1) % props.sections.length
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIndex = (props.index - 1 + props.sections.length) % props.sections.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = props.sections.length - 1
    }
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = props.sections[nextIndex]
    props.onChange(next)
    event.currentTarget.ownerDocument.getElementById(`settings-tab-${next}`)?.focus()
  }

  return (
    <button
      aria-controls="settings-panel"
      aria-selected={props.active}
      className={`settings-tab${props.active ? ' active' : ''}`}
      id={`settings-tab-${props.id}`}
      onClick={() => props.onChange(props.id)}
      onKeyDown={onKeyDown}
      role="tab"
      tabIndex={props.active ? 0 : -1}
      type="button"
    >
      <span className="settings-tab-icon"><SettingsTabIcon id={props.id} /></span>
      <span className="settings-tab-label">{props.label}</span>
    </button>
  )
}

function SettingsTabIcon({ id }: { readonly id: SettingsSection }): React.JSX.Element {
  if (id === 'general') return <SlidersHorizontal size={14} aria-hidden="true" />
  return <Circle size={9} fill="currentColor" aria-hidden="true" />
}

function GeneralSettings(props: {
  readonly installations: HarnessInstallationMap
  readonly onInstallationsChange: (value: HarnessInstallationMap) => void
  readonly defaultCwd: string
  readonly loadHarnessInstallations: () => Promise<HarnessInstallationMap>
  readonly onProbeStateChange: (probing: boolean) => void
  readonly resources: HarnessPresentationResources
  readonly value: OpenAgentSettings
  readonly clearPending: boolean
  readonly confirmClear: boolean
  readonly disabled: boolean
  readonly onChange: (settings: OpenAgentSettings) => void
  readonly onClear: () => void
  readonly onCancelClear: () => void
}): React.JSX.Element {
  const { t } = useI18n(props.value.locale)
  return (
    <div>
      <SettingsGroup title={t('界面偏好')}>
        <SettingsRow label={t('外观')}>
          <SettingsSelect value={props.value.appearance} onChange={(event) => props.onChange({
            ...props.value, appearance: event.currentTarget.value as OpenAgentSettings['appearance']
          })}>
            <option value="system">{t('跟随系统')}</option>
            <option value="light">{t('浅色')}</option>
            <option value="dark">{t('深色')}</option>
          </SettingsSelect>
        </SettingsRow>
        <SettingsRow label={t('界面语言')}>
          <SettingsSelect value={props.value.locale} onChange={(event) => props.onChange({
            ...props.value, locale: event.currentTarget.value as OpenAgentSettings['locale']
          })}>
            <option value="zh-CN">{t('简体中文')}</option><option value="en-US">{t('英语')}</option>
          </SettingsSelect>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t('本地 Agent')}>
        <LocalAgentsSettings installations={props.installations} onInstallationsChange={props.onInstallationsChange}
          onProbeStateChange={props.onProbeStateChange}
          defaultCwd={props.defaultCwd} resources={props.resources}
          value={props.value} onChange={props.onChange} load={props.loadHarnessInstallations} />
      </SettingsGroup>
      <SettingsGroup title={t('清空历史数据')} description={t('删除本机保存的 thread、报告和 Bart session。')}>
        <div className="settings-page-danger">
          <div className="settings-danger-actions">
            {props.confirmClear && !props.clearPending && <button className="text-button" disabled={props.disabled}
              onClick={props.onCancelClear} type="button">{t('取消清空')}</button>}
            <button className={`danger-button${props.confirmClear ? ' confirming' : ''}`}
              disabled={props.clearPending || props.disabled} onClick={props.onClear} type="button">
              {props.clearPending ? <RotateCcw className="spin" size={14} /> : <Trash2 size={14} />}
              {props.clearPending ? t('清空中…') : props.confirmClear ? t('确认永久删除') : t('清空全部历史数据')}
            </button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

function BartSettings(props: {
  readonly activeHostHarnessId?: string
  readonly bartInFlight?: boolean
  readonly defaultCwd: string
  readonly installations: HarnessInstallationMap
  readonly probing: boolean
  readonly resources: HarnessPresentationResources
  readonly value: OpenAgentSettings
  readonly onChange: (settings: OpenAgentSettings) => void
  readonly routingTouched: boolean
  readonly onRoutingTouchedChange: (touched: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n(props.value.locale)
  const hostGroupId = useId()
  const dispatchGroupId = useId()
  const hostRowRef = useRef<HTMLDivElement>(null)
  const [hostHandoff, setHostHandoff] = useState<CoordinatorHandoff | null>(null)
  const [dispatchFeedback, setDispatchFeedback] = useState<BartDispatchFeedback | null>(null)
  const changeBart = (
    change: Partial<OpenAgentSettings['bart']>
  ): void => props.onChange({
    ...props.value,
    bart: { ...props.value.bart, ...change }
  })

  const toggleTarget = (harnessId: HarnessId): void => {
    const selected = props.value.bart.targetHarnessIds.includes(harnessId)
    const next = selected
      ? props.value.bart.targetHarnessIds.filter((id) => id !== harnessId)
      : [...props.value.bart.targetHarnessIds, harnessId]
    if (!next.length) return
    const map = hostRowRef.current?.parentElement
    const target = map?.querySelector(`[data-row="dispatch"] [data-agent="${harnessId}"]`)?.getBoundingClientRect()
    const bart = map?.querySelector('[data-bart-coordinator]')?.getBoundingClientRect()
    const deltaX = target && bart ? target.left + target.width / 2 - bart.left - bart.width / 2 : 0
    setDispatchFeedback(previous => ({
      sequence: (previous?.sequence ?? 0) + 1,
      harnessId,
      enabled: !selected,
      gazeX: Math.max(-32, Math.min(32, deltaX / 4))
    }))
    changeBart({ targetHarnessIds: next })
  }
  // A Harness that is not on this machine can neither coordinate nor receive a
  // dispatched thread, so the picker drops it instead of offering a dead choice.
  // Installing stays where the click already means it: 本地 Agent. `checking` and
  // `installing` stay pickable because they settle into a usable Agent shortly
  // and hiding them would flash empty rows on every open, but a probe that
  // failed is no more a working choice than a missing binary.
  // The flight lands on the roster already on screen. Background probes keep
  // running, but their layout changes wait for this short presentation to end.
  const presentedInstallations = useRef(props.installations)
  if (!props.bartInFlight) presentedInstallations.current = props.installations
  const installed = (id: HarnessId): boolean => {
    const status = presentedInstallations.current[id]?.status ?? 'checking'
    return status !== 'missing' && status !== 'error'
  }
  const pickable = HARNESS_IDS.filter(installed)
  const selectedHostHarnessId = props.value.bart.hostHarnessPreference === 'auto'
    ? props.activeHostHarnessId
    : props.value.bart.hostHarnessPreference
  // A saved coordinator that is no longer on this machine has to read as
  // unavailable; otherwise its editor stays on a page that shows no checked
  // Agent, and the next Bart start fails against a host the user cannot see.
  const hostHarnessId = selectedHostHarnessId && isHarnessId(selectedHostHarnessId) && installed(selectedHostHarnessId)
    ? selectedHostHarnessId
    : undefined
  const hostOptions = pickable.filter(harnessSupportsBartHost)
  const hostPosition = (id: HarnessId): number => (pickable.indexOf(id) + .5) / pickable.length * 100
  // The roster the seat is placed against is provisional until the probe answers:
  // an unknown status reads as installed, so an unanswered probe lays the seat out
  // across every Harness and slides it once the missing ones drop out. A flight
  // that is already on its way has to know the difference between a seat that has
  // stopped and one that has not moved yet — and the seat only counts as final
  // once no probe is out, because a roster the last one answered completely is
  // exactly what the next one is about to contradict.
  const rosterPending = props.probing ||
    HARNESS_IDS.some((id) => props.installations[id]?.status === undefined)
  // A target that is no longer offered cannot be the one Bart is kept alive for,
  // so the last-selection guard counts only the rows the user can actually see.
  const selectedTargets = pickable.filter((id) => props.value.bart.targetHarnessIds.includes(id))
  // Only enabled options participate in arrow-key navigation and tab order.
  const tabbableHost = hostHarnessId && hostOptions.includes(hostHarnessId) ? hostHarnessId : hostOptions[0]
  const selectHost = (harnessId: HarnessId): void => {
    if (harnessId === hostHarnessId) return
    const row = hostRowRef.current
    const incoming = row?.querySelector(`[data-agent="${harnessId}"]`)?.getBoundingClientRect()
    const bart = row?.querySelector('.bart-coordinator-anchor')?.getBoundingClientRect()
    if (incoming && bart) {
      // The identity is enlarged 1.7×; express the flight inside its local space.
      setHostHandoff(previous => ({
        harnessId,
        sequence: (previous?.sequence ?? 0) + 1,
        fromX: (incoming.left + incoming.width / 2 - bart.left - bart.width / 2) / 1.7
      }))
    } else setHostHandoff(null)
    changeBart({ hostHarnessPreference: harnessId })
  }
  const hostStatusText = (state: HarnessIconState): string => {
    switch (state) {
      case 'checking': return t('正在检测…')
      case 'installed': return t('已安装')
      case 'missing': return t('未安装')
      case 'installing': return t('正在安装…')
      case 'error': return t('检测失败')
    }
  }
  const onHostKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const current = tabbableHost ? hostOptions.indexOf(tabbableHost) : -1
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? hostOptions.length - 1
        : (current + step + hostOptions.length) % hostOptions.length
    const nextHost = hostOptions[next]
    if (!nextHost) return
    selectHost(nextHost)
    event.currentTarget.ownerDocument.getElementById(`${hostGroupId}-${nextHost}`)?.focus()
  }

  return (
    <div className="bart-settings">
      <SettingsGroup>
        <SettingsRow htmlFor={hostGroupId} label={t('协调与派发')} layout="stacked"
          description={t('上方选择负责协调的 Agent，下方选择它可以派发任务的 Harness。')}>
          <DispatchMap hostHarnessId={hostHarnessId} targetHarnessIds={props.value.bart.targetHarnessIds}
            visibleHarnessIds={pickable}>
            <div aria-describedby={`${hostGroupId}-description`} aria-label={t('协调 Agent')}
              className="harness-icon-row" data-row="host" id={hostGroupId}
              onKeyDown={onHostKeyDown} ref={hostRowRef} role="radiogroup">
              {pickable.map((id) => {
                const supported = harnessSupportsBartHost(id)
                const state = props.installations[id]?.status ?? 'checking'
                const selected = hostHarnessId === id
                return <span className="harness-host-slot" key={id} style={{ transform: `translateX(${hostPosition(id)}%)` }}>
                  <HarnessIconButton harnessId={id} state={state}
                  aria-checked={selected}
                  aria-label={supported
                    ? `${harnessDisplayName(id)} · ${hostStatusText(state)}`
                    : `${harnessDisplayName(id)}${t('（不支持 Bart Host）')}`}
                  className={selected ? 'is-selected' : ''}
                  disabled={!supported || undefined}
                  id={`${hostGroupId}-${id}`}
                  onClick={() => selectHost(id)}
                  role="radio"
                  style={{ '--host-scale': selected ? 1.7 : 0.88 } as CSSProperties}
                  tabIndex={id === tabbableHost ? 0 : -1} />
                </span>
              })}
              {hostHarnessId && <BartCoordinatorIdentity harnessId={hostHarnessId} handoff={hostHandoff}
                inFlight={props.bartInFlight}
                position={hostPosition(hostHarnessId)} positionPending={rosterPending}
                dispatchFeedback={dispatchFeedback} />}
            </div>
            <div aria-describedby={`${hostGroupId}-description`} aria-label={t('可派发的线程')}
              className="harness-icon-row" data-row="dispatch" id={dispatchGroupId} role="group">
              {pickable.map((id) => {
                const state = props.installations[id]?.status ?? 'checking'
                const selected = props.value.bart.targetHarnessIds.includes(id)
                const lastSelected = selected && selectedTargets.length === 1
                return <HarnessIconButton key={id} harnessId={id} state={state}
                  aria-checked={selected}
                  aria-label={`${harnessDisplayName(id)} · ${hostStatusText(state)}`}
                  className={selected ? 'is-selected' : ''}
                  disabled={lastSelected || undefined}
                  onClick={() => toggleTarget(id)}
                  role="checkbox"
                  title={lastSelected ? t('至少保留一个可派发的 provider') : undefined} />
              })}
            </div>
          </DispatchMap>
        </SettingsRow>
      </SettingsGroup>
      {hostHarnessId && harnessSupportsBartHost(hostHarnessId)
        ? <HarnessSettingsHost key={hostHarnessId} section="thread" harnessId={hostHarnessId}
            cwd={props.defaultCwd} resources={props.resources} value={props.value} change={props.onChange} />
        : <SettingsNotice tone={selectedHostHarnessId ? 'error' : 'info'}>{selectedHostHarnessId
            ? t('当前 Bart provider 值不可用，请重新选择。')
            : t('当前值不可用，请选择')}</SettingsNotice>}
      <SettingsGroup>
        <SettingsRow label={t('自动审批与代答')}>
          <SettingsToggle checked={props.value.bart.autoIntervention}
            onChange={(event) => changeBart({ autoIntervention: event.currentTarget.checked })} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow label={t('自定义模型路由指导')}>
          <SettingsToggle checked={props.value.bart.routingGuidance !== null} onChange={(event) => {
            props.onRoutingTouchedChange(false)
            changeBart({ routingGuidance: event.currentTarget.checked ? '' : null })
          }} />
        </SettingsRow>
        {props.value.bart.routingGuidance !== null && <SettingsRow label={t('Bart 模型路由指导')} layout="stacked"
          error={props.routingTouched && invalidRoutingGuidance(props.value)
            ? t('请输入模型路由指导，或关闭自定义指导。') : undefined}>
          <SettingsTextarea data-routing-guidance maxLength={12_000} placeholder={t('输入 Bart 选择模型时应遵循的规则')}
            onBlur={() => props.onRoutingTouchedChange(true)}
            value={props.value.bart.routingGuidance} onChange={(event) => changeBart({ routingGuidance: event.currentTarget.value })} />
        </SettingsRow>}
      </SettingsGroup>
    </div>
  )
}

type Point = { readonly x: number; readonly y: number }

/**
 * Converts client-space points into the overlay SVG's own user space. Rects come
 * back already scaled by whatever transform an ancestor is applying — the page
 * opens by scaling this content — while the overlay draws in unscaled user
 * units, so a raw rect delta would be scaled a second time on the way out. The
 * SVG's screen matrix is that conversion, and in a layout-less environment,
 * where it does not exist, the two spaces coincide anyway.
 */
function svgUserSpace(svg: SVGSVGElement | null): (point: Point) => Point {
  const matrix = typeof svg?.getScreenCTM === 'function' ? svg.getScreenCTM()?.inverse() : null
  if (!matrix) return (point) => point
  return ({ x, y }) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  })
}

/**
 * Draws the live dispatch relationship between the coordinating Agent and every
 * enabled target. Connections follow Bart to the selected Harness's position.
 */
function DispatchMap(props: {
  readonly children: ReactNode
  readonly hostHarnessId: HarnessId | undefined
  readonly targetHarnessIds: readonly HarnessId[]
  readonly visibleHarnessIds: readonly HarnessId[]
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Rendered even while empty so the drawing has a matrix to convert through from
  // the very first frame rather than only once a link exists.
  const svgRef = useRef<SVGSVGElement>(null)
  const [links, setLinks] = useState<readonly { harnessId: string; path: string }[]>([])
  const [dispatch, setDispatch] = useState<DispatchDescription>({ source: { x: 0, y: 0 }, targets: [], color: '#718269' })
  const targets = props.targetHarnessIds.join(' ')
  // Detection can drop an icon while the configured ids stay put, which leaves
  // the container's own box unchanged and the ResizeObserver silent, so the
  // visible set is part of the trigger rather than only the saved ids.
  const visible = props.visibleHarnessIds.join(' ')

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = (): void => {
      const row = container.querySelector<HTMLElement>('[data-row="host"]')
      if (!row || !container.clientHeight || !props.hostHarnessId) {
        setLinks([])
        setDispatch(current => current.targets.length ? { ...current, targets: [] } : current)
        return
      }
      const toUserSpace = svgUserSpace(svgRef.current)
      const rowRect = row.getBoundingClientRect()
      const index = props.visibleHarnessIds.indexOf(props.hostHarnessId)
      const center = toUserSpace({ x: rowRect.left + rowRect.width * (index + .5) / props.visibleHarnessIds.length,
        y: rowRect.top + rowRect.height / 2 })
      // Anchor geometry is fixed at 48px × 1.7; its travel is prepared inside
      // the Worker. Ancestor page transforms carry the local canvas natively.
      const start = { x: center.x, y: center.y + 24 * 1.7 }
      const endpoints: Point[] = []
      const nextLinks = [...container.querySelectorAll<HTMLElement>('[data-row="dispatch"] [aria-checked="true"]')]
        .map((target) => {
          const to = target.getBoundingClientRect()
          const end = toUserSpace({ x: to.left + to.width / 2, y: to.top })
          endpoints.push(end)
          const bend = (end.y - start.y) * 0.55
          return {
            harnessId: target.dataset.agent || 'target',
            path: `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`
          }
        })
      setLinks(current => current.length === nextLinks.length && current.every((link, index) =>
        link.harnessId === nextLinks[index].harnessId && link.path === nextLinks[index].path)
        ? current : nextLinks)
      setDispatch({ source: start, targets: endpoints, color: getComputedStyle(svgRef.current!).color || '#718269' })
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(container)
    const appearance = new MutationObserver(measure)
    appearance.observe(document.documentElement, { attributes: true })
    return () => { observer?.disconnect(); appearance.disconnect() }

  }, [props.hostHarnessId, targets, visible])

  return <div className="harness-dispatch-map" ref={containerRef}>
    <svg aria-hidden="true" className="harness-dispatch-lines" ref={svgRef}>
      {links.map((link) => <path key={link.harnessId} className="harness-dispatch-line" d={link.path} />)}
    </svg>
    <DispatchCanvas description={dispatch} />
    {props.children}
  </div>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
