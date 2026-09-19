import { getFontEmbedCSS } from 'html-to-image'
import { snapshotSurfaceVariants } from './dom-snapshot'
import { cardRevealBlocks } from '../card-generation/reveal'
import { measureVisibleCharacters } from '../card-generation/content'
import { typesetBlock, type TypesetCaretPoint } from '../card-generation/typeset'
import type { MotionRect, MotionRevealFrame, MotionTexture } from './worker-types'
import { MOTION_LIMITS } from './runtime-limits'
import { freezeCardDOM } from './card-snapshot'

export interface PreparedMotionCard {
  rect: MotionRect
  duration: number
  assets: { id: string; bitmap: ImageBitmap }[]
  textures: MotionTexture[]
  caret: TypesetCaretPoint[]
  /** Glyph, line and block boundaries used to compile the writing rhythm. */
  beats?: readonly { at: number; kind: 'character' | 'wrap' | 'block'; text?: string }[]
}

export interface CapturedMotionCard {
  prepare(signal: AbortSignal, embeddedFonts: string): Promise<PreparedMotionCard>
  dispose(): void
}

let sequence = 0
let fonts: Promise<string> | undefined

/** Wall-clock labels are presentation, not a new business/content revision. */
export function motionCardRevision(card: HTMLElement): string {
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT)
  const text: string[] = []
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement?.closest('.thread-card-rolling-number')) text.push(walker.currentNode.textContent ?? '')
  }
  const style = getComputedStyle(card)
  const classes = [card, ...card.querySelectorAll<HTMLElement>('[class]')]
    .filter(element => !element.closest('.thread-card-rolling-number')).map(element => element.getAttribute('class'))
  return JSON.stringify([text, classes, card.offsetWidth, card.offsetHeight, style.color, style.backgroundColor,
    style.fontFamily, style.fontSize, style.borderColor, style.borderRadius,
    [...card.querySelectorAll('img')].map(image => image.currentSrc || image.src), Boolean(card.querySelector('[aria-busy="true"]'))])
}

/** Font download/embedding is prewarming, never work to wait for with a scene lock. */
export async function prewarmMotionCards(card: HTMLElement, signal?: AbortSignal): Promise<string> {
  await document.fonts.ready
  signal?.throwIfAborted()
  fonts ??= getFontEmbedCSS(card).catch((error: unknown) => { fonts = undefined; throw error })
  const css = await fonts
  signal?.throwIfAborted()
  return css
}

