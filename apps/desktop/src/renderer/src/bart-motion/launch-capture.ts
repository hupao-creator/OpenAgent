import { sampleLaunchCapsule, type CharacterLaunch } from './launch-story'

let sequence = 0
// The clone keeps the composer's CSS classes. Only these inherited values cross
// the boundary from the Dock to the document-level compositor layer.
const INHERITED_STYLES = [
  '--bart-dock-capsule-height', '--bart-dock-capsule-open', '--bart-dock-capsule-attachment-height',
  '--bart-dock-capsule-line-height', '--bart-dock-capsule-inset', '--bart-dock-capsule-room',
  '--line-soft', '--muted', '--danger',
  'font', 'color', 'letter-spacing', 'direction', 'color-scheme'
] as const
export interface PreparedLaunch {
  description: CharacterLaunch
  dispose(): void
}

/** Capture once. The Worker paints the morph; only the first 80ms of real
 * content uses a prepared compositor fade, with no renderer frame loop. */
export function prepareBartLaunch(dock: HTMLElement | null, speed = 1): PreparedLaunch | undefined {
  try { return capture(dock, Math.max(.1, Math.min(2, speed))) } catch { return }
}

function capture(dock: HTMLElement | null, speed: number): PreparedLaunch | undefined {
  const form = dock?.querySelector<HTMLFormElement>('.bart-dock-inline-composer')
  const svg = dock?.querySelector<SVGSVGElement>('.bart-logo[data-worker-ready="true"]')
  if (!dock || !form || !svg || typeof form.animate !== 'function' ||
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const source = form.getBoundingClientRect(), body = svg.getBoundingClientRect(), home = dock.getBoundingClientRect()
  if (!source.width || !source.height || !body.height) return
  const scale = body.height / 640
  const origin = { x: home.left + (home.width - body.height) / 2, y: home.top }
  const style = getComputedStyle(form)
  const launch: CharacterLaunch = {
    key: ++sequence, startedAt: 0, speed,
    capsule: { x: (source.left - origin.x) / scale, y: (source.top - origin.y) / scale,
      width: source.width / scale, height: source.height / scale },
    bodyOffset: { x: (body.left + body.width / 2 - home.left - home.width / 2) / scale,
      y: (body.top - home.top) / scale },
    radius: (parseFloat(style.borderRadius) || 26) / scale
  }
  // Freeze the real text and attachment chips before submission clears them.
  const copy = form.cloneNode(true) as HTMLElement
  for (const name of INHERITED_STYLES) copy.style.setProperty(name, style.getPropertyValue(name))
  for (const element of [copy, ...copy.querySelectorAll('[id]')]) element.removeAttribute('id')
  const field = form.querySelector('textarea'), copiedField = copy.querySelector('textarea')
  const scrollTop = field?.scrollTop ?? 0, scrollLeft = field?.scrollLeft ?? 0
  const stripScroll = form.querySelector('.bart-dock-attachment-strip')?.scrollLeft ?? 0
  if (field && copiedField) {
    copiedField.value = field.value
    // A send may interrupt a height transition or a scrolled multiline draft.
    const fieldStyle = getComputedStyle(field)
    for (const name of ['height', 'padding-top', 'padding-bottom']) copiedField.style.setProperty(name, fieldStyle.getPropertyValue(name))
  }
  // Preserve hovered/disabled controls without copying hundreds of properties
  // from every icon path, chip and text node on the synchronous submit path.
  const copiedButtons = copy.querySelectorAll<HTMLElement>('.bart-dock-attach, .bart-dock-send')
  form.querySelectorAll<HTMLElement>('.bart-dock-attach, .bart-dock-send').forEach((button, i) => {
    const buttonStyle = getComputedStyle(button)
    for (const name of ['background-color', 'color', 'opacity']) copiedButtons[i].style.setProperty(name, buttonStyle.getPropertyValue(name))
  })
  copy.classList.add('bart-launch-content')
  copy.inert = true; copy.setAttribute('aria-hidden', 'true')
  Object.assign(copy.style, { position: 'fixed', left: `${source.left}px`, top: `${source.top}px`,
    right: 'auto', bottom: 'auto', width: `${source.width}px`, height: `${source.height}px`,
    boxSizing: 'border-box', border: '0', borderRadius: style.borderRadius,
    margin: '0', transform: 'none', translate: 'none', transformOrigin: '0 0',
    pointerEvents: 'none', background: 'transparent', boxShadow: 'none', borderColor: 'transparent', zIndex: '40' })
  document.body.append(copy)
  // Most sends start at zero; avoid forcing the fresh clone through layout just
  // to assign the browser's default scroll position.
  if (copiedField && scrollTop) copiedField.scrollTop = scrollTop
  if (copiedField && scrollLeft) copiedField.scrollLeft = scrollLeft
  if (stripScroll) copy.querySelector('.bart-dock-attachment-strip')!.scrollLeft = stripScroll
  let animation: Animation | undefined
  const dispose = (): void => { animation?.cancel(); copy.remove() }
  try {
    const frames = Array.from({ length: 9 }, (_, i) => {
      const elapsed = i * 10, rect = sampleLaunchCapsule(launch, elapsed), p = elapsed / 80
      return { offset: p, opacity: 1 - p * p * (3 - 2 * p),
        transform: `translate(${(rect.x - launch.capsule.x) * scale}px, ${(rect.y - launch.capsule.y) * scale}px) scale(${rect.width / launch.capsule.width}, ${rect.height / launch.capsule.height})` }
    })
    launch.startedAt = performance.timeOrigin + performance.now()
    animation = copy.animate(frames, { duration: 80 / speed, fill: 'forwards', easing: 'linear' })
    animation.onfinish = dispose
  } catch { dispose(); return }
  return { description: launch, dispose }
}
