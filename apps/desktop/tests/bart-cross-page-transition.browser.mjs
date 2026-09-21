import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

// Run after perf:renderer:build and perf:renderer:serve. Real Chromium is needed:
// the flight's route cannot be replayed from paused animations, because the seat
// it lands on is itself sliding while the page settles. The sampler therefore
// records the live timeline frame by frame instead of stepping `currentTime`.
//
// Both directions are covered here because they are the same journey read
// backwards: out of the Dock into the seat, and back out of the seat onto
// wherever the Dock currently sits. The page is kept light on purpose — a heavier
// Overview drops to a handful of frames a second, and the flight then runs its
// whole route between two samples, which is not enough to read a shape off.
const output = path.resolve(process.env.FLIGHT_EVIDENCE_DIR || 'output/playwright/bart-cross-page-transition')
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1369, height: 994 }, recordVideo: { dir: output, size: { width: 1369, height: 994 } } })
const page = await context.newPage()

const DOCK_LOGO = '.bart-dock .bart-logo'
const SEAT_LOGO = '.bart-host-body .bart-logo'
/** The two directions are different lengths: the settings page closes faster than it opens. */
const OPEN_ROUTE = 760
const CLOSE_ROUTE = 560
const OVERVIEW_URL = process.env.FLIGHT_PREVIEW_URL || 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4'
/** A thread view: the Overview is not rendered, but its Dock is still mounted. */
const THREAD_URL = 'http://localhost:4177/renderer.html?mode=background&harness=codex&threads=8&turns=4'
/** Two coordinators on the machine, so one can be switched for the other. */
const HOST_SWITCH_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&installed=codex,claude'
/**
 * The Bart tab renders no coordinator seat when the coordinator is not installed,
 * so this page has no landing target. Bart still runs on codex here — only the
 * roster the probe reports is narrowed, which is what a user sees after moving a
 * machine's binary away from under a saved coordinator.
 */
const NO_SEAT_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&installed=claude'
/**
 * The installation probe takes its time answering. Until it does, the settings
 * page reads every Harness as installed, so the coordinator seat is laid out
 * across the whole roster and slides once the missing ones drop out — during the
 * flight, and after the route has run out.
 */
const PROBE_DELAY_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&probeDelay=900'
/**
 * A probe that outlasts the copy's patience. 2200ms is how long it used to wait
 * for a seat to stop moving before handing over regardless; a login shell refresh
 * is allowed 4s on its own, so a probe answering this late is ordinary rather than
 * pathological.
 */
const SLOW_PROBE_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&probeDelay=3600'
/**
 * The same late seat, answering early. The arch only has height while the route
 * is still shortening — by the time the ease has run out it is exactly zero at
 * both ends — so a crossing that is to say anything about the arch's side has to
 * fall in the first few hundred milliseconds. The seat's slide is 720ms long
 * whatever the probe does; only when it starts is ours to choose.
 */
const CROSSING_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&probeDelay=120'
/**
 * How far past the seat's provisional place the Dock is parked for that crossing.
 * Clear of it, so the route the copy flies has a direction to take and a normal to
 * bow along — parked on the seat's own column the two ends are stacked and neither
 * is well defined. Swept from 0 to 130px, it makes no difference worth having: the
 * seats cross at 3.5 to 27px of the ~63px bow either way, because the seat's slide
 * and the copy's route do not line up on this page. What the crossing is here to
 * show is the arch's side, which is read over the whole flight; the height left at
 * the crossing only has to be enough to rule out a flat reading.
 */
const CROSSING_PARK_OFFSET = 60
/** Some scenarios can only get in by shortcut, and the app watches `ctrlKey` off macOS. */
const SHORTCUT_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control'
/**
 * A Dock that is *wearing* something rather than idling: `bartOps` seeds one of
 * Bart's own tool operations, which is what gives the mark an expression of its
 * own to be carried. Nothing else in the app can put a face on a seat that is not
 * already flying.
 */
const OPS_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&bartOps=list'
/**
 * A Dock dressed by the *page* rather than by an operation of its own: a
 * foreground call on the coordinator with no route of Bart's turns the mark into
 * a tool, and `bart-role.css` shifts and squashes the face for as long as it
 * lasts. It is the one dressing that lands on the face layer from outside the
 * logo, so it is the one a copy that only carried the expression would lose.
 */
const ROLE_URL = 'http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=8&turns=4&bartRole=tool'

/**
 * Records whether the flight layer ever mounts, so a skipped flight can be
 * proven absent over the whole reveal rather than absent at one sampled instant.
 */
const watchForLayer = (target) => target.evaluate(() => {
  window.__sawLayer = Boolean(document.querySelector('[data-bart-cross-page-flight]'))
  new MutationObserver(() => {
    if (document.querySelector('[data-bart-cross-page-flight]')) window.__sawLayer = true
  }).observe(document.body, { childList: true, subtree: true })
})

/**
 * Mirrors the renderer's own measurement: the drawn ink, in viewport pixels. All
 * four corners, as `inkBoxFromCorners` does — two opposite corners of a box span
 * less than the box once a rotation is in play, and a host gesture turns an
 * ancestor of the coordinator's logo by up to 11°.
 */
const INK = `(element) => {
  if (!element || !element.isConnected) return null
  const matrix = element.getScreenCTM()
  if (!matrix) return null
  const box = element.getBBox()
  if (!box.width || !box.height) return null
  const points = [
    [box.x, box.y], [box.x + box.width, box.y],
    [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]
  ].map(([x, y]) => ({
    x: matrix.a * x + matrix.c * y + matrix.e,
    y: matrix.b * x + matrix.d * y + matrix.f
  }))
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  }
}`

/**
 * What a `BartLogo` is *drawing*, as opposed to where it is. Every number here is
 * in the logo's own 640-unit viewBox — the body outline, the eyes, the satellites'
 * opacity and radius — so the same expression reads identically at the Dock's 400
 * units, the copy's 210 and the seat's 72. The ink box cannot answer this: a seat
 * caught mid-gesture and a resting seat the copy never left read the same size
 * once the route's own scale is applied, and "the copy is wearing the frame it was
 * handed" is exactly the claim an ink box cannot make.
 */
const POSE = `(element) => {
  const svg = element && element.isConnected
    ? (element.tagName === 'svg' ? element : element.querySelector('svg'))
    : null
  if (!svg) return null
  const body = svg.querySelector('.bart-bot > path')
  const orbits = svg.querySelector('.bart-orbits')
  const dot = svg.querySelector('.bart-status-dot')
  return {
    // In user units, so two logos of different element sizes are comparable.
    body: body ? body.getAttribute('d') : null,
    eyes: [...svg.querySelectorAll('.bart-face rect')].map((eye) =>
      ['x', 'y', 'width', 'height'].map((name) => Number(eye.getAttribute(name)))),
    // The satellite ring lives on a style attribute rather than a property.
    orbit: orbits ? Number(/([\\d.]+)/.exec(orbits.getAttribute('style') || '')?.[1] ?? 0) : 0,
    thought: dot ? Number(dot.getAttribute('r')) : 0
  }
}`

/**
 * The page's own dressing on a logo's face, in the logo's own user units: the
 * role squash `bart-role.css` applies to a Dock wearing a tool, or the gaze the
 * coordinator's idle and acknowledgment gestures translate it by. A seat is
 * dressed on the face proper and its frame is inert, so there the dressing is the
 * layer's transform inside the frame. The copy is dressed the other way round —
 * on the frame, because the face proper is already carrying the expression's own
 * gesture — so the same reading is taken from the frame's parent instead, and the
 * two are the same matrix: what the page moved the face by.
 */
const DRESSING = `(element) => {
  const svg = element && element.isConnected
    ? (element.tagName === 'svg' ? element : element.querySelector('svg'))
    : null
  const layer = svg && svg.querySelector('.bart-face')
  const frame = svg && svg.querySelector('.bart-face-frame')
  if (!layer || !frame) return null
  const face = layer.getScreenCTM()
  const around = frame.getScreenCTM()
  if (!face || !around) return null
  return asNumbers(around.inverse().multiply(face))
}`

/** The dressing a *copy* is wearing, which the flight writes on the frame. */
const CARRIED_DRESSING = `(svg) => {
  const frame = svg && svg.querySelector('.bart-face-frame')
  const parent = frame && frame.parentElement
  if (!frame || !parent) return null
  const around = parent.getScreenCTM()
  const worn = frame.getScreenCTM()
  if (!around || !worn) return null
  return asNumbers(around.inverse().multiply(worn))
}`

/** A `DOMMatrix` as plain numbers, so it survives being handed back out of the page. */
const READ_MATRIX = `(matrix) => ({
  a: +matrix.a.toFixed(4), b: +matrix.b.toFixed(4), c: +matrix.c.toFixed(4),
  d: +matrix.d.toFixed(4), e: +matrix.e.toFixed(2), f: +matrix.f.toFixed(2)
})`

/**
 * The half of a role that no matrix carries. `bart-role.css` draws a tool's
 * thought dot in the role's own green and locks its eyes upright, and both are
 * child rules keyed on the role — a copy that carries the face's transform and
 * not the role itself leaves with the mark's own blue dot and its eyes springing
 * back open. Read as computed values, because that is where the two rules meet:
 * the eye rotation is an attribute and the lock is a stylesheet.
 */
const CHROME = `(element) => {
  const svg = element && element.isConnected
    ? (element.tagName === 'svg' ? element : element.querySelector('svg'))
    : null
  if (!svg) return null
  const dot = svg.querySelector('.bart-status-dot')
  const eye = svg.querySelector('.bart-face rect')
  return {
    role: svg.getAttribute('data-role'),
    dot: dot ? getComputedStyle(dot).fill : null,
    eye: eye ? getComputedStyle(eye).transform : null
  }
}`

const inkOf = (selector) => page.evaluate(`(() => { const ink = ${INK}; return ink(document.querySelector(${JSON.stringify(selector)})) })()`)
const dressingOf = (selector) => page.evaluate(`(() => {
  const asNumbers = ${READ_MATRIX}
  const dress = ${DRESSING}
  return dress(document.querySelector(${JSON.stringify(selector)}))
})()`)
const poseOf = (selector) => page.evaluate(`(() => {
  const pose = ${POSE}
  return pose(document.querySelector(${JSON.stringify(selector)}))
})()`)

/** Every number a path is drawn from, in order. */
const pathNumbers = (path) => (path ?? '').match(/-?\d+\.?\d*/g)?.map(Number) ?? []

/**
 * How far apart two drawings are, as the largest single coordinate they disagree
 * by — the body outline and the eyes together. The unit is the logo's own user
 * units, where the body is about 300 across: a couple of units is the frame of
 * spring between two renderers stepping the same motion, and a different
 * expression is tens.
 */
