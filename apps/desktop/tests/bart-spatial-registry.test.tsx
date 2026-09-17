import { afterEach, describe, expect, it, vi } from 'vitest'
import { BartSpatialRegistry } from '../src/renderer/src/bart-motion/registry'
import { getOverviewMotionCoordinator } from '../src/renderer/src/overview-motion/coordinator'

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, right: left + width, bottom: top + height, width, height,
  toJSON: () => ({ left, top, width, height })
})
const element = (bounds: DOMRect): HTMLElement => ({
  isConnected: true, getBoundingClientRect: () => bounds
}) as HTMLElement

afterEach(() => getOverviewMotionCoordinator().setCameraView(false, { x: 0, y: 0, scale: 1 }))

describe('semantic card spatial boundary', () => {
  it('captures the actual status and excerpt anchors independently of card layout and freezes each scene', () => {
    const registry = new BartSpatialRegistry()
    registry.setRoot(element(rect(100, 50, 800, 600)))
    registry.registerThreadCard('thread', element(rect(200, 150, 320, 240)))
    let status = rect(451, 177, 42, 30)
    const measure = vi.fn(() => status)
    registry.registerThreadAnchor('thread', 'status', measure)
    registry.registerThreadAnchor('thread', 'excerpt-end', () => rect(398, 281, 0, 0))
    const scene = registry.snapshot()!
    expect(scene.resolve({ type: 'thread', threadId: 'thread', attach: 'status' }))
      .toEqual({ x: 351, y: 127, width: 42, height: 30 })
    expect(scene.resolve({ type: 'thread', threadId: 'thread', attach: 'excerpt-end' }))
      .toEqual({ x: 298, y: 231, width: 0, height: 0 })
    expect(scene.obstacles(new Set())).toEqual([
      { id: 'thread', kind: 'thread-card', rect: { x: 100, y: 100, width: 320, height: 240 } }
    ])
    status = rect(260, 200, 20, 20)
    expect(scene.resolve({ type: 'thread', threadId: 'thread', attach: 'status' })?.x).toBe(351)
    expect(measure).toHaveBeenCalledTimes(1)
    expect(registry.snapshot()!.resolve({ type: 'thread', threadId: 'thread', attach: 'status' })?.x).toBe(160)
  })

  it('maps explicit anchors through camera scale and reports missing anchors instead of guessing CSS offsets', () => {
    const registry = new BartSpatialRegistry()
    registry.setRoot(element(rect(0, 0, 800, 600)))
    registry.registerThreadCard('thread', element(rect(100, 100, 300, 200)))
    expect(registry.snapshot()!.resolve({ type: 'thread', threadId: 'thread', attach: 'status' })).toBeNull()
    getOverviewMotionCoordinator().setCameraView(true, { x: 20, y: 30, scale: 0.5 })
    registry.registerThreadAnchor('thread', 'status', () => rect(120, 130, 20, 10))
    expect(registry.snapshot()!.resolve({ type: 'thread', threadId: 'thread', attach: 'status' }))
      .toEqual({ x: 200, y: 200, width: 40, height: 20 })
    registry.registerThreadAnchor('thread', 'status', null)
    expect(registry.snapshot()!.resolve({ type: 'thread', threadId: 'thread', attach: 'status' })).toBeNull()
  })

  it('routes visibility through the card owner and releases geometry on unmount', () => {
    const registry = new BartSpatialRegistry()
    registry.setRoot(element(rect(0, 0, 800, 600)))
    const setHidden = vi.fn()
    const removed = vi.fn()
    registry.onThreadCardUnregister(removed)
    registry.setThreadGenerationHidden('thread', true)
    registry.registerThreadCard('thread', element(rect(10, 10, 200, 100)), setHidden)
    expect(setHidden).toHaveBeenLastCalledWith(true)
    registry.registerThreadAnchor('thread', 'status', () => rect(20, 20, 10, 10))
    registry.setThreadGenerationHidden('thread', false)
    expect(setHidden).toHaveBeenLastCalledWith(false)
    registry.registerThreadCard('thread', null)
    expect(removed).toHaveBeenCalledWith('thread')
    expect(registry.snapshot()!.resolve({ type: 'thread', threadId: 'thread', attach: 'status' })).toBeNull()
    expect(registry.snapshot()!.obstacles(new Set())).toEqual([])
    registry.setThreadGenerationHidden('thread', false)
    expect(setHidden).toHaveBeenCalledTimes(2)
  })
})
