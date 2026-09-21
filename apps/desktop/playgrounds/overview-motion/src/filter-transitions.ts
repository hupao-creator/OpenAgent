/** Alternative candidates stay local; spatial reflow runs the production component. */
export const filterTransitions = [
  { id: 'original', title: '原始', description: '220ms · 内容整体横移淡入。' },
  { id: 'reflow', title: 'A · 空间重排', description: '正式实现 · 约 400ms · 保留卡片连续移动，其余退出、新卡补入。' },
  { id: 'depth', title: 'B · 景深切幕', description: '320ms · 旧画面缩远虚化，新画面从前方落定。' },
  { id: 'stagger', title: 'C · 卡片接力', description: '约 430ms · 卡片依次退场，再错峰浮入。' },
  { id: 'push', title: 'D · 横向推镜', description: '360ms · 两组卡片沿标签方向衔接推移。' }
] as const

export type FilterTransition = typeof filterTransitions[number]['id']

interface SnapshotCard {
  element: HTMLElement
  rect: DOMRect
  scaleX: number
  scaleY: number
}

interface Snapshot {
  element: HTMLElement
  cards: Map<string, SnapshotCard>
}

interface TransitionRun {
  stage: HTMLElement
  overlay: HTMLElement
  before: Snapshot
  mode: Exclude<FilterTransition, 'original' | 'reflow'>
  speed: number
  direction: number
  animations: Animation[]
  frame: number
}

function snapshot(content: HTMLElement): Snapshot {
  const element = content.cloneNode(true) as HTMLElement
  element.classList.add('motion-filter-snapshot')
  element.style.animation = 'none'
  element.style.visibility = 'visible'
  // The camera's current transform may be owned by WAAPI rather than inline style.
  const plane = content.querySelector<HTMLElement>('.thread-overview-plane')
  const copyPlane = element.querySelector<HTMLElement>('.thread-overview-plane')
  if (plane && copyPlane) copyPlane.style.transform = getComputedStyle(plane).transform
  const cards = new Map<string, SnapshotCard>()
  const originals = content.querySelectorAll<HTMLElement>('[data-overview-card-id]')
  const copies = element.querySelectorAll<HTMLElement>('[data-overview-card-id]')
  originals.forEach((original, index) => {
    const copy = copies[index]!
    const id = original.dataset.overviewCardId!
    const rect = original.getBoundingClientRect()
    copy.dataset.filterPreviewCard = id
    copy.removeAttribute('data-overview-card-id')
    cards.set(id, { element: copy, rect,
      scaleX: rect.width / (original.offsetWidth || 1),
      scaleY: rect.height / (original.offsetHeight || 1) })
  })
  // Snapshots are visual only: no duplicate DOM identity, focus, or production lookups.
  element.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'))
  element.querySelectorAll('[data-report-id]').forEach(node => node.removeAttribute('data-report-id'))
  return { element, cards }
}

/** The real tree commits immediately; inert snapshots bridge its old and new camera geometry. */
export class FilterTransitionPreview {
  private run: TransitionRun | null = null

  constructor(private readonly onBusy: (busy: boolean) => void) {}

  capture(stage: HTMLElement | null, mode: FilterTransition, speed: number, direction: number): void {
    this.cancel()
    if (!stage || (mode === 'original' || mode === 'reflow') || typeof HTMLElement.prototype.animate !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const scroll = stage.querySelector<HTMLElement>('.thread-overview-scroll')
    const content = scroll?.querySelector<HTMLElement>(':scope > .thread-overview-scroll-content')
    if (!scroll || !content || scroll.clientWidth === 0) return
    const before = snapshot(content)
    const overlay = document.createElement('div')
    overlay.className = 'motion-filter-overlay'
    overlay.setAttribute('aria-hidden', 'true')
    overlay.inert = true
    overlay.append(before.element)
    scroll.append(overlay)
    stage.dataset.filterTransitionActive = mode
    this.run = { stage, overlay, before, mode, speed, direction, animations: [], frame: 0 }
    this.onBusy(true)
  }

  play(): void {
    const run = this.run
    if (!run) return
    // Scene cuts commit camera geometry in a microtask. Two frames also allow the
    // new measured card footprint to reach the production layout before capture.
    window.cancelAnimationFrame(run.frame)
    run.frame = window.requestAnimationFrame(() => {
      run.frame = window.requestAnimationFrame(() => {
        if (this.run !== run) return
        try { this.animate(run) } catch { this.cancel() }
      })
    })
  }

  cancel(): void {
    const run = this.run
    if (!run) return
    this.run = null
    window.cancelAnimationFrame(run.frame)
    for (const animation of run.animations) animation.cancel()
    run.overlay.remove()
    delete run.stage.dataset.filterTransitionActive
    this.onBusy(false)
  }

  private animate(run: TransitionRun): void {
    const content = run.overlay.parentElement?.querySelector<HTMLElement>(':scope > .thread-overview-scroll-content')
    if (!content) { this.cancel(); return }
    const after = snapshot(content)
    run.overlay.append(after.element)
    const jobs: Promise<unknown>[] = []
    const play = (element: HTMLElement, frames: Keyframe[], duration: number, delay = 0): void => {
      const animation = element.animate(frames, {
        duration: duration / run.speed, delay: delay / run.speed,
        easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both'
      })
      run.animations.push(animation)
      jobs.push(animation.finished.catch(() => {}))
    }
    const { before, mode, direction } = run
    if (mode === 'depth') {
      play(before.element, [
        { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' },
        { opacity: 0, filter: 'blur(3px)', transform: 'scale(.94)' }
      ], 180)
      play(after.element, [
        { opacity: 0, filter: 'blur(4px)', transform: 'scale(1.055)' },
        { opacity: 1, filter: 'blur(0)', transform: 'scale(1)' }
      ], 250, 70)
    } else if (mode === 'stagger') {
      const stagger = (shot: Snapshot, entering: boolean): void => {
        const targets = shot.cards.size ? [...shot.cards.values()] : [{ element: shot.element, scaleY: 1 }]
        targets.forEach((card, index) => {
          const step = targets.length > 1 ? Math.min(18, 75 / (targets.length - 1)) : 0
          play(card.element, entering ? [
            { opacity: 0, transform: `translateY(${28 / (card.scaleY || 1)}px) scale(.97)` },
            { opacity: 1, transform: 'translateY(0) scale(1)' }
          ] : [
            { opacity: 1, transform: 'translateY(0)' },
            { opacity: 0, transform: `translateY(${-18 / (card.scaleY || 1)}px)` }
          ], entering ? 255 : 130, (entering ? 100 : 0) + index * step)
        })
      }
      stagger(before, false)
      stagger(after, true)
    } else {
      const width = run.overlay.clientWidth
      play(before.element, [
        { opacity: 1, transform: 'translateX(0) scale(1)' },
        { opacity: 0, transform: `translateX(${-direction * width * .23}px) scale(.97)` }
      ], 270)
      play(after.element, [
        { opacity: 0, transform: `translateX(${direction * width * .28}px) scale(.97)` },
        { opacity: 1, transform: 'translateX(0) scale(1)' }
      ], 350, 10)
    }
    void Promise.all(jobs).then(() => { if (this.run === run) this.cancel() })
  }
}