const poseGap = (left, right) => {
  if (!left || !right) return Infinity
  const numbers = pathNumbers(left.body)
  const other = pathNumbers(right.body)
  if (!numbers.length || numbers.length !== other.length) return Infinity
  const body = Math.max(...numbers.map((value, index) => Math.abs(value - other[index])))
  const eyes = Math.max(...[0, 1].map((eye) =>
    Math.max(...[0, 1, 2, 3].map((part) =>
      Math.abs((left.eyes[eye]?.[part] ?? 0) - (right.eyes[eye]?.[part] ?? 0))))))
  return Math.max(body, eyes)
}
/** A face the page has dressed with nothing: the layer sits where the frame drew it. */
const IDENTITY_DRESSING = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/**
 * How far apart two dressings are. The scale components are compared as they
 * stand and the shift is divided by ten before it joins them, so one number ranks
 * a squash against a translate: a tenth of a unit of scale is a ten-pixel slide.
 * Two readings of the same dressing sit within a few hundredths (the seat's
 * gesture moving between the two frames they were read on); a role squash against
 * an undressed face is 0.4 of scale, and a held gaze against a resting face is
 * tens of pixels.
 */
const dressingGap = (left, right) => {
  if (!left || !right) return Infinity
  return Math.max(
    Math.abs(left.a - right.a), Math.abs(left.b - right.b),
    Math.abs(left.c - right.c), Math.abs(left.d - right.d),
    Math.hypot(left.e - right.e, left.f - right.f) / 10
  )
}

const sleep = (ms) => page.evaluate((wait) => new Promise((resolve) => setTimeout(resolve, wait)), ms)

/**
 * Where the coordinator seat is first drawn, before the roster collapses and its
 * slide begins. The one crossing scenario has to park the Dock just past this, so
 * it is measured rather than written down: the place is a product of how many
 * Harnesses the roster is drawn for, and moves whenever one is added or removed.
 * A Dock parked on the wrong side of it leaves the scenario asserting a crossing
 * that never happens.
 */
