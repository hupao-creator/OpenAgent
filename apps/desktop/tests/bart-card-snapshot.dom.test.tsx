// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureMotionCard } from '../src/renderer/src/bart-motion/card-assets'
import { freezeCardDOM } from '../src/renderer/src/bart-motion/card-snapshot'

const mocks = vi.hoisted(() => ({ raster: vi.fn(), measure: vi.fn(), bitmap: vi.fn() }))
vi.mock('html-to-image', () => ({ getFontEmbedCSS: async () => '' }))
vi.mock('../src/renderer/src/bart-thread-transition/camera-scene', () => ({ snapshotSurfaceVariants: mocks.raster }))
vi.mock('../src/renderer/src/card-generation/content', () => ({ measureVisibleCharacters: mocks.measure }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const hosts = () => document.querySelectorAll('[data-bart-card-snapshot]')
function fixture() {
  const card = document.createElement('article')
  card.innerHTML = '<div class="thread-overview-item-head"><strong id="live-title" style="color:red">Old title</strong></div>'
  document.body.append(card)
  return card
}
beforeEach(() => {
  // jsdom has no pseudo-element/layout engine; the browser suite covers native
  // layout and serialization. Here the real sampler owns the actual DOM copy.
  const computed = window.getComputedStyle.bind(window)
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    if (!pseudo) return computed(element)
    const style = document.createElement('span').style
    style.content = 'none'
    return style
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.tagName === 'ARTICLE') return this.getRootNode() instanceof ShadowRoot
      ? new DOMRect(0, 0, 360, 200) : new DOMRect(40, 60, 360, 200)
    return new DOMRect(16, 20, 200, 20)
  })
  vi.stubGlobal('devicePixelRatio', 1)
  vi.stubGlobal('createImageBitmap', mocks.bitmap)
  mocks.bitmap.mockImplementation(async () => ({ width: 440, height: 280, close: vi.fn() }))
  mocks.raster.mockImplementation(async () => [document.createElement('canvas'), document.createElement('canvas')])
  mocks.measure.mockImplementation((block: HTMLElement) => Array.from(block.textContent ?? '').map((_, index) => ({
    left: index * 6, right: index * 6 + 6, top: 0, bottom: 16, lineHeight: 16, weight: 1
  })))
})
afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetAllMocks()
})

