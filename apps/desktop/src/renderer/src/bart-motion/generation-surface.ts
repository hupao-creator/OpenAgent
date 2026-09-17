import { createMotionSurface } from './worker-client'

const pools = { scene: new WeakMap<HTMLElement, ReturnType<typeof createPool>>(), 'raster-scene': new WeakMap<HTMLElement, ReturnType<typeof createPool>>() }

/** Keep one associated GPU canvas per live root. Repeated batches reuse its
 * context; deleting a context while Chromium still references its last mailbox
 * can produce a missing-image frame at handoff. Idle scenes release textures. */
function createPool(root: HTMLElement, kind: 'scene' | 'raster-scene') {
  const canvas = document.createElement('canvas')
  canvas.className = 'bart-generation-scene'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.hidden = true
  let renderer: ReturnType<typeof createMotionSurface> | undefined
  let owner: symbol | undefined
  let broken = false
  let onFailure: (() => void) | undefined
  const observer = new MutationObserver(() => {
    if (root.isConnected) return
    broken = true
    onFailure?.()
    renderer?.dispose()
    canvas.remove()
    observer.disconnect()
    if (pools[kind].get(root)?.canvas === canvas) pools[kind].delete(root)
  })
  observer.observe(document.documentElement, { subtree: true, childList: true })
  return {
    canvas,
    prewarm(): void {
      if (renderer || owner || broken) return
      root.append(canvas)
      // Prepare the shared scene context before a user requests a short flight.
      // Keep only a 1px backing store until a scene acquires the viewport.
      renderer = createMotionSurface(canvas, 1, 1, kind, () => { broken = true; onFailure?.() })
      void renderer.ready.catch(() => {
        if (owner) return
        renderer?.dispose()
        canvas.remove()
        observer.disconnect()
        if (pools[kind].get(root)?.canvas === canvas) pools[kind].delete(root)
      })
    },
    acquire(token: symbol, failed: () => void): void {
      if (owner) throw new Error('Bart generation surface is already owned')
      owner = token; onFailure = failed
    },
    renderer(token: symbol, size?: { width: number; height: number }) {
      if (owner !== token) throw new Error('Bart generation surface ownership expired')
      if (!canvas.isConnected) root.append(canvas)
      const rect = size ?? root.getBoundingClientRect()
      renderer ??= createMotionSurface(canvas, rect.width, rect.height, kind, () => { broken = true; onFailure?.() })
      renderer.resize(rect.width, rect.height)
      return renderer
    },
    release(token: symbol): void {
      if (owner !== token) return
      canvas.hidden = true
      if (!broken) {
        renderer?.resetPreparation()
        // Keep the context reusable without reserving an entire hidden viewport
        // alongside the next camera surface. Resize only after the run releases.
        renderer?.resize(1, 1)
      }
      owner = undefined; onFailure = undefined
      delete canvas.dataset.generationState
      canvas.removeAttribute('data-bart-cross-page-flight')
      if (broken) {
        renderer?.dispose()
        canvas.remove()
        observer.disconnect()
        if (pools[kind].get(root)?.canvas === canvas) pools[kind].delete(root)
      }
    }
  }
}

export function generationSurface(root: HTMLElement, kind: 'scene' | 'raster-scene' = 'scene') {
  let pool = pools[kind].get(root)
  if (!pool) { pool = createPool(root, kind); pools[kind].set(root, pool) }
  return pool
}
