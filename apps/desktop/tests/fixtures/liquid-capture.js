import { Html, Renderer, Scene } from '@liquid-dom/core'
import { installLiquidCaptureCompat } from '../../src/renderer/src/liquid/capture-compat'

installLiquidCaptureCompat()
const scene = new Scene()
const renderer = new Renderer({ scene })
document.body.append(renderer.canvas)
const makeSubstrate = color => {
  const element = document.createElement('div')
  element.className = 'substrate'
  element.style.background = color
  element.innerHTML = '<div class="plane"><div class="card"></div><div class="card"></div><div class="card"></div></div>'
  return element
}
const html = new Html({ width: innerWidth, height: innerHeight, element: makeSubstrate('#e8edf5') })
scene.add(html)
const state = { blocked: false, failures: 0, copies: 0, presents: 0 }
let repaintCount = 0
const copy = GPUQueue.prototype.copyElementImageToTexture
GPUQueue.prototype.copyElementImageToTexture = function (...args) {
  if (state.blocked) {
    state.failures += 1
    throw new DOMException('No cached paint record for element.', 'InvalidStateError')
  }
  copy.apply(this, args)
  state.copies += 1
}
const present = GPUCanvasContext.prototype.getCurrentTexture
GPUCanvasContext.prototype.getCurrentTexture = function (...args) {
  state.presents += 1
  return present.apply(this, args)
}
window.addEventListener('resize', () => {
  html.width = innerWidth
  html.height = innerHeight
  renderer.render()
})
// Wait for initial GPU capture, then enter demand mode with no frame loop.
const firstFrame = () => {
  if (state.copies === 0) requestAnimationFrame(firstFrame)
  else renderer.render()
}
requestAnimationFrame(firstFrame)
window.liquidFixture = {
  state,
  replace(color) { html.setElement(makeSubstrate(color)); renderer.render() },
  render() { renderer.render() },
  repaint() { html.element.querySelector('.card').style.background = `rgb(72, 123, ${150 + (++repaintCount % 2)})` },
  animate() {
    return html.element.querySelector('.plane').animate([
      { transform: 'translateX(0)' }, { transform: 'translateX(280px)' }
    ], { duration: 360, fill: 'forwards' }).finished
  },
  destroy() { renderer.destroy() }
}