/** Synchronous sampling boundary: content, styles and measurements belong to one input. */
export function captureMotionCard(card: HTMLElement, origin: { x: number; y: number }): CapturedMotionCard {
  const target = card.getBoundingClientRect(), scale = target.width / card.offsetWidth
  const width = card.offsetWidth, height = card.offsetHeight
  if (!width || !height || !scale) throw new Error('Bart card has no layout')
  const ratio = Math.min(2, devicePixelRatio)
  const padding = 40
  if (Math.max(width + padding * 2, height + padding * 2) * ratio > MOTION_LIMITS.textureSide) {
    throw new Error('Bart card snapshot exceeds the texture side budget')
  }
  const frozen = freezeCardDOM(card)
  let disposed = false, started = false
  const dispose = (): void => { disposed = true; frozen.dispose() }
  try {
    // Measure the same isolated DOM that will be serialized, in unscaled card
    // coordinates. The live target rect remains a separate world-space fact.
    Object.assign(frozen.element.style, { width: `${width}px`, height: `${height}px`,
      transform: 'none', translate: 'none', rotate: 'none', scale: 'none',
      position: 'relative', inset: '0', margin: '0' })
    const bounds = frozen.element.getBoundingClientRect()
    const prefix = `bart-card-${++sequence}`
    const attribute = `data-bart-resource-${sequence}`
    const measurements = cardRevealBlocks(frozen.element).map(block => {
      const rect = block.getBoundingClientRect()
      const clip = new DOMRect(Math.max(rect.left, bounds.left), Math.max(rect.top, bounds.top),
        Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left)),
        Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)))
      const singleLine = !block.matches('.thread-overview-excerpt, .report-overview-preview, .thread-card-extension, .thread-card-workflow-phase-cell, .thread-card-workflow-agent-cell')
      const points = measureVisibleCharacters(block, clip, singleLine)
      if (block.classList.contains('thread-provider-status') && clip.width && clip.height) {
        points.push({ left: 0, right: clip.width, top: 0, bottom: clip.height,
          lineHeight: clip.height, weight: 3.8 })
      }
      return { block, clip, singleLine, points }
    }).filter(({ clip, points }) => clip.width > 0 && clip.height > 0 && points.length)
    measurements.forEach(({ block }) => block.setAttribute(attribute, ''))
    const rect = { x: target.left - origin.x, y: target.top - origin.y, width: target.width, height: target.height }
    return {
      dispose,
      async prepare(signal, embeddedFonts) {
        if (disposed || started) throw new Error('Bart card snapshot already consumed')
        if (signal.aborted) { dispose(); signal.throwIfAborted() }
        const assertActive = (): void => {
          signal.throwIfAborted()
          if (disposed) throw new DOMException('Bart card snapshot disposed', 'AbortError')
        }
        started = true
        signal.addEventListener('abort', dispose, { once: true })
        const options = { width: width + padding * 2, height: height + padding * 2, pixelRatio: ratio,
          fontEmbedCSS: embeddedFonts, fetchRequestInit: { signal },
          style: { width: `${width}px`, height: `${height}px`, visibility: 'visible', opacity: '1',
            transform: `translate(${padding}px, ${padding}px)`, position: 'relative', inset: 'auto' } }
        const assets: PreparedMotionCard['assets'] = []
        const textures: MotionTexture[] = []
        const caret: TypesetCaretPoint[] = []
        const beats: NonNullable<PreparedMotionCard['beats']>[number][] = []
        let elapsed = 0
        try {
          const [full, shell] = await snapshotSurfaceVariants(frozen.element, options, [undefined, xml => {
            xml.querySelectorAll<HTMLElement>(`[${attribute}], [${attribute}] *`).forEach(block => { block.style.visibility = 'hidden' })
          }])
          assertActive()
          assets.push({ id: prefix, bitmap: await createImageBitmap(shell, { premultiplyAlpha: 'none' }) })
          assertActive()
          textures.push({ id: prefix, rect: { x: rect.x - padding * scale, y: rect.y - padding * scale,
            width: rect.width + padding * scale * 2, height: rect.height + padding * scale * 2 }, from: 0 })
          for (const [index, { clip, singleLine, points }] of measurements.entries()) {
            // Crop on the same raster grid as the complete card.
            const left = Math.max(0, Math.floor((clip.left - bounds.left) * ratio) - 2)
            const top = Math.max(0, Math.floor((clip.top - bounds.top) * ratio) - 2)
            const right = Math.min(width * ratio, Math.ceil((clip.right - bounds.left) * ratio) + 2)
            const bottom = Math.min(height * ratio, Math.ceil((clip.bottom - bounds.top) * ratio) + 2)
            const x = left / ratio, y = top / ratio, w = (right - left) / ratio, h = (bottom - top) / ratio
            const dx = clip.left - bounds.left - x, dy = clip.top - bounds.top - y
            const duration = points.reduce((total, point) => total + point.weight, 0) / 38 * 1000
            const typed = typesetBlock(points.map(point => ({ ...point,
              left: point.left + dx, right: point.right + dx, top: point.top + dy, bottom: point.bottom + dy
            })), { width: w, height: h, singleLine }, duration)
            beats.push({ at: elapsed, kind: 'block' })
            let characterTime = elapsed
            for (const point of points) {
              characterTime += point.weight / 38 * 1000
              beats.push({ at: characterTime, kind: 'character', text: point.text })
            }
            for (let cursor = 1; cursor < typed.caret.length; cursor++) {
              const previous = typed.caret[cursor - 1], next = typed.caret[cursor]
              if (previous.at === next.at && previous.y !== next.y) beats.push({ at: elapsed + next.at, kind: 'wrap' })
            }
            const reveal: MotionRevealFrame[] = typed.frames.map(frame => {
              const polygon = String(frame.clipPath).match(/-?\d+(?:\.\d+)?/g)!.map(Number)
              return { at: elapsed + Number(frame.offset) * duration,
                x: polygon[6] * scale, top: polygon[5] * scale, bottom: polygon[9] * scale }
            })
            const id = `${prefix}-${index}`
            assets.push({ id, bitmap: await createImageBitmap(full, left + padding * ratio, top + padding * ratio,
              right - left, bottom - top, { premultiplyAlpha: 'none' }) })
            assertActive()
            textures.push({ id, from: elapsed, rect: { x: rect.x + x * scale, y: rect.y + y * scale,
              width: w * scale, height: h * scale }, reveal })
            caret.push(...typed.caret.map(point => ({ at: elapsed + point.at,
              x: rect.x + Math.max(13, Math.min(rect.width - 13, (x + point.x + 10) * scale)),
              y: rect.y + Math.max(13, Math.min(rect.height - 13, (y + point.y) * scale)) })))
            elapsed += duration + 34
          }
          assertActive()
          return { rect, duration: elapsed, assets, textures, caret, beats }
        } catch (error) { assets.forEach(asset => asset.bitmap.close()); throw error }
        finally { signal.removeEventListener('abort', dispose); dispose() }
      }
    }
  } catch (error) { dispose(); throw error }
}

/** Convenience entry for single-card callers; batches sample all cards before any await. */
export async function prepareMotionCard(card: HTMLElement, origin: { x: number; y: number }, signal?: AbortSignal, embeddedFonts?: string): Promise<PreparedMotionCard> {
  const fontEmbedCSS = embeddedFonts ?? await prewarmMotionCards(card, signal)
  signal?.throwIfAborted()
  const captured = captureMotionCard(card, origin)
  try { return await captured.prepare(signal ?? new AbortController().signal, fontEmbedCSS) }
  finally { captured.dispose() }
}
