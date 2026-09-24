// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareBartLaunch } from '../src/renderer/src/bart-motion/launch-capture'

const animation = { cancel: vi.fn(), onfinish: null as null | (() => void) }
const animate = vi.fn(() => animation)
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('form')) return new DOMRect(100, 300, 360, 126)
    return new DOMRect(80, 100, 400, 210)
  })
})
afterEach(() => {
  document.body.replaceChildren()
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).animate
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks()
  animation.onfinish = null
})
function fixture() {
  const dock = document.createElement('aside')
  dock.innerHTML = `<svg class="bart-logo" data-worker-ready="true"></svg>
    <form id="draft" class="bart-dock-inline-composer" style="border-radius:26px;--bart-dock-capsule-open:1;--bart-dock-capsule-height:126px;--bart-dock-capsule-room:140px">
      <div class="bart-dock-attachment-strip"><span id="file" class="attachment-chip">file.txt</span></div>
      <div class="bart-dock-inline-row">
        <button class="bart-dock-attach"><svg><path /></svg></button>
        <textarea id="message" style="height:101px;padding-top:13px;padding-bottom:13px">initial</textarea>
        <button class="bart-dock-send" style="background-color:rgb(247,245,238)"><svg><path /></svg></button>
      </div>
    </form>`
  document.body.append(dock)
  return dock
}
it('retains the styled, scrolled draft independently of the live form', () => {
  const dock = fixture(), field = dock.querySelector('textarea')!
  field.value = 'edited\nsecond\nthird\nfourth\nfifth\nsixth'
  field.scrollTop = 45
  dock.querySelector('.bart-dock-attachment-strip')!.scrollLeft = 24
  const launch = prepareBartLaunch(dock)!
  const copy = document.querySelector<HTMLElement>('.bart-launch-content')!
  field.value = ''; dock.remove()
  expect(copy.getAttribute('aria-hidden')).toBe('true')
  expect(copy.inert).toBe(true)
  expect(copy.querySelector('[id]')).toBeNull()
  expect(copy.id).toBe('')
  expect(copy.style.getPropertyValue('--bart-dock-capsule-height')).toBe('126px')
  expect(copy.querySelector('textarea')!.value).toContain('sixth')
  expect(copy.querySelector('textarea')!.style.height).toBe('101px')
  expect(copy.querySelector('textarea')!.scrollTop).toBe(45)
  expect(copy.querySelector('.bart-dock-attachment-strip')!.scrollLeft).toBe(24)
  expect(copy.querySelector<HTMLElement>('.bart-dock-send')!.style.backgroundColor).toBe('rgb(247, 245, 238)')
  expect(copy.style.width).toBe('360px')
  expect(copy.style.top).toBe('300px')
  expect(launch.description.bodyOffset).toEqual({ x: 0, y: 0 })
  launch.dispose()
  expect(copy.isConnected).toBe(false)
})
it('keeps style capture bounded as icon and attachment markup grows', () => {
  const dock = fixture(), computed = vi.spyOn(window, 'getComputedStyle')
  prepareBartLaunch(dock)!.dispose()
  const small = computed.mock.calls.length
  computed.mockClear()
  for (let i = 0; i < 100; i++) dock.querySelector('.attachment-chip')!.append(document.createElement('span'))
  prepareBartLaunch(dock)!.dispose()
  expect(computed.mock.calls.length).toBe(small)
  expect(small).toBeLessThanOrEqual(4)
})
it('removes the frozen content when the fade finishes or preparation fails', () => {
  const dock = fixture()
  prepareBartLaunch(dock)
  animation.onfinish!()
  expect(document.querySelector('.bart-launch-content')).toBeNull()
  animate.mockImplementationOnce(() => { throw new Error('Animation unavailable') })
  expect(prepareBartLaunch(dock)).toBeUndefined()
  expect(document.querySelector('.bart-launch-content')).toBeNull()
})
it('does not capture when the Worker is unavailable or motion is reduced', () => {
  const dock = fixture()
  dock.querySelector('svg')!.removeAttribute('data-worker-ready')
  expect(prepareBartLaunch(dock)).toBeUndefined()
  dock.querySelector('svg')!.setAttribute('data-worker-ready', 'true')
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  expect(prepareBartLaunch(dock)).toBeUndefined()
  expect(animate).not.toHaveBeenCalled()
})
