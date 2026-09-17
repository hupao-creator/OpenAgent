import { useLayoutEffect, useRef, useState } from 'react'
import type { OpenAgentSettings } from '../../../shared/openagent-settings'

const TEXT_DELAY = 500
const same = (a: OpenAgentSettings, b: OpenAgentSettings): boolean => JSON.stringify(a) === JSON.stringify(b)
export const invalidRoutingGuidance = (value: OpenAgentSettings): boolean =>
  value.bart.routingGuidance !== null && !value.bart.routingGuidance.trim()

/** Coordinates Renderer edits only; Main still validates, persists and applies settings. */
export function useSettingsAutosave(props: {
  open: boolean
  value: OpenAgentSettings
  onSave: (value: OpenAgentSettings) => Promise<void>
}) {
  const [draft, setDraft] = useState(props.value)
  const [status, setStatus] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setErrorState] = useState('')
  // A close that does not await the write still has to report its failure, and
  // the resolved promise carries no message of its own.
  const errorText = useRef('')
  const setError = (message: string): void => {
    errorText.current = message
    setErrorState(message)
  }
  const current = useRef(props.value)
  const committed = useRef(props.value)
  const ready = useRef(props.value)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const running = useRef<Promise<boolean> | null>(null)
  const composing = useRef(false)
  const textEvent = useRef(false)
  const failed = useRef(false)
  const latest = useRef(props)
  latest.current = props

  const cancelTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }

  useLayoutEffect(() => {
    if (props.open) {
      // Closing no longer waits for its write, so a reopen can catch one still
      // in flight or one that already failed. Both keep the pending snapshot as
      // the base: resetting to props.value would make the drain loop save a
      // value main has not accepted back over the change, and dropping the
      // failure would leave that attempt with nothing to correct or retry. The
      // notice therefore survives the reopen alongside the draft.
      if (running.current || failed.current) {
        setDraft(ready.current)
      } else {
        current.current = committed.current = ready.current = props.value
        setDraft(props.value)
        setStatus('idle')
        setError('')
      }
      composing.current = false
    }
    return cancelTimer
  }, [props.open])

  const drain = (): Promise<boolean> => {
    if (running.current) return running.current
    if (same(ready.current, committed.current)) {
      failed.current = false
      setError('')
      setStatus(timer.current !== null || composing.current ? 'pending' : 'saved')
      return Promise.resolve(true)
    }
    setStatus('saving')
    failed.current = false
    setError('')
    // Defer execution until the promise is registered, including synchronous throws.
    const operation = Promise.resolve().then(async () => {
      try {
        while (!same(ready.current, committed.current)) {
          const snapshot = ready.current
          await latest.current.onSave(snapshot)
          committed.current = snapshot
        }
        setStatus(timer.current !== null || composing.current ? 'pending' : 'saved')
        return true
      } catch (cause) {
        failed.current = true
        setError(cause instanceof Error ? cause.message : String(cause))
        setStatus('error')
        return false
      } finally {
        running.current = null
      }
    })
    running.current = operation
    return operation
  }

  const submit = (): Promise<boolean> => {
    cancelTimer()
    if (composing.current) return Promise.resolve(false)
    const next = current.current
    // A temporarily empty custom rule must not overwrite the last valid rule or
    // prevent unrelated choices from applying. Harness slices stay opaque here.
    ready.current = invalidRoutingGuidance(next)
      ? { ...next, bart: { ...next.bart, routingGuidance: ready.current.bart.routingGuidance } }
      : next
    return drain()
  }

  const schedule = (): void => {
    cancelTimer()
    if (!failed.current && !running.current) setStatus('pending')
    if (!composing.current) timer.current = setTimeout(() => { void submit() }, TEXT_DELAY)
  }

  const change = (next: OpenAgentSettings): void => {
    current.current = next
    setDraft(next)
    if (textEvent.current || composing.current) schedule()
    else void submit()
  }

  const flush = async (): Promise<boolean> => {
    const saved = await submit()
    return saved && !composing.current && !invalidRoutingGuidance(current.current) &&
      same(current.current, committed.current)
  }

  return {
    draft, status, error, errorText, change, flush,
    settled: !running.current && !failed.current && !composing.current && same(draft, committed.current),
    composing,
    retry: () => { void submit() },
    fieldEvents: {
      onChangeCapture: (event: React.FormEvent<HTMLElement>): void => {
        textEvent.current = isTextEditor(event.target)
        queueMicrotask(() => { textEvent.current = false })
      },
      onBlurCapture: (event: React.FocusEvent<HTMLElement>): void => {
        if (isTextEditor(event.target) && !composing.current) void submit()
      },
      onCompositionStartCapture: (): void => {
        composing.current = true
        cancelTimer()
      },
      onCompositionEndCapture: (): void => {
        composing.current = false
        schedule()
      }
    }
  }
}

function isTextEditor(target: EventTarget): boolean {
  return target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit'].includes(target.type))
}
