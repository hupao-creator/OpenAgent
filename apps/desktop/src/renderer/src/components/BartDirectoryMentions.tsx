import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Folder } from 'lucide-react'
import { useI18n } from '@openagent/plugin-kit/renderer'
import type { KnownDirectory } from '../../../shared/known-directory'
import { directoryMentionQuery, type MentionQuery } from '../directory-mentions'
import './BartDirectoryMentions.css'

export interface BartDirectoryMentionProps {
  loadMentionDirectories?: () => Promise<readonly KnownDirectory[]>
  onMentionSelect?: (query: MentionQuery, directory: KnownDirectory) => number | undefined
}

/** Only the Dock's main input opts into this behavior. */
export function useBartDirectoryMentions(props: BartDirectoryMentionProps & {
  enabled: boolean
  value: string
  input: RefObject<HTMLTextAreaElement | null>
}) {
  const { t } = useI18n()
  const id = useId()
  const [directories, setDirectories] = useState<readonly KnownDirectory[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [focused, setFocused] = useState(false)
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const [dismissed, setDismissed] = useState<string>()
  const [limitRejectedKey, setLimitRejectedKey] = useState<string>()
  const [active, setActive] = useState({ key: '', index: 0 })
  useEffect(() => {
    if (!props.enabled || !props.loadMentionDirectories) return
    let cancelled = false
    setStatus('loading')
    void props.loadMentionDirectories().then(items => {
      if (cancelled) return
      setDirectories(items); setStatus('ready')
    }, () => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [props.enabled, props.loadMentionDirectories])
  const query = directoryMentionQuery(props.value, selection.start, selection.end)
  const key = JSON.stringify([props.value, selection.start, selection.end])
  const open = Boolean(props.enabled && props.onMentionSelect && focused && !composing && query && dismissed !== key)
  const needle = query?.query.toLocaleLowerCase() ?? ''
  const filtered = useMemo(() => directories.filter(item => item.path.toLocaleLowerCase().includes(needle) || item.name.toLocaleLowerCase().includes(needle)), [directories, needle])
  const limitRejected = limitRejectedKey === key
  const matches = useMemo(() => limitRejected ? [] : filtered.slice(0, 50), [filtered, limitRejected])
  const index = Math.min(active.key === key ? active.index : 0, Math.max(0, matches.length - 1))
  const syncSelection = () => {
    const input = props.input.current
    if (input) setSelection({ start: input.selectionStart, end: input.selectionEnd })
  }
  const choose = (directory: KnownDirectory) => {
    if (!query || !props.onMentionSelect) return
    const caret = props.onMentionSelect(query, directory)
    if (caret === undefined) { setLimitRejectedKey(key); return }
    setDismissed(key)
    requestAnimationFrame(() => {
      props.input.current?.focus()
      props.input.current?.setSelectionRange(caret, caret)
      syncSelection()
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) return true
    if (!open) return false
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setDismissed(key); return true
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive({ key, index: matches.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0 })
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      // An empty/loading menu must not turn a selection attempt into a send.
      if (event.key === 'Enter' || matches.length) event.preventDefault()
      if (matches[index]) choose(matches[index])
      return true
    }
    return false
  }
  return {
    syncSelection,
    onKeyDown,
    fieldProps: {
      role: 'combobox' as const,
      'aria-autocomplete': 'list' as const,
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      'aria-activedescendant': open && matches[index] ? `${id}-${index}` : undefined,
      onSelect: syncSelection,
      onFocus: () => { setFocused(true); setDismissed(undefined); syncSelection() },
      onBlur: () => setFocused(false),
      onCompositionStart: () => { composingRef.current = true; setComposing(true) },
      onCompositionEnd: () => { composingRef.current = false; setComposing(false); syncSelection() }
    },
    menu: open ? <DirectoryMenu id={id} input={props.input} directories={matches} active={index} onChoose={choose}
      empty={limitRejected ? t('每条消息最多引用 50 个目录') : status === 'loading' ? t('正在查找目录…') : status === 'error' ? t('读取目录失败，请重新打开输入框重试') : t('没有匹配的目录')}
      label={t('已知目录')} more={!limitRejected && filtered.length > matches.length ? t('仅显示前 50 项，继续输入以缩小范围') : undefined} /> : null
  }
}

function DirectoryMenu(props: {
  id: string
  input: RefObject<HTMLTextAreaElement | null>
  directories: readonly KnownDirectory[]
  active: number
  onChoose: (directory: KnownDirectory) => void
  empty: string
  label: string
  more?: string
}) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 8, top: 8, width: 320, maxHeight: 260 })
  useLayoutEffect(() => {
    let frame: number
    const update = () => {
      const rect = props.input.current?.getBoundingClientRect()
      if (rect) {
        const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 16)
        const above = rect.top - 16, below = window.innerHeight - rect.bottom - 16
        const placeAbove = above > below
        const maxHeight = Math.max(0, Math.min(260, placeAbove ? above : below))
        const height = Math.min(menu.current?.scrollHeight ?? maxHeight, maxHeight)
        const next = {
          left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
          top: placeAbove ? Math.max(8, rect.top - height - 8) : rect.bottom + 8,
          width, maxHeight
        }
        setPosition(current => Object.keys(next).every(key => current[key as keyof typeof current] === next[key as keyof typeof next]) ? current : next)
      }
      frame = requestAnimationFrame(update)
    }
    update()
    return () => cancelAnimationFrame(frame)
  }, [props.input])
  useEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [props.active, props.directories])
  return createPortal(<div ref={menu} id={props.id} role="listbox" aria-label={props.label}
    className="bart-directory-mentions" style={position} onPointerDown={event => event.preventDefault()}>
    {props.directories.length ? props.directories.map((directory, index) =>
      <div key={directory.path} id={`${props.id}-${index}`} role="option" aria-selected={index === props.active}
        className="bart-directory-option" onMouseDown={event => event.preventDefault()} onClick={() => props.onChoose(directory)}>
        <Folder size={17} aria-hidden="true" />
        <span><strong>{directory.name}</strong><small>{directory.path}</small></span>
      </div>) : <div className="bart-directory-empty" role="status">{props.empty}</div>}
    {props.more ? <div className="bart-directory-empty" role="status">{props.more}</div> : null}
  </div>, document.body)
}
