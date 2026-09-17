import { describe, expect, it } from 'vitest'
import { CaptureUnavailable, requireCoverage, requireProgress } from './bart-capture-metrics.mjs'

const frames = (count, flow = index => index % 17) => Array.from({ length: count }, (_, index) => ({
  at: index * 33, hash: { heartbeat: String(index), flow: String(flow(index)) }
}))

describe('native capture progress evidence', () => {
  it('does not turn delayed/missing callbacks into a product hold', () => {
    const reference = requireProgress(frames(33), 'flow', 10, 'control')
    // Real failure evidence: all 125 delivered frames changed, while the first
    // arrived 107ms after the window boundary. No pixels proved a 107ms hold.
    const delivered = frames(125).map(frame => ({ ...frame, at: frame.at + 107 }))
    expect(requireProgress(delivered, 'flow', 10, 'blocked', reference).maxStale).toBe(0)
  })
  it('fails a permanently frozen control instead of calibrating it away', () => {
    expect(() => requireProgress(frames(33, () => 0), 'flow', 10, 'control')).toThrow(/froze/)
  })
  it('fails a flow that changes ten times and then freezes while the compositor continues', () => {
    const reference = requireProgress(frames(33), 'flow', 10, 'control')
    expect(() => requireProgress(frames(125, index => Math.min(index, 12)), 'flow', 10, 'blocked', reference)).toThrow(/froze for/)
  })
  it('checks recovery independently of successful blocked motion', () => {
    const reference = requireProgress(frames(33), 'flow', 10, 'control')
    requireProgress(frames(125), 'flow', 10, 'blocked', reference)
    expect(() => requireProgress(frames(33, () => 0), 'flow', 10, 'recovery', reference)).toThrow(/froze/)
  })
  it('reports too few independent capture opportunities separately', () => {
    expect(() => requireProgress(frames(6), 'flow', 10, 'blocked')).toThrow(CaptureUnavailable)
    const duplicated = frames(33).map(frame => ({ ...frame, hash: { heartbeat: 'stale', flow: 'stale' } }))
    expect(() => requireProgress(duplicated, 'flow', 10, 'blocked')).toThrow(CaptureUnavailable)
  })
  it('does not qualify a full window from an early capture burst', () => {
    expect(() => requireCoverage(frames(33), 0, 5000, 'blocked')).toThrow(CaptureUnavailable)
    expect(() => requireCoverage(frames(150), 0, 5000, 'blocked')).not.toThrow()
  })
  it('declines a host slowdown that could hide a long freeze behind few opportunities', () => {
    const control = requireProgress(frames(33, index => index < 4 ? 0 : index), 'flow', 10, 'control')
    const slowed = frames(20, index => Math.min(index, 10)).map((frame, index) => ({ ...frame, at: 420 + index * 200 }))
    // The stale count alone would accept this two-second freeze (9 <= 3*3).
    expect(requireProgress(slowed, 'flow', 10, 'blocked', control).maxStale).toBe(9)
    expect(() => requireCoverage(slowed, 420, 4945, 'blocked', { opportunities: 33, durationMs: 1100 })).toThrow(CaptureUnavailable)
  })
})
