import { getOverviewMotionCoordinator, type OverviewStageLease } from './coordinator'

interface CardGeometry {
  element: HTMLElement
  rect: DOMRect
  opacity: string
  transform: string
  transformOrigin: string
}

interface FilterMotionRun {
  viewport: HTMLElement
  exits: HTMLElement
  before: Map<string, CardGeometry>
  speed: number
  abort: AbortController
  animations: Animation[]
  lease?: OverviewStageLease
  content?: HTMLElement
  wasInert?: boolean
  dispose: (() => void)[]
}

function cardsIn(content: HTMLElement): Map<string, CardGeometry> {
  return new Map([...content.querySelectorAll<HTMLElement>('[data-overview-card-id]')]
    .filter(element => !element.classList.contains('overview-geometry-placeholder'))
    .map(element => {
      const style = getComputedStyle(element)
      return [element.dataset.overviewCardId!, {
        element, rect: element.getBoundingClientRect(), opacity: style.opacity, transform: style.transform, transformOrigin: style.transformOrigin
      }]
    }))
}

/** Tag changes bridge old screen geometry to live cards in the new fitted Canvas. */
export class OverviewFilterMotion {
  private run: FilterMotionRun | null = null

  /** Called by getSnapshotBeforeUpdate, while the outgoing React tree still exists. */
  capture(viewport: HTMLElement | null, playbackRate = 1): (() => void) | null {
    const content = viewport?.querySelector<HTMLElement>(':scope > .thread-overview-scroll-content:not(.overview-filter-exits)')
    if (!viewport || !content || !viewport.clientWidth || !viewport.clientHeight ||
      typeof HTMLElement.prototype.animate !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.cancel()
      return null
    }

    // Sample the visible frame BEFORE cancelling an interrupted reflow. This keeps
    // a surviving card at its current screen position rather than its old destination.
    const before = cardsIn(content)
    const exits = content.cloneNode(true) as HTMLElement
    exits.classList.add('overview-filter-exits')
    const plane = content.querySelector<HTMLElement>('.thread-overview-plane')
    const copiedPlane = exits.querySelector<HTMLElement>('.thread-overview-plane')
    if (plane && copiedPlane) copiedPlane.style.transform = getComputedStyle(plane).transform
    const copies = exits.querySelectorAll<HTMLElement>('[data-overview-card-id]')
    for (const copy of copies) {
      const id = copy.dataset.overviewCardId!
      const geometry = before.get(id)
      copy.removeAttribute('data-overview-card-id')
      if (!geometry) { copy.remove(); continue }
      copy.style.transform = geometry.transform
      copy.style.transformOrigin = geometry.transformOrigin
      copy.style.opacity = geometry.opacity
      before.set(id, { ...geometry, element: copy })
    }
    exits.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'))
    exits.querySelectorAll('[data-report-id], [data-thread-id]').forEach(element => {
      element.removeAttribute('data-report-id')
      element.removeAttribute('data-thread-id')
    })
    exits.setAttribute('aria-hidden', 'true')
    exits.inert = true
    this.cancel()
    const run: FilterMotionRun = {
      viewport, exits, before, speed: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
      abort: new AbortController(), animations: [], dispose: []
    }
    this.run = run
    viewport.append(exits)
    viewport.dataset.overviewFilterMotion = 'pending'
    return () => { if (this.run === run) void this.play(run) }
  }

  cancel(): void {
    const run = this.run
    if (!run) return
    this.run = null
    run.abort.abort()
    for (const dispose of run.dispose) dispose()
    for (const animation of run.animations) animation.cancel()
    run.exits.remove()
    if (run.content) run.content.inert = run.wasInert ?? false
    delete run.viewport.dataset.overviewFilterMotion
    run.lease?.release()
  }

  private async play(run: FilterMotionRun): Promise<void> {
    const coordinator = getOverviewMotionCoordinator()
    const signal = run.abort.signal
    run.dispose.push(coordinator.onSceneCut(() => this.cancel()))
    const width = run.viewport.clientWidth, height = run.viewport.clientHeight
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        if (run.viewport.clientWidth !== width || run.viewport.clientHeight !== height) this.cancel()
      })
      observer.observe(run.viewport)
      run.dispose.push(() => observer.disconnect())
    }
    const onVisibility = (): void => { if (document.hidden) this.cancel() }
    document.addEventListener('visibilitychange', onVisibility)
    run.dispose.push(() => document.removeEventListener('visibilitychange', onVisibility))
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    const onReducedMotion = (): void => { if (reducedMotion?.matches) this.cancel() }
    reducedMotion?.addEventListener?.('change', onReducedMotion)
    run.dispose.push(() => reducedMotion?.removeEventListener?.('change', onReducedMotion))
    try {
      const lease = await coordinator.acquireStage('overview-filter:spatial-reflow', signal)
      if (signal.aborted) { lease.release(); return }
      run.lease = lease
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          window.cancelAnimationFrame(frame)
          reject(new DOMException('Filter transition cancelled', 'AbortError'))
        }
        const frame = window.requestAnimationFrame(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
        signal.addEventListener('abort', abort, { once: true })
      })
      if (signal.aborted) return
      const content = run.viewport.querySelector<HTMLElement>(':scope > .thread-overview-scroll-content:not(.overview-filter-exits)')
      if (!content) return
      run.content = content
      run.wasInert = content.inert
      content.inert = true
      const after = cardsIn(content)
      const jobs: Promise<unknown>[] = []
      const animate = (element: HTMLElement, frames: Keyframe[], duration: number, delay = 0): void => {
        const animation = element.animate(frames, { duration: duration / run.speed, delay: delay / run.speed,
          easing: 'cubic-bezier(.22, 1, .36, 1)', fill: 'both' })
        run.animations.push(animation)
        jobs.push(animation.finished.catch(() => {}))
      }
      for (const [id, old] of run.before) {
        if (after.has(id)) old.element.style.visibility = 'hidden'
        else {
          const transform = old.transform === 'none' ? '' : old.transform
          animate(old.element, [
            { opacity: old.opacity, transform: old.transform },
            { opacity: 0, transform: `${transform} scale(.88)` }
          ], 140)
        }
      }
      for (const [id, card] of after) {
        const { element, rect } = card
        if (!rect.width || !rect.height || !element.offsetWidth || !element.offsetHeight) continue
        const old = run.before.get(id)
        const scaleX = rect.width / element.offsetWidth, scaleY = rect.height / element.offsetHeight
        if (old) {
          animate(element, [
            { opacity: old.opacity, transformOrigin: '0 0',
              transform: `translate(${(old.rect.left - rect.left) / scaleX}px, ${(old.rect.top - rect.top) / scaleY}px) scale(${old.rect.width / rect.width}, ${old.rect.height / rect.height})` },
            { opacity: card.opacity, transformOrigin: '0 0', transform: 'translate(0, 0) scale(1)' }
          ], 320, 70)
        } else animate(element, [
          { opacity: 0, transform: `translateY(${12 / scaleY}px) scale(.94)` },
          { opacity: card.opacity, transform: card.transform }
        ], 230, 150)
      }
      if (!run.before.size) animate(run.exits, [{ opacity: 1 }, { opacity: 0 }], 130)
      if (!after.size) animate(content, [
        { opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }
      ], 220, 100)
      run.viewport.dataset.overviewFilterMotion = 'playing'
      await Promise.all(jobs)
    } catch (error) {
      if (!signal.aborted) console.warn('Overview filter transition could not play', error)
    } finally {
      if (this.run === run) this.cancel()
    }
  }
}
