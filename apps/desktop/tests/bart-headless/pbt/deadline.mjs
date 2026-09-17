/** Cancellation only: the owner must still await the attempt and its cleanup. */
export class ExecutionDeadline {
  constructor(milliseconds, parent, label) {
    this.controller = new AbortController()
    this.at = Date.now() + milliseconds
    this.error = new Error(`${label} exceeded its ${milliseconds}ms execution budget`)
    this.signal = parent ? AbortSignal.any([parent, this.controller.signal]) : this.controller.signal
    this.timer = setTimeout(() => this.controller.abort(this.error), milliseconds)
    this.timer.unref()
  }

  close() {
    clearTimeout(this.timer)
    // A promise can finish at the deadline before the timer gets its turn.
    if (Date.now() >= this.at) this.controller.abort(this.error)
  }
}