const seatProvisionalPlace = async () => {
  await page.goto(CROSSING_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  await page.evaluate(`(() => {
    const ink = ${INK}
    window.__seatPlace = null
    const tick = () => {
      const box = ink(document.querySelector(${JSON.stringify(SEAT_LOGO)}))
      if (box) { window.__seatPlace = box; return }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForFunction('window.__seatPlace !== null', undefined, { polling: 'raf', timeout: 8000 })
  return page.evaluate('window.__seatPlace')
}

/**
 * Waits for the seat to stop drawing the box it holds at rest. A gesture turns or
 * leans the character, which makes the drawn box taller or narrower; where the box
 * sits cannot answer this, because the anchor slides it around for reasons of its
 * own. Waiting for the deviation rather than sleeping a fixed beat keeps the
 * scenario honest at whatever rate the settings page is running.
 */
const waitForSeatGesture = async (rest, gap) => (await page.waitForFunction(`(() => {
  const ink = ${INK}
  const box = ink(document.querySelector(${JSON.stringify(SEAT_LOGO)}))
  if (!box) return null
  return Math.max(Math.abs(box.width - ${rest.width}), Math.abs(box.height - ${rest.height})) > ${gap}
    ? box : null
})()`, undefined, { polling: 'raf', timeout: 8000 })).jsonValue()

/**
 * Records the live flight one frame at a time. The copy's transform is written
 * from the flight's own rAF callback, so reading in ours would sample the
 * previous frame's placement; a nested timeout lands after every rAF callback of
 * the frame, so both boxes are read as this frame leaves them.
 */
const installSampler = (ends, detail = false) => page.evaluate(`(() => {
  const ink = ${INK}
  const pose = ${POSE}
  const asNumbers = ${READ_MATRIX}
  const dress = ${DRESSING}
  const carried = ${CARRIED_DRESSING}
  const chrome = ${CHROME}
  const ends = ${JSON.stringify(ends)}
  // Reading a mark's own drawing costs four queries a frame per seat, and the
  // scenarios that never look at one would be paying for it on the very page the
  // flight's own timing is being read off.
  const detail = ${detail}
  const matrixOf = (element) => {
    if (!element) return null
    const value = getComputedStyle(element).transform
    return value === 'none' ? null : new DOMMatrixReadOnly(value)
  }
  const visible = (element) => (element ? getComputedStyle(element).visibility === 'visible' : null)
  window.__flight = { samples: [], stop: false }
  const started = performance.now()
  const read = () => {
    const source = document.querySelector(ends.source)
    const target = document.querySelector(ends.target)
    const held = document.querySelector(ends.held)
    const copy = document.querySelector('.bart-cross-page-flight-copy')
    const placement = matrixOf(copy)
    const bank = matrixOf(document.querySelector('.bart-cross-page-flight-bank'))
    const torso = matrixOf(copy && copy.querySelector('.bart-body-motion'))
    const eyes = matrixOf(copy && copy.querySelector('.bart-face'))
    window.__flight.samples.push({
      t: performance.now() - started,
      copy: ink(copy && copy.querySelector('svg')),
      source: source ? ink(source) : null,
      target: target ? ink(target) : null,
      // Read beside the ink and in the same tick: the copy's own drawing, and the
      // drawings of the two seats it is between, so a pose can be held against the
      // seat on that very frame rather than against one taken a beat earlier.
      copyPose: detail ? pose(copy && copy.querySelector('svg')) : null,
      sourcePose: detail ? pose(source) : null,
      targetPose: detail ? pose(target) : null,
      // The page's own dressing on all three faces, read beside the poses: what the
      // copy is wearing as it flies, and what each seat is wearing on that frame.
      copyDressing: detail ? carried(copy && copy.querySelector('svg')) : null,
      sourceDressing: detail ? dress(source) : null,
      targetDressing: detail ? dress(target) : null,
      // The copy's role chrome, and the seat it is standing in for on the same
      // frame: a role that arrives late or not at all shows up as a dot that
      // changes colour mid-air, which no other reading here would catch.
      copyChrome: detail ? chrome(copy && copy.querySelector('svg')) : null,
      sourceChrome: detail ? chrome(source) : null,
      activity: detail
        ? document.querySelector(ends.target)?.closest('[data-activity]')?.getAttribute('data-activity') ?? null
        : null,
      heldVisible: visible(held),
      // Straight off the copy's own transform: the roll and the performance ride
      // other layers, so this is the route's own scale and nothing else.
      scale: placement ? Math.hypot(placement.c, placement.d) : null,
      bank: bank ? Math.atan2(bank.b, bank.a) * 180 / Math.PI : null,
      // The performance's two animated layers, in the logo's own units: a is the
      // torso's stretch, e its sideways carry, f its crouch and lift.
      torso: torso ? { a: torso.a, e: torso.e, f: torso.f } : null,
      eyes: eyes ? { a: eyes.a, e: eyes.e, f: eyes.f } : null,
      // The host badge, read in the same tick as the copy — a sample holding both
      // is the criterion's "same frame", not a race the sampler could lose.
      mark: visible(document.querySelector('.bart-host-engine-mark')),
      page: Boolean(document.querySelector('.settings-page'))
    })
  }
  const tick = () => {
    // Registered before the flight's own callback, so this reads the copy as the
    // frame found it — on the first frame of the flight, that is the takeoff
    // placement, before any advance.
    const copySvg = document.querySelector('.bart-cross-page-flight-copy svg')
    const atFrameStart = ink(copySvg)
    if (atFrameStart && !window.__flight.takeoff) {
      window.__flight.takeoff = atFrameStart
      // The frame the copy was first seen *drawing*, so "the copy opened on the
      // seat's own pose" can be read off the record rather than inferred. The seat
      // is read here too, off the same frame start: a pose read a tick later would
      // be a different frame of a gesture that is still running.
      if (detail) {
        window.__flight.takeoffPose = pose(copySvg)
        window.__flight.takeoffSourcePose = pose(document.querySelector(ends.source))
        // The dressing the copy opened wearing, and the seat's own on the same frame:
        // "the copy continues the face the seat was dressed with" is read here rather
        // than from a box taken before the click, which a gesture moves between.
        window.__flight.takeoffDressing = carried(copySvg)
        window.__flight.takeoffSourceDressing = dress(document.querySelector(ends.source))
        // The role the copy was *first drawn* wearing, and the source's own on the
        // same instant: a role that only arrives at the aim mark is caught here as
        // a copy that opened without it.
        window.__flight.takeoffChrome = chrome(copySvg)
        window.__flight.takeoffSourceChrome = chrome(document.querySelector(ends.source))
        // The seat's box on that same instant, so the copy's opening placement can
        // be held against the box it was mapped onto rather than against the box
        // the seat had left by the end of the frame.
        window.__flight.takeoffSourceInk = ink(document.querySelector(ends.source))
      }
      // The frame the copy was first seen on, so the flight's own duration can be
      // read off the record instead of guessed from when the sampler caught up.
      window.__flight.takeoffAt = performance.now() - started
    }
    setTimeout(read, 0)
    if (!window.__flight.stop && performance.now() - started < 5000) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
})()`)

const collect = () => page.evaluate(() => {
  window.__flight.stop = true
  return {
    samples: window.__flight.samples,
    takeoff: window.__flight.takeoff,
    takeoffPose: window.__flight.takeoffPose ?? null,
    takeoffSourcePose: window.__flight.takeoffSourcePose ?? null,
    takeoffSourceInk: window.__flight.takeoffSourceInk ?? null,
    takeoffDressing: window.__flight.takeoffDressing ?? null,
    takeoffSourceDressing: window.__flight.takeoffSourceDressing ?? null,
    takeoffChrome: window.__flight.takeoffChrome ?? null,
    takeoffSourceChrome: window.__flight.takeoffSourceChrome ?? null,
    takeoffAt: window.__flight.takeoffAt ?? null
  }
})

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const describe = (box) => box && `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`

/** Where along its route the copy sits: 0 at takeoff, 1 at the seat. */
function alongRoute(sample) {
  const start = center(sample.source)
  const end = center(sample.target)
  const point = center(sample.copy)
  const dx = end.x - start.x
  const dy = end.y - start.y
  return ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx ** 2 + dy ** 2)
}

/**
 * How far the copy is bowed off the route, positive on the side it bows towards.
 *
 * Each frame's offset is taken from the seats that frame drew — the destination
 * slides underneath the copy as the page settles, and a line drawn to where it
 * ended up would read that slide as a bow. But the side it is signed against is
 * the one the flight left with, because that is the direction the arch was dealt
 * and the one it keeps: measured against the live line instead, a destination that
 * slides across the source's own column turns the line over mid-flight and the
 * reading flips sign without the copy having moved any more than it was told to.
 * A negative reading therefore means the copy really did cross to the far side.
 */
function pinnedBowSide(samples) {
  const first = samples[0]
  const start = center(first.source)
  const dx = center(first.target).x - start.x
  const dy = center(first.target).y - start.y
  const length = Math.hypot(dx, dy) || 1
  const normal = dx < 0 ? { x: -dy / length, y: dx / length } : { x: dy / length, y: -dx / length }
  return samples.map((sample) => {
    const at = alongRoute(sample)
    const from = center(sample.source)
    const to = center(sample.target)
    const point = center(sample.copy)
    const residual = {
      x: point.x - (from.x + at * (to.x - from.x)),
      y: point.y - (from.y + at * (to.y - from.y))
    }
    return residual.x * normal.x + residual.y * normal.y
  })
}

/**
 * The shape both flights share: the copy continues the real Bart it left, meets
 * the one it is landing on, and hands over without a frame of daylight between
 * the two — a beat where neither is on screen reads as a flicker.
 */
function assertFlight({ label, samples, takeoff, takeoffAt, duration, originInk, landed, growing, badgeAppears }) {
  const airborne = samples.filter((sample) => sample.copy)
  const touchdown = airborne.at(-1)
  const afterLastCopy = samples[samples.indexOf(touchdown) + 1]

  // Enough frames to read a shape off, not a target count: see the note on the
  // beats below for why the return is thin. Snapping straight from one seat to the
  // other is one or two frames, which this still rules out.
  assert.ok(airborne.length > 4, `${label}: the copy must be seen travelling, saw ${airborne.length} frames`)
  // The open and the close are different lengths, so the flight's own clock is read
  // from the frame the copy was first seen on rather than from the first one the
  // sampler caught. Both the sighting of the takeoff and the sighting of the
  // handover can each sit a whole sampler frame inside the real route, so the span
  // read here under-reports it by up to the two intervals around it.
  //
  // A coarse floor, not a budget: the landing check below is what rules out a route
  // cut short, since a copy handed over mid-route cannot be sitting on the seat. What
  // this adds is the blunter failure — a flight ended by a stale callback while the
  // copy was still most of a page away from where it was going.
  //
  // The allowance is the span the sampler could not see, which is an interval at each
  // end rather than a fixed number of milliseconds: this page paints at around ten
  // frames a second while the settings page is revealing, and a single unseen end has
  // been read at 133ms on a loaded machine, so a fixed budget tight enough to mean
  // anything is one that a slow pass fails on a flight that was perfectly good. It is
  // capped at half the route instead, so it cannot grow with the load until it swallows
  // the truncation it is there to catch.
  assert.ok(takeoff, `${label}: the copy must be caught at takeoff`)
  const firstAirborne = samples.indexOf(airborne[0])
  const missedBefore = firstAirborne > 0 ? airborne[0].t - samples[firstAirborne - 1].t : 0
  const missedAfter = afterLastCopy.t - touchdown.t
  const flown = touchdown.t - takeoffAt
  const unseen = Math.min(missedBefore + missedAfter, duration / 2)
  assert.ok(flown >= duration - unseen,
    `${label}: the copy must fly most of its ${duration}ms route, handed over after ${flown.toFixed(0)}ms (+${missedBefore.toFixed(0)}ms unseen before, +${missedAfter.toFixed(0)}ms after, ${unseen.toFixed(0)}ms allowed for)`)
  assert.ok(distance(center(takeoff), center(originInk)) < 1, `${label}: takeoff must continue the empty seat (${describe(takeoff)} vs ${describe(originInk)})`)
  assert.ok(distance(center(touchdown.copy), center(touchdown.target)) < 1, `${label}: landing must meet the destination (${describe(touchdown.copy)} vs ${describe(touchdown.target)})`)
  // To within a pixel rather than exactly: the seat creeps on its own `left`
  // transition while the route finishes, and the flight hands over as soon as a
  // frame moves it less than half a pixel — so a residual pixel of creep is what
  // the takeover is expected to leave behind, not a fault. A real gap would be the
  // whole distance between the seats.
  assert.ok(distance(center(landed), center(touchdown.copy)) < 2, `${label}: the real Bart must take over where the copy stopped (${describe(landed)} vs ${describe(touchdown.copy)})`)

  const travelled = Math.max(...airborne.map((sample) => distance(center(sample.copy), center(takeoff))))
  assert.ok(travelled > 100, `${label}: the copy must actually cross the page (travelled ${travelled.toFixed(1)}px)`)
  assert.ok(airborne.some((sample) => distance(center(sample.copy), center(takeoff)) > 20 && distance(center(sample.copy), center(touchdown.copy)) > 20), `${label}: the copy must be seen between the two seats, not snapped from one to the other`)

  for (const [index, sample] of airborne.entries()) {
    assert.equal(sample.heldVisible, false, `${label} frame ${index}: the destination must stay empty until the copy arrives`)
    // The badge lives inside the seat the copy is flying to, so it must stay down
    // for exactly as long as the copy is up — no frame may carry both.
    assert.notEqual(sample.mark, true, `${label} frame ${index}: the host badge must not be on screen while the copy is`)
    if (index === 0) continue
    // The route's own scale, not the measured ink box: the roll tilts the box,
    // and reading the box would mistake a lean for the route growing. The
    // tolerance is for the destination, which is measured live and grows a few
    // percent through its own reveal — the copy follows it, so it is not strictly
    // monotone frame to frame. A snap to the far end would be a jump of a third of
    // the span, so the check still tells a flown route from a cut one.
    const previous = airborne[index - 1].scale
    assert.ok(growing ? sample.scale >= previous - .01 : sample.scale <= previous + .01,
      `${label} frame ${index}: the copy must ${growing ? 'grow' : 'shrink'} along the way (${sample.scale} after ${previous})`)
  }
  assert.equal(afterLastCopy.heldVisible, true, `${label}: the destination must appear the moment the copy is gone, not a beat later`)
  assert.equal(afterLastCopy.page === false, label === 'return', `${label}: the page must be gone exactly when the return lands`)
  if (badgeAppears) {
    assert.equal(afterLastCopy.mark, true, `${label}: the host badge must come up on the frame after the copy lands, not a beat later`)
  }

  // 轨迹: a straight line with one arch in the middle of it. Read at the crest the
  // sampler actually caught, so a slow frame cannot move the reading off it.
  const bows = pinnedBowSide(airborne)
  const crest = bows.indexOf(Math.max(...bows))
  const bow = bows[crest]
  const crestAt = alongRoute(airborne[crest])
  // The floor sits well under the arch's real height (64px) because the crest is
  // read off whichever frame the sampler caught, and this harness runs the settings
  // page at around ten frames a second: on a slow pass the nearest sample can sit a
  // fifth of the route away from the middle and read 36px. The height itself is
  // pinned analytically in bart-cross-page-flight.test.ts; what this asserts is that
  // the copy is off the line at all, and on the side it was dealt — both of which a
  // broken route misses by tens of pixels, not by four.
  assert.ok(bow > 30 && bow < 80, `${label}: the route must arch 30-80px over the line at its crest, saw ${bow.toFixed(1)}px`)
  assert.ok(crestAt > .2 && crestAt < .8, `${label}: the crest must sit mid-route rather than off one end (${crestAt.toFixed(2)})`)
  // and it is an arch rather than a ripple: the bow climbs to the crest and comes
  // back down, leaving nothing behind at either seat. (The takeoff frame itself is
  // not sampled — the click blocks the main thread past it — so the shape of the
  // sampled curve, not its first value, is what says the ends are on the line.)
  // Sub-pixel movements are dropped: a live measurement of a sliding seat wobbles
  // by a fraction of a pixel as the arch flattens out, and counting that wobble as
  // a turn would read the settling of the route as a second hump.
  const moves = bows.slice(1).map((value, index) => value - bows[index]).filter((value) => Math.abs(value) > 1)
  const turns = moves.slice(1).filter((value, index) => Math.sign(value) !== Math.sign(moves[index]))
  assert.ok(turns.length <= 1, `${label}: the route must arch once, not ripple (${turns.length} changes of direction)`)
  assert.ok(Math.abs(bows.at(-1)) < 3, `${label}: the arch must have flattened out by the landing (${bows.at(-1).toFixed(1)}px)`)

  // 表演: the torso and the eyes are animated layers of their own, in the logo's
  // own units, and both are back at rest by the time the copy is handed over.
  const torso = airborne.map((sample) => sample.torso)
  const eyes = airborne.map((sample) => sample.eyes)
  assert.ok(torso.every(Boolean) && eyes.every(Boolean), `${label}: the performance must ride layers of its own`)
  // `f` is the torso's own vertical: it lifts along the route and compresses into
  // the landing. `e` is its sideways carry, which is the direction of travel. Only
  // the lift is asserted here. The crouch and the landing compress are each a hump
  // narrower than a frame at the frame rate this path renders — the settings page
  // holds the browser to about ten frames a second, so the whole 560ms return is
  // five or six samples and which beat they land on is luck. The shape of both
  // beats, and that the crouch comes before the climb, are pinned by the unit tests.
  const press = torso.map((frame) => frame.f)
  assert.ok(press.some((value) => value < -4), `${label}: the torso must lift along the route`)
  // Only once the route's own clock has run out, because that frame is not always
  // one that gets painted: the flight writes its last placement and drops the copy
  // in the same callback, so the frame that carries the torso to rest is the one
  // the sampler cannot see. Where the seat settles early the last painted frame
  // still holds the landing compress — which is the beat that hands over to the
  // host mark's own landing animation, so it is the design, not a leftover.
  if (touchdown.t - takeoffAt >= duration) {
    assert.ok(Math.abs(torso.at(-1).a - 1) < .03 && Math.abs(press.at(-1)) < 3,
      `${label}: the torso must come back to rest when it lands, not still bouncing (scale ${torso.at(-1).a.toFixed(3)}, press ${press.at(-1).toFixed(2)})`)
  }
  const carry = torso.reduce((peak, frame) => (Math.abs(frame.e) > Math.abs(peak) ? frame.e : peak), 0)
  assert.ok(Math.abs(carry) > 6, `${label}: the torso must carry along the route (${carry.toFixed(1)})`)
  // The eyes flick towards the destination over a beat about thirty milliseconds
  // wide — a fifth of the way into their first keyframe — and are back at the front
  // for the cruise. That beat is narrower than the gap between the frames this page
  // paints, so whether any sample lands inside it at all is luck, and the reading
  // is written as the one thing every sample can answer: the eyes are never turned
  // away from the destination. A track built the wrong way round reads the wrong
  // way on every frame it is caught on. The flick's own height, its mirror image in
  // the other direction, and its return to the front are pinned in
  // bart-cross-page-flight.test.ts.
  const glance = eyes.reduce((peak, frame) => (Math.abs(frame.e) > Math.abs(peak.e) ? frame : peak))
  // Aimed at the destination as the copy found it, which is the direction the
  // performance was built with. Where the seat slides past the copy's own column
  // the two disagree, and the takeoff reading is the one that is continuous.
  const opening = samples.find((sample) => sample.target)?.target ?? landed
  const aim = Math.sign(center(opening).x - center(takeoff).x)
  assert.ok(Math.sign(glance.e) * aim >= 0,
    `${label}: the glance must aim at the destination, not away from it (${glance.e.toFixed(1)}, route runs ${aim > 0 ? 'right' : 'left'})`)

  const lean = airborne.reduce((peak, sample) => (Math.abs(sample.bank) > Math.abs(peak) ? sample.bank : peak), 0)
  assert.ok(Math.abs(lean) > 2, `${label}: the body must lean into the journey (${lean.toFixed(2)}deg)`)

  return { airborne: airborne.length, travelled, bow, crestAt, lean }
}

const observations = []
try {
  await page.goto(OVERVIEW_URL)
  await page.waitForSelector(DOCK_LOGO)
  // The Dock settles in over its own reveal; sample a few frames so the takeoff
  // reading is the resting Dock rather than a frame mid-arrival.
  await sleep(900)
  const dockAtRest = await inkOf(DOCK_LOGO)
  assert.ok(dockAtRest, 'the Dock must draw ink to fly from')

  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  // The page reveals through a `clip-path` on its own root, so the copy has to be
  // a sibling that outranks it — nested, or clipped to the growing circle; lower,
  // or dimmed by the page's `backdrop-filter` until the instant it lands.
  const stacking = await page.evaluate(() => {
    const layer = document.querySelector('.bart-cross-page-flight')
    const settings = document.querySelector('.settings-page')
    return {
      nested: settings.contains(layer),
      layerZ: Number(getComputedStyle(layer).zIndex),
      pageZ: Number(getComputedStyle(settings).zIndex)
    }
  })
  assert.equal(stacking.nested, false, 'the flight layer must be a sibling of the settings page, not a child of it')
  assert.ok(stacking.layerZ > stacking.pageZ, `the flight layer must outrank the page (${stacking.layerZ} vs ${stacking.pageZ})`)
  await page.screenshot({ path: path.join(output, 'outbound-takeoff.png') })
  // Catch the copy mid-route for the visual record; the sampler owns the numbers.
  await sleep(300)
  await page.screenshot({ path: path.join(output, 'outbound-mid-air.png') })
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(900)
  const outbound = await collect()
  const seatAtRest = await inkOf(SEAT_LOGO)
  await page.screenshot({ path: path.join(output, 'outbound-landed.png') })
  const outboundObservation = {
    label: 'outbound', origin: dockAtRest, destination: seatAtRest, landing: seatAtRest,
    ...outbound, layerGone: await page.evaluate(() => !document.querySelector('[data-bart-cross-page-flight]'))
  }
  // Recorded before the verdict, so a failed assertion still leaves the frames it
  // failed on in samples.json rather than only the ones that passed.
  observations.push(outboundObservation)
  outboundObservation.result = assertFlight({
    label: 'outbound', samples: outbound.samples, takeoff: outbound.takeoff, takeoffAt: outbound.takeoffAt,
    duration: OPEN_ROUTE, originInk: dockAtRest, landed: seatAtRest, growing: false, badgeAppears: true
  })

  // Close once without watching, then drag the Dock somewhere of our choosing:
  // the return has to land wherever the Dock is now, not where it started.
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.settings-page', { state: 'detached' })
  await sleep(400)
  const grip = await page.evaluate(() => {
    const box = document.querySelector('.bart-dock-drag-surface').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
  await page.mouse.move(grip.x, grip.y)
  await page.mouse.down()
  await page.mouse.move(grip.x - 320, grip.y - 160, { steps: 12 })
  await page.mouse.up()
  await sleep(400)
  const dockMoved = await inkOf(DOCK_LOGO)
  assert.ok(distance(center(dockMoved), center(dockAtRest)) > 100, `the Dock must have been dragged away from home (${describe(dockMoved)} vs ${describe(dockAtRest)})`)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  // Let the reveal finish and the coordinator's own seat stop sliding before the
  // close, so the return starts from a resting seat.
  await sleep(1600)
  const seatBeforeReturn = await inkOf(SEAT_LOGO)
  await installSampler({ source: SEAT_LOGO, target: DOCK_LOGO, held: '.bart-dock' })
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  await page.screenshot({ path: path.join(output, 'return-takeoff.png') })
  await sleep(300)
  await page.screenshot({ path: path.join(output, 'return-mid-air.png') })
  await page.waitForSelector('.settings-page', { state: 'detached' })
  await sleep(600)
  const returning = await collect()
  const dockLanded = await inkOf(DOCK_LOGO)
  await page.screenshot({ path: path.join(output, 'return-landed.png') })
  const returnObservation = {
    label: 'return', origin: seatBeforeReturn, destination: dockMoved, landing: dockLanded,
    ...returning, layerGone: await page.evaluate(() => !document.querySelector('[data-bart-cross-page-flight]'))
  }
  observations.push(returnObservation)
  returnObservation.result = assertFlight({
    label: 'return', samples: returning.samples, takeoff: returning.takeoff, takeoffAt: returning.takeoffAt,
    duration: CLOSE_ROUTE,
    originInk: seatBeforeReturn, landed: dockLanded, growing: true, badgeAppears: false
  })
  assert.ok(distance(center(dockLanded), center(dockMoved)) < 1, `the return must land on the Dock's current rect, not its home (${describe(dockLanded)} vs ${describe(dockMoved)})`)
  // 身体沿运动切线: the same journey read backwards, so the lean has to reverse.
  assert.ok(observations[0].result.lean * observations[1].result.lean < 0,
    `the two directions must lean opposite ways (${observations[0].result.lean.toFixed(2)}deg out, ${observations[1].result.lean.toFixed(2)}deg back)`)

  // An invalidated flight has to end the way a finished one does — the copy goes
  // and the real Bart takes over where it stands — instead of pressing on to a
  // spot that was just invalidated underneath it.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  await sleep(1600)
  await installSampler({ source: SEAT_LOGO, target: DOCK_LOGO, held: '.bart-dock' })
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  // Well inside the return's route, so an abort is unmistakably not an arrival.
  await sleep(200)
  await page.setViewportSize({ width: 1100, height: 820 })
  await page.waitForSelector('.settings-page', { state: 'detached' })
  await sleep(500)
  const resized = await collect()
  const dockAfterResize = await inkOf(DOCK_LOGO)
  await page.screenshot({ path: path.join(output, 'resize-abort.png') })

  const resizedAir = resized.samples.filter((sample) => sample.copy)
  const resizedLast = resizedAir.at(-1)
  // Only a couple of frames fit in 200ms on this page, so the proof that the copy
  // really left the seat comes from where it started, not from how many samples.
  assert.ok(resizedAir.length >= 2, `resize: the copy must have been in the air, saw ${resizedAir.length} frames`)
  assert.ok(distance(center(resized.takeoff), center(seatBeforeReturn)) < 1, 'resize: the aborted flight must still have started from the seat')
  const resizedMs = resizedLast.t - resizedAir[0].t
  assert.ok(resizedMs < CLOSE_ROUTE - 100, `resize: the flight must be cut short rather than flown out (${resizedMs.toFixed(0)}ms of a ${CLOSE_ROUTE}ms route)`)
  assert.ok(distance(center(resizedLast.copy), center(dockAfterResize)) > 20,
    `resize: the copy must not have chased the Dock to its new place (${describe(resizedLast.copy)} vs ${describe(dockAfterResize)})`)
  assert.equal(resized.samples[resized.samples.indexOf(resizedLast) + 1].heldVisible, true, 'resize: the Dock must appear the moment the copy is gone, not a beat later')
  assert.equal(await page.evaluate(() => !document.querySelector('[data-bart-cross-page-flight]')), true, 'resize: the flight layer must be torn down')
  console.log(`resize: the return was cut off after ${resizedMs.toFixed(0)}ms and both ends landed at once.`)

  // Switching away from the coordinator mid-flight takes the landing target off
  // the page; the copy goes with it rather than hanging in the air, and the tab
  // coming back must find the real Bart already in its seat.
  await page.setViewportSize({ width: 1369, height: 994 })
  await sleep(400)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  await sleep(200)
  await page.getByRole('tab', { name: '通用' }).click()
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(400)
  const stranded = await collect()
  assert.equal(await page.evaluate(() => !document.querySelector('[data-bart-cross-page-flight]')), true, 'tab switch: the flight layer must be torn down')
  assert.ok(await page.getByRole('button', { name: '返回' }).isVisible(), 'tab switch: leaving the coordinator is not a close')
  assert.equal(stranded.samples.at(-1).page, true, 'tab switch: the settings page must stay up')
  await page.getByRole('tab', { name: 'Bart' }).click()
  await page.waitForSelector('.bart-host-body .bart-logo')
  const seatAfterTabs = await inkOf(SEAT_LOGO)
  assert.ok(seatAfterTabs, 'tab switch: the real Bart must be in its seat when the tab comes back')
  await page.screenshot({ path: path.join(output, 'tab-switch-abort.png') })
  console.log('tab-switch: the copy was dropped mid-route and the seat was already in place.')

  // The seat is laid out before the page has asked the machine what is installed:
  // an unanswered status reads as installed, so the seat starts among every Harness
  // and slides once the missing ones drop out. A flight already on its way has to
  // tell that first, unmoving place apart from a seat that has stopped, or the real
  // Bart is handed a seat that then slides out from under it.
  await page.goto(PROBE_DELAY_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  const dockBeforeProbe = await inkOf(DOCK_LOGO)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(600)
  const delayed = await collect()
  const seatAfterProbe = await inkOf(SEAT_LOGO)
  await page.screenshot({ path: path.join(output, 'delayed-probe-landed.png') })
  const delayedObservation = {
    label: 'delayed-probe', origin: dockBeforeProbe, destination: seatAfterProbe, landing: seatAfterProbe,
    ...delayed, layerGone: await page.evaluate(() => !document.querySelector('[data-bart-cross-page-flight]'))
  }
  observations.push(delayedObservation)
  delayedObservation.result = assertFlight({
    label: 'delayed-probe', samples: delayed.samples, takeoff: delayed.takeoff, takeoffAt: delayed.takeoffAt,
    duration: OPEN_ROUTE, originInk: dockBeforeProbe, landed: seatAfterProbe, growing: false, badgeAppears: true
  })
  const delayedAir = delayed.samples.filter((sample) => sample.copy)
  // Both readings are the seat the sampler saw under the copy, so this is the seat
  // moving rather than a measurement of two different things.
  const provisional = delayedAir[0].target
  const final = delayedAir.at(-1).target
  assert.ok(distance(center(provisional), center(final)) > 100,
    `delayed-probe: the seat must still have been on its provisional place when the flight left (${describe(provisional)} vs ${describe(final)})`)
  // The route was over long before this: what the copy is doing here is waiting.
  assert.ok(delayedAir.at(-1).t - delayed.takeoffAt > OPEN_ROUTE + 300,
    `delayed-probe: the copy must wait for the seat to stop rather than hand over on a still frame (handed over after ${(delayedAir.at(-1).t - delayed.takeoffAt).toFixed(0)}ms)`)
  console.log(`delayed-probe: the seat moved ${distance(center(provisional), center(final)).toFixed(0)}px after the route ended and the copy waited for it.`)

  // The seat above was late by less than the copy is willing to wait, so it never
  // says whether that willingness is a clock or the seat's own word. A probe may
  // legally outlast the clock: refreshing the login shell is allowed 4s in the
  // main process, and it happens inside every probe. This one answers after the
  // copy's old 2200ms patience had already run out, so a flight that hands over on
  // the clock is caught in the act — mid-air, on a seat that still says it is not
  // final, which is precisely the snap the pending flag exists to prevent. Waiting on
  // the flag alone is only half of it: the answer is what starts the seat's own 720ms
  // slide, so the copy also has to outlast that.
  await page.goto(SLOW_PROBE_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  const slowTakeoffAt = Date.now()
  await sleep(2500)
  const slowProbe = await page.evaluate((selector) => ({
    flying: Boolean(document.querySelector('[data-bart-cross-page-flight]')),
    pending: document.querySelector(selector)?.closest('.bart-coordinator-anchor')
      ?.hasAttribute('data-position-pending') ?? null
  }), SEAT_LOGO)
  assert.equal(slowProbe.pending, true,
    'slow-probe: this scenario only says anything while the seat is still waiting on its probe')
  assert.equal(slowProbe.flying, true,
    `slow-probe: the copy must wait on the seat's own word rather than on a clock (landed ${Date.now() - slowTakeoffAt}ms in)`)
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  const slowWaited = Date.now() - slowTakeoffAt
  // The answer is not the end of the wait: the roster the probe just narrowed is
  // what starts the seat's own 720ms slide. Waiting only until the flag clears
  // hands the copy over on the probe's own frame, with the seat still travelling —
  // so the seat is read here and again once it has had time to arrive, and the two
  // readings have to be the same place.
  const seatOnHandover = await inkOf(SEAT_LOGO)
  await sleep(900)
  const seatSettled = await inkOf(SEAT_LOGO)
  assert.equal(await page.evaluate((selector) => document.querySelector(selector)?.closest('.bart-coordinator-anchor')
    ?.hasAttribute('data-position-pending') ?? null, SEAT_LOGO), false,
  'slow-probe: the seat must be final once the copy is handed to it')
  assert.ok(distance(center(seatOnHandover), center(seatSettled)) < 2,
    `slow-probe: the copy must wait for the slide the probe's answer starts, not just for the answer (${describe(seatOnHandover)} then ${describe(seatSettled)})`)
  await page.screenshot({ path: path.join(output, 'slow-probe-landed.png') })
  console.log(`slow-probe: the copy stayed in the air for ${slowWaited}ms and landed on a seat that had already stopped, ${distance(center(seatOnHandover), center(seatSettled)).toFixed(1)}px from where it later rests.`)

  // The seat slides a long way while the probe is out, far enough to pass the
  // Dock's own column while the copy is in the air. The bow is perpendicular to
  // the line between the two seats, so a normal read afresh every frame turns
  // over the moment they cross and the copy jumps the width of the arch in a
  // single frame. The side is read once instead, as the flight leaves.
  const parkAt = Math.round(center(await seatProvisionalPlace()).x) + CROSSING_PARK_OFFSET
  await page.goto(CROSSING_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  // Parked just past the seat's provisional place, so the slide crosses it while
  // the route is still shortening and the arch still has height. A crossing later
  // than that says nothing: the arch is exactly zero by the time the route runs
  // out, so both sides of it would read as a flat zero. Dragged from wherever the
  // Dock currently is rather than by a fixed offset, because its place is
  // remembered across reloads.
  const crossingBefore = await inkOf(DOCK_LOGO)
  const crossingGrip = await page.evaluate(() => {
    const box = document.querySelector('.bart-dock-drag-surface').getBoundingClientRect()
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  })
  await page.mouse.move(crossingGrip.x, crossingGrip.y)
  await page.mouse.down()
  await page.mouse.move(crossingGrip.x + (parkAt - center(crossingBefore).x), crossingGrip.y - 120, { steps: 12 })
  await page.mouse.up()
  await sleep(400)
  const crossingDock = await inkOf(DOCK_LOGO)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(400)
  const crossed = await collect()
  const crossedAir = crossed.samples.filter((sample) => sample.copy)
  const seatAfterCrossing = await inkOf(SEAT_LOGO)
  const columns = crossedAir.map((sample) => center(sample.target).x - center(sample.source).x)
  const sides = new Set(columns.map(Math.sign))
  assert.ok(sides.has(-1) && sides.has(1),
    `crossing: this says nothing unless the seat crosses the Dock's column while the copy is in the air (sides ${[...sides]}, the seat stayed ${Math.min(...columns).toFixed(0)}-${Math.max(...columns).toFixed(0)}px from it)`)
  const sides0 = pinnedBowSide(crossedAir)
  // The bow is dealt one side at takeoff and keeps it. Measured against the live
  // route instead, the frames after the crossing would read the whole arch height
  // as a negative — the reading the sampler caught of a build that recomputes the
  // normal every frame was -19.4px here.
  const flipped = sides0.find((offset) => offset < -3)
  assert.equal(flipped, undefined,
    `crossing: the bow must keep the side it was dealt while the seat turns the route over (worst ${Math.min(...sides0).toFixed(1)}px)`)
  // ...and the swap has to land where the arch still has height. Read off the frame
  // it happens on rather than from the tallest frame of the flight: the arch is
  // zero at both ends, so a swap that waited for the route to run out would read
  // as a flat zero on either side and would pass whatever the normal did.
  const sideOf = (sample) => Math.sign(center(sample.target).x - center(sample.source).x)
  const swapAt = crossedAir.findIndex((sample, index) => index > 0 && sideOf(sample) !== sideOf(crossedAir[index - 1]))
  // Both frames the crossing falls between, because the arch is already flattening
  // by the time the seat has slid this far and the page can put a tenth of a second
  // between two samples — the frame after the swap read 4.8px against the frame
  // before it reading 21.1px. What this rules out is the vacuous crossing, where the
  // route has run out and both frames read a flat zero.
  //
  // Two pixels, flat, rather than a share of the height this flight's arch reached.
  // The height left at the swap is the seat's own slide — the page's timing, not this
  // test's — so a share of a sixty-pixel arch is a budget of about a pixel, and it
  // would shrink further on a flight whose crest the sampler read low. Crossings on
  // this page have read between 3.1px and 22.4px, with the frame after the swap as low
  // as 0.2px, so two pixels sits under every reading seen and far above the vacuous
  // one. The recomputed-normal build this is about does not read low here at all: it
  // reads the whole arch back as a negative, which the check above catches.
  const bowAtSwap = Math.max(...[swapAt - 1, swapAt].map((index) => Math.abs(sides0[index])))
  const bowPeak = Math.max(...sides0.map(Math.abs))
  assert.ok(bowPeak > 20 && bowAtSwap > 2,
    `crossing: the seats must swap sides while the copy is still off its route, not after the route has run out (${bowAtSwap.toFixed(1)}px of the ${bowPeak.toFixed(1)}px this flight's bow reached, ${sides0[swapAt - 1].toFixed(1)} then ${sides0[swapAt].toFixed(1)})`)
  await page.screenshot({ path: path.join(output, 'crossing-landed.png') })
  assertFlight({
    label: 'crossing', samples: crossed.samples, takeoff: crossed.takeoff, takeoffAt: crossed.takeoffAt,
    duration: OPEN_ROUTE, originInk: crossingDock, landed: seatAfterCrossing, growing: false, badgeAppears: true
  })
  console.log(`crossing: the seat passed the Dock's column mid-air (${[...sides].join(' then ')}) while the copy held ${bowAtSwap.toFixed(1)}px of the ${bowPeak.toFixed(1)}px bow it was dealt, on one side of its route throughout.`)

  // A gesture still running when the page closes has to be accounted for too. The
  // copy is measured against the seat's drawn ink, and a seat mid-gesture hands it
  // a leaning, taller box to leave from — the composed pose, not the resting shape.
  // The route it then flies is interpolated from that mapping, so the copy leaves
  // wearing the lean rather than straightening up first. Picking the other
  // coordinator is what makes this pinnable: the acknowledgment it triggers holds
  // its lean for a beat well inside its 1.8s clip, where an idle flourish answers
  // to a 5–9s timer.
  await page.goto(HOST_SWITCH_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  await sleep(1600)
  const seatBeforeClose = await inkOf(SEAT_LOGO)
  await page.getByRole('radio', { name: /Claude/ }).click()
  const seatMidGesture = await waitForSeatGesture(seatBeforeClose, 4)
  const shapeGap = Math.max(Math.abs(seatMidGesture.width - seatBeforeClose.width),
    Math.abs(seatMidGesture.height - seatBeforeClose.height))
  assert.ok(shapeGap > 4,
    `mid-gesture: this says nothing unless the seat is really mid-gesture when the page closes (${describe(seatMidGesture)} vs ${describe(seatBeforeClose)})`)
  await installSampler({ source: SEAT_LOGO, target: DOCK_LOGO, held: '.bart-host-character' }, true)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(300)
  const gesture = await collect()
  const gestureAir = gesture.samples.filter((sample) => sample.copy)
  assert.ok(gestureAir.length > 4, `mid-gesture: the copy must be seen travelling, saw ${gestureAir.length} frames`)
  // 合成姿态: the copy opens on the frame the seat was actually holding — the
  // leaning body, the eyes mid-turn — rather than on the seat at rest, which is
  // what a copy that reset itself to a pose of its own would open on.
  //
  // Read against the seat's own drawing on the very frame the copy is first in the
  // air, rather than against a box taken before the click: the seat is mid-gesture
  // *and* sliding, because switching the coordinator re-lays-out its seat, so a
  // reading from a beat earlier is a different place and a different frame of the
  // gesture at once. Taken on the same frame, the slide cancels out and what is
  // left is the drawing. Both readings are in the logo's own units and the copy's
  // own, so this says nothing about where either of them is.
  const shapeFrom = (box) => Math.max(Math.abs(gesture.takeoff.width - box.width), Math.abs(gesture.takeoff.height - box.height))
  const heldShape = shapeFrom(gesture.takeoffSourceInk)
  const restShape = shapeFrom(seatBeforeClose)
  // Held against the box the seat held as the page closed, not against a threshold
  // of the test's own choosing: the gesture is mostly a blink, and the eyes ride at
  // the top of that box, so a few pixels of it are the seat's own frame of blink
  // rather than the copy's doing — measured across runs the copy opened 0.3 to 2.6px
  // from it on an unloaded machine and 5.9px on a loaded one, against 11.8 to 18.3px
  // from the seat at rest either way.
  assert.ok(heldShape < 8 && restShape > heldShape * 2,
    `mid-gesture: the copy must open on the composed pose the seat was holding, not on the seat at rest (${heldShape.toFixed(1)}px from the seat's own box at takeoff, ${restShape.toFixed(1)}px from the seat at rest)`)
  // ...and what it opened *drawing* is the seat's own body outline, to the unit. The
  // eyes are exempt: the two readings are taken in the same tick, but the seat's
  // gesture is a blink that crosses a third of its travel inside that tick, so a unit
  // comparison of them measures the blink's phase and not the handoff. The body the
  // copy draws is the one thing the seat's expression could not have changed under
  // it, and it is what a copy that reset itself to an expression of its own would
  // have got wrong. The blink and its carry are pinned frame by frame, through the
  // same handoff, in bart-logo-pose.dom.test.tsx.
  const bodyNumbers = pathNumbers(gesture.takeoffPose.body)
  const seatBodyNumbers = pathNumbers(gesture.takeoffSourcePose.body)
  const bodyGap = bodyNumbers.length === seatBodyNumbers.length
    ? Math.max(...bodyNumbers.map((value, index) => Math.abs(value - seatBodyNumbers[index])))
    : Infinity
  assert.ok(bodyGap < 1,
    `mid-gesture: the copy must open on the seat's own body outline, not on one of its own (${bodyGap.toFixed(2)} units apart)`)
  // 表情与姿态之外还有一层: the page's own dressing on the face, which is not the
  // expression at all — the acknowledgment this scenario waits on is translating
  // the seat's face while the pose is still its own. A copy that carried the pose
  // and left the face where the frame drew it would open undressed and jump the
  // whole translate into place on the first frame it ran.
  const seatDressing = gesture.takeoffSourceDressing
  assert.ok(dressingGap(seatDressing, IDENTITY_DRESSING) > 2,
    `mid-gesture: this says nothing unless the seat's face is really dressed when the page closes (${JSON.stringify(seatDressing)})`)
  assert.ok(dressingGap(gesture.takeoffDressing, seatDressing) < .5,
    `mid-gesture: the copy must open wearing the dressing the seat's face had on, not an undressed face (${dressingGap(gesture.takeoffDressing, seatDressing).toFixed(2)} apart)`)
  // ...and it is handed over with the dressings swapped: what lands is the face the
  // Dock is drawing, not the seat's gesture frozen onto the mark.
  const gestureLanded = gestureAir.at(-1)
  assert.ok(dressingGap(gestureLanded.copyDressing, gestureLanded.targetDressing) < 1,
    `mid-gesture: the copy must land wearing the face the Dock is drawing (${dressingGap(gestureLanded.copyDressing, gestureLanded.targetDressing).toFixed(2)} apart)`)
  assert.ok(dressingGap(gestureLanded.copyDressing, seatDressing) > 2,
    `mid-gesture: the seat's dressing must not be carried onto the Dock (${dressingGap(gestureLanded.copyDressing, seatDressing).toFixed(2)} apart)`)
  await page.screenshot({ path: path.join(output, 'mid-gesture-takeoff.png') })
  console.log(`mid-gesture: the seat was holding a box ${shapeGap.toFixed(0)}px off its resting shape and a dressing ${dressingGap(seatDressing, IDENTITY_DRESSING).toFixed(2)} off an undressed face when the page closed, and the copy opened ${heldShape.toFixed(1)}px from that box against ${restShape.toFixed(1)}px from the seat at rest, on the seat's own body outline to ${bodyGap.toFixed(2)} units and its dressing to ${dressingGap(gesture.takeoffDressing, seatDressing).toFixed(2)}.`)

  // 快开快关: a close that overtakes the open it was asked for. The page reports its
  // close the moment the button is pressed — the reveal is interrupted, not queued —
  // so the flight is asked for the other direction while its copy is still in the
  // air. It has to turn round there. Re-measuring the source instead, as the route
  // used to, drops the copy onto the seat it never reached and flies the return
  // from there: a third of the page in a single frame, which is the teleport this
  // scenario exists to rule out. The scene reads the flight off its own sampler
  // rather than `assertFlight`, because both ends are moving on the frame the turn
  // happens and neither can be held against a box taken before the click.
  //
  // Run at more than one point of the route, because the turn is asked for at
  // whatever moment the close arrives and the leg it starts has less of the arch and
  // less of the route left the later it is taken. `at` is the moment: it is how far
  // along the line between the two seats the copy has to be, as a share of that line,
  // and the close is asked for on the first frame it is that far. A share rather than
  // a distance, because the Dock's place is remembered across reloads and an earlier
  // scenario drags it: a fixed number of pixels from the Dock is a different point of
  // the route from one run of this file to the next — far enough into a short route
  // to be a turn asked for at the seat rather than in the air, which is the opposite
  // of what this is here to show.
  const runQuickToggle = async ({ label, at, minFromSeat, minFromDock }) => {
    await page.goto(OVERVIEW_URL)
    await page.waitForSelector(DOCK_LOGO)
    await sleep(900)
    await page.evaluate(`(() => {
      const ink = ${INK}
      window.__quick = []
      const tick = () => {
        // Registered before the flight's own callback, so a frame is read as it was
        // found: on the return's first frame that is the takeoff placement, written
        // by the effect before the browser painted anything.
        const copy = document.querySelector('.bart-cross-page-flight-copy')
        const dock = document.querySelector('.bart-dock')
        window.__quick.push({
          t: performance.now(),
          phase: document.querySelector('.settings-page')?.getAttribute('data-phase') ?? null,
          copy: ink(copy && copy.querySelector('svg')),
          seat: ink(document.querySelector(${JSON.stringify(SEAT_LOGO)})),
          dock: ink(document.querySelector(${JSON.stringify(DOCK_LOGO)})),
          dockHidden: dock ? getComputedStyle(dock).visibility === 'hidden' : null
        })
        if (!window.__quickStop && window.__quick.length < 4000) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    // Closed from inside the page, at the first frame the button is there *and* the
    // copy has reached the point this run is about. Driven from out here instead, the
    // click waits for the button to hold still and for the settings page to finish
    // revealing, which lands it after the open's 760ms route has run out — and a turn
    // taken from the seat it had already reached is not a turn in the air at all.
    //
    // The three boxes are taken in the same frame as the click and carried out with
    // it. That is the one reading of where the copy was when the return was asked
    // for that cannot be moved by how long the page then takes to act on it: the
    // phase attribute is written by a render, and a machine under load can put
    // several frames of the route between the click and the first frame it is read
    // on. Measured there, a copy that had a turn requested in open air reads as one
    // that had nearly reached the seat.
    const asked = await page.evaluate(`new Promise((resolve) => {
      const ink = ${INK}
      const centre = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      const started = performance.now()
      const attempt = () => {
        const button = [...document.querySelectorAll('button')].find((node) =>
          /返回/.test((node.getAttribute('aria-label') || '') + ' ' + node.textContent))
        const copy = ink(document.querySelector('.bart-cross-page-flight-copy svg'))
        const dock = ink(document.querySelector(${JSON.stringify(DOCK_LOGO)}))
        const seat = ink(document.querySelector(${JSON.stringify(SEAT_LOGO)}))
        if (button && copy && dock && seat) {
          const toDock = Math.hypot(centre(copy).x - centre(dock).x, centre(copy).y - centre(dock).y)
          const toSeat = Math.hypot(centre(copy).x - centre(seat).x, centre(copy).y - centre(seat).y)
          if (toDock / (toDock + toSeat) >= ${at}) {
            button.click()
            resolve({ after: performance.now() - started, copy, dock, seat })
            return
          }
        }
        if (performance.now() - started > 2000) { resolve(null); return }
        requestAnimationFrame(attempt)
      }
      requestAnimationFrame(attempt)
    })`)
    assert.notEqual(asked, null, `${label}: the close must be askable while the copy is still in the air`)
    const closedAfter = asked.after
    // The open's own route, not a threshold of the test's own: what has to hold is
    // that the close was asked for while the copy was still flying it. How much of the
    // route is left at that point is the page's business and is read off the flight
    // itself below, by where the copy had got to. On a loaded machine the button takes
    // a third of the route to appear, which is still well inside it.
    assert.ok(closedAfter < OPEN_ROUTE,
      `${label}: this says nothing unless the close beats the open's route (closed after ${closedAfter.toFixed(0)}ms of it)`)
    await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
    await sleep(400)
    const quick = await page.evaluate(() => {
      window.__quickStop = true
      return window.__quick
    })
    const quickAir = quick.filter((sample) => sample.copy)
    const quickTakeoff = quick.find((sample) => sample.copy && sample.phase === 'closing')
    const quickLanding = quickAir.at(-1)
    const quickAfter = quick[quick.indexOf(quickLanding) + 1]
    await page.screenshot({ path: path.join(output, `${label}-landed.png`) })
    assert.ok(quickTakeoff, `${label}: the return must be seen starting while the page is closing`)
    assert.ok(quickTakeoff.seat && quickTakeoff.dock, `${label}: both ends must be drawn when the return turns`)
    // 反向请求发生于尚未落座时: read off the frame the request was made on, which is
    // the only frame on which "was the copy still flying?" is a question about this
    // run rather than about how busy the machine was afterwards.
    const askedFromSeat = distance(center(asked.copy), center(asked.seat))
    const askedFromDock = distance(center(asked.copy), center(asked.dock))
    assert.ok(askedFromSeat > minFromSeat && askedFromDock > minFromDock,
      `${label}: the return must be asked for while the copy is between the seats (${describe(asked.copy)} is ${askedFromSeat.toFixed(0)}px from the seat and ${askedFromDock.toFixed(0)}px from the Dock)`)
    // 反向前后空中画面: the return's first drawn frame against the frame the request
    // was made on, and against the two ends as they stood on it. The settings page
    // paints at whatever rate it can while it is revealing, so the turn falls between
    // two paints and the gap across it is one paint's worth of the copy's travel — how
    // much that is, is the page's business and is not asserted. What is asserted is
    // where the frame after the turn sits: nearer to the frame before it than to either
    // end, which is what a leg that picked the airborne copy up satisfies and a leg
    // that re-measured a seat does not.
    const turnGap = distance(center(quickTakeoff.copy), center(asked.copy))
    const seatGap = distance(center(quickTakeoff.copy), center(asked.seat))
    const dockGap = distance(center(quickTakeoff.copy), center(asked.dock))
    assert.ok(turnGap < seatGap && turnGap < dockGap,
      `${label}: the return's first frame must carry on from the frame the open left on screen rather than start at an end (the copy moved ${turnGap.toFixed(0)}px across the turn, and from there it is ${seatGap.toFixed(0)}px to the seat and ${dockGap.toFixed(0)}px to the Dock)`)
    const quickTravelled = Math.max(...quickAir.map((sample) => distance(center(sample.copy), center(quickTakeoff.copy))))
    assert.ok(quickTravelled > 100, `${label}: the copy must still cross the page (travelled ${quickTravelled.toFixed(1)}px)`)
    assert.ok(distance(center(quickLanding.copy), center(quickLanding.dock)) < 1,
      `${label}: the return must still land on the Dock (${describe(quickLanding.copy)} vs ${describe(quickLanding.dock)})`)
    assert.equal(quickAfter.dockHidden, false, `${label}: the Dock must reappear the moment the copy is gone, not a beat later`)
    console.log(`${label}: a close asked for ${askedFromDock.toFixed(0)}px short of the Dock and ${askedFromSeat.toFixed(0)}px short of the seat turned the copy round there and landed it on the Dock over ${quickAir.length} frames.`)
    return { quick, quickAir }
  }

  // 各阶段反向: the same turn asked for at two points of the open. The button the
  // close is asked with does not exist until the settings page has revealed part of
  // itself, which is about a third of the way along, so the two runs frame what the
  // page can actually be asked for: a turn taken with most of the route still to run,
  // and one taken with most of the performance's beats behind it and less than a third
  // of the route left. Nothing about the leg construction reads the phase — the copy
  // always leaves the frame on screen from where the last leg had got to — so what
  // the second run is for is that it still does so with the least left to work with.
  // The fine-grained side of the same construction — that the new leg starts from the
  // frame on screen and picks the performance's beats up where the last leg left them
  // — is pinned on a controlled clock in bart-cross-page-flight.test.ts.
  await runQuickToggle({
    label: 'quick-toggle',
    at: .3,
    minFromSeat: 60,
    minFromDock: 60
  })
  await runQuickToggle({
    label: 'quick-toggle-late',
    at: .6,
    minFromSeat: 60,
    minFromDock: 60
  })

  // 下一次旅程可重入: the turn's own callbacks are gone by the time the copy lands, so
  // the next open is a flight of its own rather than one the abandoned leg can end.
  // A stale finish would take the new copy out of the air, or show the Dock under it.
  await page.goto(OVERVIEW_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(900)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(600)
  const second = await collect()
  const secondAir = second.samples.filter((sample) => sample.copy)
  assert.ok(secondAir.length > 4,
    `re-entrant: the next open must fly a copy of its own, not inherit the abandoned leg (${secondAir.length} airborne frames)`)
  assert.ok(distance(center(secondAir.at(-1).copy), center(secondAir.at(-1).target)) < 1,
    `re-entrant: the second journey must still land on the seat (${describe(secondAir.at(-1).copy)} vs ${describe(secondAir.at(-1).target)})`)
  console.log(`re-entrant: the open after an interrupted one flew ${secondAir.length} frames and landed on the seat.`)

  // 表情交接 at the Dock end, and a live expression arriving while the copy is in
  // the air. The Dock paints Bart's own tool operations, so it is the one seat that
  // can be *wearing* something rather than idling — which makes it the end where a
  // copy that reset itself is visible: it would open on the mark's resting shape
  // instead of the frame the Dock was holding.
  await page.goto(OPS_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(1200)
  const dockWearing = await poseOf(DOCK_LOGO)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' }, true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(600)
  const wearing = await collect()
  const wearingAir = wearing.samples.filter((sample) => sample.copy)
  const seatLanded = await poseOf(SEAT_LOGO)
  await page.screenshot({ path: path.join(output, 'ops-takeoff-landed.png') })
  // The Dock is really wearing something: its frame is a different drawing from the
  // idle one the seat ends up showing, so the comparison below has a side to fail on.
  const wearingGap = poseGap(dockWearing, seatLanded)
  assert.ok(wearingGap > 25,
    `ops: this says nothing unless the Dock's held expression is a different drawing from the idle one (gap ${wearingGap.toFixed(1)})`)
  // 从当前实际可见的表情起飞: the copy opens on the Dock's own frame, not on a
  // default, and it is still wearing it — not a caught-up approximation — on the
  // frames before the seat's expression takes over 45% into the route.
  const wore = poseGap(wearing.takeoffPose, dockWearing)
  assert.ok(wore < 8,
    `ops: the copy must open on the frame the Dock was holding, not on a pose of its own (gap ${wore.toFixed(1)} at takeoff)`)
  assert.ok(poseGap(wearingAir.at(-1).copyPose, wearing.takeoffPose) > 25,
    `ops: the copy must be wearing the seat's expression by the time it lands, not still the Dock's (${poseGap(wearingAir.at(-1).copyPose, wearing.takeoffPose).toFixed(1)})`)
  console.log(`ops: the Dock was ${wearingGap.toFixed(1)} units off its idle drawing and the copy opened ${wore.toFixed(1)} units from it.`)

  // 角色打扮: the same Dock end under the *page's* dressing rather than an
  // operation of its own. A mark wearing a tool is shifted and squashed by
  // `bart-role.css` — a transform on the face layer that the expression does not
  // know about and the logo does not draw — so this is where a copy that carried
  // the drawing and nothing else is caught: the face it opens with is the one the
  // frame would have drawn, and it snaps the squash and the shift into place on
  // the first frame the copy runs. Read at rest before the click, where the
  // coordinator's gaze cannot have answered for the squash instead.
  await page.goto(ROLE_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(1200)
  const dockSquash = await dressingOf(DOCK_LOGO)
  assert.ok(dockSquash.d < .9 && Math.hypot(dockSquash.e, dockSquash.f) > 20,
    `role: this says nothing unless the Dock's face is really dressed by its role (${JSON.stringify(dockSquash)})`)
  await installSampler({ source: DOCK_LOGO, target: SEAT_LOGO, held: '.bart-host-character' }, true)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(600)
  const role = await collect()
  const roleAir = role.samples.filter((sample) => sample.copy)
  const roleLanded = roleAir.at(-1)
  await page.screenshot({ path: path.join(output, 'role-landed.png') })
  assert.ok(roleAir.length > 4, `role: the copy must be seen travelling, saw ${roleAir.length} frames`)
  assert.ok(dressingGap(role.takeoffDressing, role.takeoffSourceDressing) < .5,
    `role: the copy must open wearing the Dock's role dressing, not the undressed face the frame would draw (${dressingGap(role.takeoffDressing, role.takeoffSourceDressing).toFixed(2)} apart)`)
  // The role is not only a matrix. The dot colour and the locked eyes are child
  // rules keyed on the role's own name, and the copy is outside the Dock's scope,
  // so this is where a copy that carried the transform and nothing else is caught:
  // it opens with the mark's blue dot and its eyes back at the expression's angle,
  // and swaps both in on the frame the Dock stops being drawn.
  const dockChrome = role.takeoffSourceChrome
  assert.ok(dockChrome && dockChrome.role === 'tool' && dockChrome.eye === 'none',
    `role: this says nothing unless the Dock's role really locks the eyes upright (${JSON.stringify(dockChrome)})`)
  const copyChrome = role.takeoffChrome
  assert.ok(copyChrome && copyChrome.role === 'tool',
    `role: the copy must be given the role, not only the transform it draws (role ${JSON.stringify(copyChrome && copyChrome.role)})`)
  assert.equal(copyChrome.dot, dockChrome.dot,
    `role: the copy must draw the role's own dot, not the mark's (${copyChrome.dot} against ${dockChrome.dot})`)
  assert.equal(copyChrome.eye, 'none',
    `role: the copy must draw the role's locked eyes, not the expression's own angle (${copyChrome.eye})`)
  // ...and the squash is the Dock's, so it must be gone by the landing: what the
  // seat is handed is the seat's own face, whatever the page has on it.
  assert.ok(dressingGap(roleLanded.copyDressing, roleLanded.targetDressing) < 1,
    `role: the copy must land on the seat's own face (${dressingGap(roleLanded.copyDressing, roleLanded.targetDressing).toFixed(2)} apart)`)
  assert.ok(dressingGap(roleLanded.copyDressing, role.takeoffDressing) > 2,
    `role: the Dock's squash must not be carried onto the seat (${dressingGap(roleLanded.copyDressing, role.takeoffDressing).toFixed(2)} apart)`)
  console.log(`role: the Dock's face was squashed to d=${dockSquash.d} and shifted ${Math.hypot(dockSquash.e, dockSquash.f).toFixed(0)}px by its role, and the copy opened on it to ${dressingGap(role.takeoffDressing, role.takeoffSourceDressing).toFixed(2)} and landed on the seat's own face to ${dressingGap(roleLanded.copyDressing, roleLanded.targetDressing).toFixed(2)}.`)

  // A business state arriving mid-flight has to reach the copy before it lands: the
  // Dock's own operation is replaced while the copy is on its way back, and what
  // lands has to be wearing the new one rather than the one it left with.
  //
  // The change is injected *after* the mark the copy starts aiming at its
  // destination, which is the case that separates a flight that keeps reading the
  // seat from one that read it once and stopped. Aimed only at the mark, the copy
  // spends the rest of the route converging on a drawing the Dock has already
  // dropped, and the landing adopts that drawing into the seat.
  await installSampler({ source: SEAT_LOGO, target: DOCK_LOGO, held: '.bart-dock' }, true)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  // The return is 560ms end to end and the mark is crossed 45% into it (252ms), so
  // this lands the change as soon as the copy can see it and leaves it the rest of
  // the route to act on it. Earlier and the copy is still aiming at its own mark;
  // later and the runway shortens toward nothing — and the Dock's own activity need
  // not flip on the tick the call is made, so a change injected late enough can
  // arrive at the copy with a frame or two left and no time to converge on it,
  // which reads here as a copy that ignored it.
  await page.waitForTimeout(270)
  await page.evaluate(() => window.rendererBenchmark.setBartOperation('status'))
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(400)
  const live = await collect()
  const changed = live.samples.filter((sample) => sample.copy && sample.activity === 'status')
  assert.ok(changed.length >= 1,
    `live-update: this says nothing unless the new operation reached the Dock while the copy was in the air (${changed.length} frames saw it)`)
  const wearingBefore = live.samples.filter((sample) => sample.copy && sample.activity !== 'status').at(-1)
  assert.ok(wearingBefore,
    'live-update: this says nothing unless the copy was seen in the air before the Dock picked the new operation up')
  const moved = poseGap(changed.at(-1).copyPose, live.takeoffPose)
  const superseded = poseGap(changed.at(-1).copyPose, wearingBefore.targetPose)
  const settled = poseGap(changed.at(-1).copyPose, changed.at(-1).targetPose)
  await page.screenshot({ path: path.join(output, 'live-update-landed.png') })
  assert.ok(moved > 8,
    `live-update: the copy must take the expression the Dock picked up mid-flight rather than land still wearing the one it left with (moved ${moved.toFixed(1)} units)`)
  // Against the two candidate drawings rather than against its own earlier frame:
  // the one the Dock was wearing when the change arrived is what a flight that
  // stopped reading the seat would have landed on, and it is the drawing the
  // landing would then have adopted into the seat.
  assert.ok(settled < superseded,
    `live-update: the copy must land on the drawing the Dock switched to, not the one it superseded (${settled.toFixed(1)} to the new drawing against ${superseded.toFixed(1)} to the old one)`)
  console.log(`live-update: the Dock took a new operation ${changed.length} frames before the copy landed and the copy moved ${moved.toFixed(1)} units onto it, ${settled.toFixed(1)} from the new drawing against ${superseded.toFixed(1)} from the superseded one.`)

  // 终态/身份切换: the operation the copy was aimed at stops being valid rather than
  // being replaced by another one — it ends — and the Dock falls back to its own
  // resting drawing. From the seat's side that is the same thing: what it was wearing
  // is gone, and a copy still converging on the drawing it last read would land
  // holding an operation the Dock had already finished, which the landing then adopts
  // into the seat. Completed, failed and cancelled are all this same ending.
  await page.goto(OPS_URL)
  await page.waitForSelector(DOCK_LOGO)
  await sleep(1200)
  const dockBusy = await poseOf(DOCK_LOGO)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.waitForSelector('.settings-page[data-phase=open]')
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(600)
  await installSampler({ source: SEAT_LOGO, target: DOCK_LOGO, held: '.bart-dock' }, true)
  await page.getByRole('button', { name: '返回' }).click()
  await page.waitForSelector('.bart-cross-page-flight-copy', { state: 'attached' })
  // The return is 560ms and the mark is crossed 45% into it, so this ends the
  // operation just past halfway with the copy still in the air. Later than the
  // live-update injection above, and it can afford to be: the two drawings the
  // copy is judged between here are held apart by the `endedGap` assertion below,
  // so a change arriving with only a few frames left still reads clearly. There it
  // is the two operations' own drawings that are being compared, and those need
  // not differ by anything in particular — so the copy has to be given the runway.
  await page.waitForTimeout(360)
  await page.evaluate(() => window.rendererBenchmark.setBartOperation(null))
  await page.waitForSelector('.bart-cross-page-flight', { state: 'detached' })
  await sleep(400)
  const ended = await collect()
  const dockIdle = await poseOf(DOCK_LOGO)
  const endedAir = ended.samples.filter((sample) => sample.copy)
  // The ending has to be visible on the seat for any of this to mean anything: a
  // resting drawing that matched a working one would read as a copy that never moved.
  const endedGap = poseGap(dockIdle, dockBusy)
  assert.ok(endedGap > 25,
    `ended: this says nothing unless an ended operation leaves the Dock on a drawing of its own (gap ${endedGap.toFixed(1)} against the working one)`)
  const heldTarget = endedAir.filter((sample) => sample.activity === 'list').at(-1)
  assert.ok(heldTarget,
    'ended: this says nothing unless the copy was in the air while the Dock still held the operation')
  const afterEnd = endedAir.filter((sample) => sample.activity !== 'list')
  assert.ok(afterEnd.length >= 1,
    `ended: this says nothing unless the ending reached the Dock while the copy was in the air (${afterEnd.length} frames saw it)`)
  const landedOn = afterEnd.at(-1)
  const ontoIdle = poseGap(landedOn.copyPose, landedOn.targetPose)
  const stillBusy = poseGap(landedOn.copyPose, heldTarget.targetPose)
  assert.ok(ontoIdle < stillBusy,
    `ended: the copy must land on the drawing the Dock fell back to, not on the operation that ended (${ontoIdle.toFixed(1)} to the resting drawing against ${stillBusy.toFixed(1)} to the finished one)`)
  await page.screenshot({ path: path.join(output, 'ended-landed.png') })
  console.log(`ended: the operation ended ${afterEnd.length} frames before the copy landed and the copy came in on the Dock's resting drawing, ${ontoIdle.toFixed(1)} from it against ${stillBusy.toFixed(1)} from the operation it had aimed at.`)
} finally {
  await context.close()
  await writeFile(path.join(output, 'samples.json'), JSON.stringify(observations, null, 2))
}

for (const observation of observations) {
  assert.equal(observation.layerGone, true, `${observation.label}: the flight layer must clean up`)
  const { airborne, travelled } = observation.result
  console.log(`${observation.label}: Bart drew ${describe(observation.origin)} and landed ${describe(observation.landing)} over ${airborne} frames, ${travelled.toFixed(0)}px of travel.`)
}

// A skipped flight has to be indistinguishable from the page transition alone:
// no layer left behind, no change to the reveal, and no close swallowed.
const skips = []
async function observeSkip({ label, url, open }) {
  const skipContext = await browser.newContext({ viewport: { width: 1369, height: 994 } })
  const skipPage = await skipContext.newPage()
  skipPage.on('pageerror', (error) => console.error(`[${label}]`, error.message))
  skipPage.on('crash', () => console.error(`[${label}] page crashed`))
  await skipPage.goto(url)
  // `attached`, not `visible`: the point of the no-origin case is a Dock that is
  // mounted and measurable while concealed behind a thread.
  await skipPage.waitForSelector(DOCK_LOGO, { state: 'attached' })
  await skipPage.waitForTimeout(900)
  await watchForLayer(skipPage)
  await open(skipPage)
  await skipPage.waitForSelector('.settings-page[data-phase=open]')
  await skipPage.waitForTimeout(700)
  const revealed = await skipPage.evaluate(() => Boolean(document.querySelector('.settings-page[data-phase=open]')))
  await skipPage.getByRole('button', { name: '返回' }).click()
  await skipPage.waitForSelector('.settings-page', { state: 'detached' })
  const sawLayer = await skipPage.evaluate(() => window.__sawLayer)
  assert.equal(sawLayer, false, `${label}: the flight layer must never mount`)
  assert.equal(revealed, true, `${label}: the page must still reveal on its own schedule`)
  await skipContext.close()
  skips.push(label)
  console.log(`${label}: no flight, page revealed and closed normally.`)
}

await observeSkip({
  // A thread view has no Overview for Bart to leave from, and no settings button
  // either — the shortcut is the only way in, which is exactly how a user gets here.
  label: 'no-origin',
  url: THREAD_URL,
  open: (target) => target.keyboard.press(`${SHORTCUT_MODIFIER}+,`)
})
await observeSkip({
  // Bart's Dock holds an input here rather than the bare mark, so the copy would
  // have nothing to continue from. The shortcut opens the input from anywhere.
  label: 'dock-not-a-mark',
  url: OVERVIEW_URL,
  open: async (target) => {
    await target.keyboard.press(`${SHORTCUT_MODIFIER}+Shift+b`)
    await target.waitForTimeout(300)
    assert.notEqual(await target.evaluate(() => document.querySelector('.bart-dock').dataset.layout), 'mark',
      'this scenario only says anything if the Dock really left its mark layout')
    await target.keyboard.press(`${SHORTCUT_MODIFIER}+,`)
  }
})

// The coordinator is not on this machine, so the Bart tab renders no seat and the
// copy has nowhere to land. Two opens are needed to reach that: the page only
// probes when it opens, so the first open is the one that learns the coordinator
// is gone — a seat that is still there at takeoff and then vanishes, which is the
// abort case the tab-switch scenario already covers. The second open is the state
// worth pinning: a user whose coordinator binary moved finds no seat before the
// reveal starts, and the flight has to be dropped without a layer ever mounting.
const noSeatContext = await browser.newContext({ viewport: { width: 1369, height: 994 } })
const noSeatPage = await noSeatContext.newPage()
noSeatPage.on('pageerror', (error) => console.error('[no-landing-target]', error.message))
await noSeatPage.goto(NO_SEAT_URL)
await noSeatPage.waitForSelector(DOCK_LOGO, { state: 'attached' })
await noSeatPage.waitForTimeout(900)
await noSeatPage.getByRole('button', { name: '设置', exact: true }).click()
await noSeatPage.waitForSelector('.settings-page[data-phase=open]')
await noSeatPage.waitForTimeout(600)
await noSeatPage.getByRole('button', { name: '返回' }).click()
await noSeatPage.waitForSelector('.settings-page', { state: 'detached' })
await noSeatPage.waitForTimeout(400)
await watchForLayer(noSeatPage)
await noSeatPage.getByRole('button', { name: '设置', exact: true }).click()
await noSeatPage.waitForSelector('.settings-page[data-phase=open]')
await noSeatPage.waitForTimeout(700)
assert.equal(await noSeatPage.evaluate((selector) => Boolean(document.querySelector(selector)), SEAT_LOGO), false,
  'this scenario only says anything if the coordinator seat really is absent')
const noSeatRevealed = await noSeatPage.evaluate(() => Boolean(document.querySelector('.settings-page[data-phase=open]')))
await noSeatPage.getByRole('button', { name: '返回' }).click()
await noSeatPage.waitForSelector('.settings-page', { state: 'detached' })
assert.equal(await noSeatPage.evaluate(() => window.__sawLayer), false,
  'no-landing-target: an endpoint that is missing before takeoff must drop the whole flight')
assert.equal(noSeatRevealed, true, 'no-landing-target: the page must still reveal on its own schedule')
await noSeatContext.close()
skips.push('no-landing-target')
console.log('no-landing-target: no flight, page revealed and closed normally.')

// Once the copy has landed the journey is over: picking another coordinator is
// the seat sliding along its own row, and must not call the flight back.
const switchContext = await browser.newContext({ viewport: { width: 1369, height: 994 } })
const switchPage = await switchContext.newPage()
switchPage.on('pageerror', (error) => console.error('[host-switch]', error.message))
await switchPage.goto(HOST_SWITCH_URL)
await switchPage.waitForSelector(DOCK_LOGO)
await switchPage.waitForTimeout(900)
await switchPage.getByRole('button', { name: '设置', exact: true }).click()
await switchPage.waitForSelector('.settings-page[data-phase=open]')
await switchPage.waitForTimeout(1600)
await watchForLayer(switchPage)
const seatBeforeHostSwitch = await switchPage.evaluate(() => document.querySelector('.bart-coordinator-anchor').style.left)
await switchPage.getByRole('radio', { name: /Claude/ }).click()
await switchPage.waitForTimeout(1400)
const seatAfterHostSwitch = await switchPage.evaluate(() => document.querySelector('.bart-coordinator-anchor').style.left)
assert.notEqual(seatAfterHostSwitch, seatBeforeHostSwitch, 'host switch: the seat must take up its new position')
assert.equal(await switchPage.evaluate(() => window.__sawLayer), false, 'host switch: the landed flight must not be replayed')
await switchPage.screenshot({ path: path.join(output, 'host-switch.png') })
await switchContext.close()
console.log(`host-switch: the seat moved from ${seatBeforeHostSwitch} to ${seatAfterHostSwitch} without a second flight.`)

await browser.close()
console.log(`Skipped as expected: ${skips.join(', ')}.`)
console.log(`Evidence: ${output}`)
