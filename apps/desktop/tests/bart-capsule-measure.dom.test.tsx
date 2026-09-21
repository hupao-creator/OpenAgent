// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BartDock } from '../src/renderer/src/components/BartDock'
import type { BartDraftAttachment } from '../src/shared/attachments'

// The capsule's height comes from measuring the draft field, and the field is
// measured again when its width changes because that is what re-wraps the text.
// jsdom has no layout, so the wrap is simulated: by default the field reports
// the height its current text would occupy — one row per line, capped like the
// capsule — and a test that is about re-wrapping pins it instead.
let fieldHeight: number | null = null
let observers: Array<{ targets: Element[]; notify: (width: number) => void }> = []

beforeEach(() => {
  observers = []
  fieldHeight = null
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      if (fieldHeight !== null) return fieldHeight
      const lines = Math.min(5, Math.max(1, this.value.split('\n').length))
      return lines * 20 + 26
    }
  })
  vi.stubGlobal('ResizeObserver', class {
    private readonly callback: ResizeObserverCallback
    readonly targets: Element[] = []
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      observers.push(this)
    }
    observe(target: Element): void { this.targets.push(target) }
    unobserve(): void {}
    disconnect(): void { this.targets.length = 0 }
    notify(width: number): void {
      this.callback(this.targets.map((target) => ({ target, contentRect: { width } })) as unknown as ResizeObserverEntry[],
        this as unknown as ResizeObserver)
    }
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (HTMLTextAreaElement.prototype as unknown as Record<string, unknown>).scrollHeight
  delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).offsetHeight
  delete (HTMLDivElement.prototype as unknown as Record<string, unknown>).clientHeight
})

/**
 * jsdom has no scrollbars, so the platform is simulated on the strip itself: an
 * element that draws one is a box taller than the part of it that is visible.
 */
function withScrollbarGutter(gutter: number): void {
  const isStrip = (node: HTMLElement): boolean => String(node.className).includes('bart-dock-attachment-strip')
  Object.defineProperty(HTMLDivElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) { return isStrip(this) ? 39 + gutter : 0 }
  })
  Object.defineProperty(HTMLDivElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return isStrip(this) ? 39 : 0 }
  })
}

const PENDING_ATTACHMENT = [
  { id: 'a1', status: 'pending', name: '笔记.md', size: 1024, mimeType: 'text/markdown' }
] as const

const noop = (): void => {}

function renderDock(inputValue: string, attachments: readonly BartDraftAttachment[] = []): HTMLElement {
  const view = render(
    <BartDock
      activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
      threadOpen={false} sessionIdle
      inputOpen inputValue={inputValue} bartAttachments={attachments}
      foregroundActivity={undefined} running={false}
      onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
      onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
    />
  )
  return view.container
}

// The Dock publishes the field measurement for the independent capsule.
function capsuleHeight(container: HTMLElement): string {
  return dockProperty(container, '--bart-dock-capsule-height')
}

// The attachment row is the one part of the capsule with no field to measure, so
// it is published on its own for the same reason.
function attachmentHeight(container: HTMLElement): string {
  return dockProperty(container, '--bart-dock-capsule-attachment-height')
}

function dockProperty(container: HTMLElement, property: string): string {
  const dock = container.querySelector<HTMLElement>('.bart-dock')
  if (!dock) throw new Error('the Dock is not rendered')
  return dock.style.getPropertyValue(property)
}

/** The observer watching the draft field, as opposed to any of the canvases. */
function widthObserver(container: HTMLElement): { targets: Element[]; notify: (width: number) => void } {
  const field = container.querySelector('textarea')
  const observer = observers.find((candidate) => candidate.targets.includes(field as Element))
  if (!observer) throw new Error('no ResizeObserver was registered for the field')
  return observer
}

