import assert from 'node:assert/strict'

/**
 * Deterministic request gates for the PBT.
 *
 * A gate suspends one real native LLM turn inside the Mock HTTP endpoint until
 * the property releases it. The property therefore knows that a mutation (an
 * interrupt, a delete, a steer) happened while the target Execution was
 * genuinely in flight, instead of hoping a random sleep landed inside the race
 * window. Gates inspect only the HTTP request, never product state.
 */
export class RequestGates {
  constructor(signal) {
    this.signal = signal
    this.armed = new Map()
    this.opened = []
    this.sequence = []
    this.startedAt = Date.now()
  }

  /** Arms a gate for the target turn whose prompt carries `marker`. */
  arm(marker) {
    assert.ok(marker, 'a gate requires a marker')
    assert.ok(!this.armed.has(marker), `gate is already armed: ${marker}`)
    let reach
    let release
    const gate = {
      marker,
      reached: new Promise(resolve => { reach = resolve }),
      released: new Promise(resolve => { release = resolve }),
      reach,
      release,
      openedAt: undefined
    }
    this.armed.set(marker, gate)
    this.record(marker, 'armed')
    return gate
  }

  /** Installed as `createAcceptanceLlm({ beforeReply })`. */
  async beforeReply(request) {
    if (!isTargetTurn(request)) return
    for (const [marker, gate] of [...this.armed]) {
      if (!request.lastMessage.includes(marker)) continue
      this.armed.delete(marker)
      gate.openedAt = Date.now()
      this.opened.push(gate)
      this.record(marker, 'reached')
      gate.reach()
      await gate.released
      this.record(marker, 'released')
      return
    }
  }

  /** A missing target request must fail instead of hanging inside fc.check. */
  async waitForReached(gate, timeoutMs) {
    let timer
    let aborted
    try {
      this.signal?.throwIfAborted()
      await Promise.race([
        gate.reached,
        new Promise((_, reject) => {
          aborted = () => reject(this.signal.reason)
          this.signal?.addEventListener('abort', aborted, { once: true })
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(
            `native request gate ${gate.marker} was not reached within ${timeoutMs}ms`
          )), timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
      this.signal?.removeEventListener('abort', aborted)
    }
  }

  /** Release parked replies before draining the Mock HTTP requests. */
  releaseAll() {
    for (const gate of this.armed.values()) gate.release()
    for (const gate of this.opened) gate.release()
  }

  /**
   * The gate order is part of the failure evidence: it is what proves a racing
   * command really ran while a native turn was parked, rather than merely
   * before or after it.
   */
  record(marker, event) {
    this.sequence.push({ marker, event, elapsedMs: Date.now() - this.startedAt })
  }
}

/**
 * Only a real target Agent turn may hold a gate. Two other HTTP turns also
 * carry the generated marker, and gating either would deadlock the sample:
 * the Bart host turn embeds the whole directive, and the structured metadata
 * turn embeds the Thread's initial user intent.
 */
export function isTargetTurn(request) {
  if (request.toolNames.some(name => name.endsWith('openagent_thread_list'))) return false
  return !(request.systemMessage ?? '').includes('You classify OpenAgent Agent Thread metadata.')
}
