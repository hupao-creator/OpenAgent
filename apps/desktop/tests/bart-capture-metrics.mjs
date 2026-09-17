// A native subscription reports delivered images, not presentation timestamps.
// Count independent compositor updates in those SAME images as opportunities
// for product progress. Missing callbacks must never become a product stall.
export const ENVIRONMENT_EXIT = 75
/** A machine can lack the display, the input device or the speed a case needs. Such
 *  a case reports the machine's limit and exits inconclusive; it never reports a
 *  pass, so a case that can run still fails loudly. */
export class EnvironmentLimit extends Error {
  constructor(message) { super(message); this.name = 'EnvironmentLimit' }
}
export class CaptureUnavailable extends EnvironmentLimit {
  constructor(message) { super(message); this.name = 'CaptureUnavailable' }
}
export const environmentInconclusive = error => error instanceof EnvironmentLimit
/** Production declines a flight it cannot prepare inside its own budget, and a
 *  machine too slow to prepare one declines every flight. A case built on landing a
 *  flight reads this limit instead of the regression it would otherwise assert. */
const DECLINED = /Bart preparation exceeded its budget|Bart cross-page admission expired|Bart scene sealing exceeded its budget/
export const admissionDeclined = value => DECLINED.test(value?.errors?.reason ?? '')
/** The same budget reported as a rejected promise rather than a status field. */
export const admissionRefusal = error => DECLINED.test(error?.message ?? '')

export function progress(frames, name) {
  const selected = []
  for (const frame of frames) {
    if (!selected.length || frame.hash.heartbeat !== selected.at(-1).hash.heartbeat) selected.push(frame)
  }
  let stale = 0, maxStale = 0
  for (let index = 1; index < selected.length; index++) {
    stale = selected[index].hash[name] === selected[index - 1].hash[name] ? stale + 1 : 0
    maxStale = Math.max(maxStale, stale)
  }
  return { samples: frames.length, opportunities: selected.length,
    unique: new Set(selected.map(frame => frame.hash[name])).size, maxStale }
}

export function requireCapture(frames, minimum, label) {
  const measured = progress(frames, 'heartbeat')
  if (measured.opportunities < minimum) throw new CaptureUnavailable(`${label}: only ${measured.opportunities}/${minimum} independent compositor samples`)
  return measured
}

export function requireCoverage(frames, start, end, label, calibration) {
  // A burst at the start cannot qualify a whole observation window. These
  // quarters describe coverage only; they are not product millisecond budgets.
  for (let part = 0; part < 4; part++) {
    const from = start + (end - start) * part / 4, to = start + (end - start) * (part + 1) / 4
    // If capture slows dramatically during the block, a small stale-opportunity
    // count could conceal seconds of real freezing. Require at least half the
    // measured control density in EVERY quarter, or decline the measurement.
    const minimum = calibration ? Math.max(2, Math.ceil(calibration.opportunities * (to - from) / calibration.durationMs / 2)) : 2
    requireCapture(frames.filter(frame => frame.at >= from && frame.at < to), minimum, `${label} quarter ${part + 1}`)
  }
}

export function requireProgress(frames, name, minimum, label, reference) {
  // Admission is independent of the product pixels. A frozen product with a
  // healthy heartbeat is always a failure, including a frozen reference run.
  requireCapture(frames, minimum * 2, label)
  const measured = progress(frames, name)
  if (measured.unique < minimum) throw new Error(`${label}: visible flow froze (${measured.unique}/${minimum} distinct frames)`)
  const budget = reference ? 3 * Math.max(1, reference.maxStale) : Math.floor(measured.opportunities / minimum)
  if (measured.maxStale > budget) throw new Error(`${label}: visible flow froze for ${measured.maxStale} compositor updates (control budget ${budget})`)
  return measured
}

export async function calibrateClock(contents) {
  const samples = []
  for (let index = 0; index < 5; index++) {
    const before = performance.now()
    const renderer = await contents.executeJavaScript('performance.timeOrigin + performance.now()')
    const after = performance.now()
    samples.push({ offset: renderer - (before + after) / 2, uncertainty: (after - before) / 2 })
  }
  return samples.sort((a, b) => a.uncertainty - b.uncertainty)[0]
}