describe('capsule measurement', () => {
  it('writes the measured draft height to the capsule property', () => {
    fieldHeight = 20 * 3 + 26
    const container = renderDock('一\n二\n三')
    expect(capsuleHeight(container)).toBe('86px')
  })

  it('remeasures when the field gets narrower, without the draft changing', () => {
    fieldHeight = 20 + 26
    const container = renderDock('一段会在窄栏里折行的文字')
    expect(capsuleHeight(container)).toBe('46px')
    const observer = widthObserver(container)

    // The same draft, wrapped to three rows because the Dock narrowed.
    fieldHeight = 20 * 3 + 26
    act(() => observer.notify(240))
    expect(capsuleHeight(container)).toBe('86px')
  })

  it('ignores height-only changes so the measurement cannot feed back into itself', () => {
    fieldHeight = 20 * 2 + 26
    const container = renderDock('一\n二')
    const observer = widthObserver(container)
    act(() => observer.notify(240))
    const settled = capsuleHeight(container)

    // Writing the capsule height resizes the field; that resize reports the same
    // width and must not be treated as a re-wrap.
    fieldHeight = 20 * 5 + 26
    act(() => observer.notify(240))
    expect(capsuleHeight(container)).toBe(settled)
  })

  it('takes the new width after a resize back to the earlier measurement', () => {
    fieldHeight = 20 * 2 + 26
    const container = renderDock('一\n二')
    const observer = widthObserver(container)
    act(() => observer.notify(240))
    expect(capsuleHeight(container)).toBe('66px')

    fieldHeight = 20 * 4 + 26
    act(() => observer.notify(360))
    expect(capsuleHeight(container)).toBe('106px')
  })

  // The follow-up has no field of its own — it is one fixed row — so nothing is
  // measured. Publish its known height instead of retaining the `0px` start.
  it('publishes the one-line height for a follow-up, which has no field to measure', () => {
    const { container } = render(
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen={false} inputValue="" bartAttachments={[]}
        threadFollowUp={{ threadId: 't1', threadTitle: '一个 Thread', provider: 'codex', initialDraft: '', requestKey: 1 }}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
        onThreadFollowUpSubmit={async () => undefined}
      />
    )
    expect(container.querySelector('.bart-dock-thread-follow-up')).not.toBeNull()
    expect(capsuleHeight(container)).toBe('46px')
  })

  // Closing the input empties the draft, and on send the attachments go with it.
  // The capsule is still on screen while it collapses, and it has to collapse
  // from the shape that was there rather than from an empty one-line box.
  it('keeps the closing capsule measured from the draft it was showing', () => {
    const { container, rerender } = render(
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen inputValue={'一\n二\n三'} bartAttachments={[]}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
      />
    )
    expect(capsuleHeight(container)).toBe('86px')

    act(() => {
      rerender(
        <BartDock
          activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
          threadOpen={false} sessionIdle
          inputOpen={false} inputValue="" bartAttachments={[]}
          foregroundActivity={undefined} running={false}
          onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
          onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
        />
      )
    })
    const dock = container.querySelector('.bart-dock')
    expect(dock?.getAttribute('data-capsule-leaving')).toBe('draft')
    expect(container.querySelector('textarea')?.value).toBe('一\n二\n三')
    expect(capsuleHeight(container)).toBe('86px')
  })

  // The attachments row sits above the field and is not in the field's own
  // measurement, but still consumes space in the capsule.
  it('publishes the attachment row alongside the measured field', () => {
    fieldHeight = 20 + 26
    const container = renderDock('一段话', [])
    expect(attachmentHeight(container)).toBe('0px')

    const view = render(
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen inputValue="一段话" bartAttachments={PENDING_ATTACHMENT}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
      />
    )
    expect(attachmentHeight(view.container)).toBe('39px')
    expect(capsuleHeight(view.container)).toBe('46px')
  })

  // The attachments belong to the draft, and a follow-up is not the draft: it is
  // its own single row. Only visible attachments consume input space.
  it('publishes no attachment row for a follow-up, which has none of its own', () => {
    fieldHeight = 20 + 26
    const { container } = render(
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen={false} inputValue="" bartAttachments={PENDING_ATTACHMENT}
        threadFollowUp={{ threadId: 't1', threadTitle: '一个 Thread', provider: 'codex', initialDraft: '', requestKey: 1 }}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
        onThreadFollowUpSubmit={async () => undefined}
      />
    )
    expect(container.querySelector('.bart-dock-attachment-strip')).toBeNull()
    expect(attachmentHeight(container)).toBe('0px')
    expect(capsuleHeight(container)).toBe('46px')
  })

  // A chip row that overflows is a row with a scrollbar wherever the platform
  // draws one with a size, and that size comes out of the height the row was
  // given: the chips would be clipped inside it. Overlay scrollbars take nothing,
  // so the platforms
  // that draw those keep the design number.
  it('adds the platform scrollbar to the attachment row', () => {
    fieldHeight = 20 + 26
    withScrollbarGutter(11)
    const container = renderDock('一段话', PENDING_ATTACHMENT)
    expect(attachmentHeight(container)).toBe('50px')
  })

  // Closing the input makes the form inert, and the cursor goes with it. A
  // capsule reopened inside its own exit is on screen the whole time, so the
  // effect that puts the cursor back has to watch the input opening rather than
  // the capsule being up — the second of those never changes. jsdom does not
  // apply `inert`, so the blur it causes is done here by hand.
  it('takes the cursor back when the capsule is reopened inside its exit', () => {
    fieldHeight = 20 + 26
    const dock = (inputOpen: boolean): React.JSX.Element => (
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen={inputOpen} inputValue="一段话" bartAttachments={[]}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={noop}
      />
    )
    const { container, rerender } = render(dock(true))
    const field = container.querySelector('textarea')
    expect(document.activeElement).toBe(field)

    act(() => rerender(dock(false)))
    field?.blur()
    expect(document.activeElement).not.toBe(field)

    act(() => rerender(dock(true)))
    expect(container.querySelector('.bart-dock')?.getAttribute('data-capsule-leaving')).toBeNull()
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  // Sending empties the draft while the input is still open, so the clearing
  // arrives as a prop change before the capsule has begun to collapse. The
  // capsule is measured from its own field: unsealed, it would shrink to one row
  // on screen, and the collapse would then run from a shape that was never sent.
  it('keeps measuring the submitted draft after the store empties it', async () => {
    fieldHeight = 20 * 3 + 26
    const { container, rerender } = render(
      <BartDock
        activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
        threadOpen={false} sessionIdle
        inputOpen inputValue={'一\n二\n三'} bartAttachments={[]}
        foregroundActivity={undefined} running={false}
        onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
        onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={async () => undefined}
      />
    )
    expect(capsuleHeight(container)).toBe('86px')

    const form = container.querySelector('form')
    if (!form) throw new Error('the draft form is not rendered')
    await act(async () => { fireEvent.submit(form) })

    act(() => {
      rerender(
        <BartDock
          activityContext={{ threadKey: 'bart-capsule-test', execution: null }}
          threadOpen={false} sessionIdle
          inputOpen inputValue="" bartAttachments={[]}
          foregroundActivity={undefined} running={false}
          onThreadOpenChange={noop} onInputOpenChange={noop} onInputChange={noop}
          onChooseFiles={noop} onRemoveBartAttachment={noop} onSubmit={async () => undefined}
        />
      )
    })
    expect(container.querySelector('textarea')?.value).toBe('一\n二\n三')
    expect(capsuleHeight(container)).toBe('86px')
  })
})