describe('fixed card input', () => {
  it('measures and asynchronously serializes the same content, never the updated live card', async () => {
    const card = fixture(), gate = deferred<void>()
    let encodedText = '', encodedColor = ''
    mocks.raster.mockImplementation(async (element: HTMLElement) => {
      await gate.promise
      encodedText = element.textContent ?? ''
      encodedColor = getComputedStyle(element.querySelector('strong')!).color
      return [document.createElement('canvas'), document.createElement('canvas')]
    })
    const captured = captureMotionCard(card, { x: 10, y: 20 })
    const measured = mocks.measure.mock.calls[0]![0] as HTMLElement
    expect(measured).not.toBe(card.querySelector('strong'))
    expect(measured.getRootNode()).toBeInstanceOf(ShadowRoot)
    expect(measured.textContent).toBe('Old title')
    card.querySelector('strong')!.textContent = 'Changed before encoding'
    const preparing = captured.prepare(new AbortController().signal, '')
    card.querySelector('strong')!.style.color = 'blue'
    card.querySelector('strong')!.textContent = 'Changed during encoding'
    gate.resolve()
    const prepared = await preparing
    expect(encodedText).toBe('Old title')
    expect(encodedColor).toBe('rgb(255, 0, 0)')
    expect(prepared.rect).toEqual({ x: 30, y: 40, width: 360, height: 200 })
    expect(prepared.textures).toHaveLength(2)
    expect(prepared.duration).toBeGreaterThan(0)
    expect(document.getElementById('live-title')).toBe(card.querySelector('strong'))
    expect(card.textContent).toBe('Changed during encoding')
    expect(hosts()).toHaveLength(0)
    prepared.assets.forEach(asset => asset.bitmap.close())
  })

  it('releases the DOM immediately on abort and closes a late bitmap exactly once', async () => {
    const card = fixture(), gate = deferred<ImageBitmap>(), controller = new AbortController()
    const bitmap = { width: 440, height: 280, close: vi.fn() } as unknown as ImageBitmap
    mocks.bitmap.mockReturnValueOnce(gate.promise)
    const captured = captureMotionCard(card, { x: 0, y: 0 })
    const preparing = captured.prepare(controller.signal, '')
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(mocks.bitmap).toHaveBeenCalledTimes(1)
    expect(hosts()).toHaveLength(1)
    controller.abort()
    expect(hosts()).toHaveLength(0)
    gate.resolve(bitmap)
    await rejected
    expect(bitmap.close).toHaveBeenCalledTimes(1)
    expect(mocks.bitmap).toHaveBeenCalledTimes(1)
  })

  it('releases an input whose signal was already aborted before encoding', async () => {
    const captured = captureMotionCard(fixture(), { x: 0, y: 0 }), controller = new AbortController()
    controller.abort()
    await expect(captured.prepare(controller.signal, '')).rejects.toMatchObject({ name: 'AbortError' })
    expect(hosts()).toHaveLength(0)
    expect(mocks.raster).not.toHaveBeenCalled()
  })

  it('cleans up synchronous measurement failures', () => {
    const card = fixture()
    mocks.measure.mockImplementation(() => { throw new Error('Measurement failed') })
    expect(() => captureMotionCard(card, { x: 0, y: 0 })).toThrow('Measurement failed')
    expect(hosts()).toHaveLength(0)
    expect(card.isConnected).toBe(true)
  })

  it('cleans up decoder failures without changing the live card', async () => {
    const card = fixture()
    mocks.raster.mockRejectedValue(new Error('Decoder failed'))
    const captured = captureMotionCard(card, { x: 0, y: 0 })
    await expect(captured.prepare(new AbortController().signal, '')).rejects.toThrow('Decoder failed')
    expect(hosts()).toHaveLength(0)
    expect(card.textContent).toBe('Old title')
    expect(card.style.visibility).toBe('')
  })

  it('has a single-use input and idempotent disposal', async () => {
    const captured = captureMotionCard(fixture(), { x: 0, y: 0 })
    const prepared = await captured.prepare(new AbortController().signal, '')
    await expect(captured.prepare(new AbortController().signal, '')).rejects.toThrow('already consumed')
    captured.dispose(); captured.dispose()
    expect(hosts()).toHaveLength(0)
    prepared.assets.forEach(asset => asset.bitmap.close())
  })

  it('rejects oversized targets before allocating a DOM copy', () => {
    const card = fixture()
    vi.spyOn(card, 'offsetWidth', 'get').mockReturnValue(100000)
    expect(() => captureMotionCard(card, { x: 0, y: 0 })).toThrow('texture side budget')
    expect(hosts()).toHaveLength(0)
  })

  it('pins responsive image selection and input values without duplicating document IDs', () => {
    const card = fixture()
    card.insertAdjacentHTML('beforeend', '<img src="old.png" srcset="other.png 2x"><input value="initial">')
    const image = card.querySelector('img')!, input = card.querySelector('input')!
    Object.defineProperty(image, 'currentSrc', { value: 'https://example.test/selected.png' })
    input.value = 'edited'; input.checked = true
    const snapshot = freezeCardDOM(card)
    expect(snapshot.element.querySelector('img')!.src).toBe('https://example.test/selected.png')
    expect(snapshot.element.querySelector('img')!.hasAttribute('srcset')).toBe(false)
    expect(snapshot.element.querySelector('input')!.value).toBe('edited')
    expect(snapshot.element.querySelector('input')!.checked).toBe(true)
    expect(document.querySelectorAll('#live-title')).toHaveLength(1)
    expect(hosts()[0]!.getAttribute('aria-hidden')).toBe('true')
    expect((hosts()[0] as HTMLElement).inert).toBe(true)
    snapshot.dispose()
    expect(hosts()).toHaveLength(0)
  })
})
