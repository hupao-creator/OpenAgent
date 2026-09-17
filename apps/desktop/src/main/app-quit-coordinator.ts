export type AppQuitPhase = 'running' | 'draining' | 'ready'

export interface AppBeforeQuitEvent {
  preventDefault(): void
}

export interface AppQuitCoordinatorOptions {
  /** Revoke ingress, drain owned work and persist state. */
  readonly drain: () => void | Promise<void>
  /** Ask Electron to perform the final, unblocked quit pass. */
  readonly quit: () => void
  /** Cross the native before-quit dispatch boundary before retrying quit. */
  readonly schedule: (callback: () => void) => void
  readonly onDrainError?: (error: unknown) => void
  readonly onPhaseChange?: (phase: AppQuitPhase) => void
}

/**
 * Owns the two-pass Electron quit protocol.
 *
 * Every request is blocked while durability is still draining. Once the drain
 * settles, the final `app.quit()` is scheduled in a later event-loop turn so it
 * cannot re-enter Electron's original `before-quit` dispatch. The ready pass is
 * the only pass allowed through to Electron.
 */
export class AppQuitCoordinator {
  private currentPhase: AppQuitPhase = 'running'
  private drainOperation: Promise<void> | undefined

  constructor(private readonly options: AppQuitCoordinatorOptions) {}

  get phase(): AppQuitPhase {
    return this.currentPhase
  }

  handleBeforeQuit(event: AppBeforeQuitEvent): void {
    if (this.currentPhase === 'ready') return
    event.preventDefault()
    if (this.currentPhase === 'draining') return

    this.setPhase('draining')
    let operation: Promise<void>
    try {
      operation = Promise.resolve(this.options.drain())
    } catch (error) {
      operation = Promise.reject(error)
    }
    this.drainOperation = operation.then(
      () => undefined,
      (error: unknown) => {
        this.report(error)
      }
    ).then(() => {
      this.setPhase('ready')
      let quitRequested = false
      const quit = (): void => {
        if (quitRequested) return
        quitRequested = true
        try {
          this.options.quit()
        } catch (error) {
          this.report(error)
        }
      }
      try {
        this.options.schedule(quit)
      } catch (error) {
        this.report(error)
        setImmediate(quit)
      }
    })
    // The coordinator owns this rejection observer even if a caller never
    // observes the internal operation. `drain()` failure is reported above and
    // cannot suppress the final native quit pass.
    void this.drainOperation.catch(() => undefined)
  }

  private setPhase(phase: AppQuitPhase): void {
    this.currentPhase = phase
    try {
      this.options.onPhaseChange?.(phase)
    } catch (error) {
      this.report(error)
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onDrainError?.(error)
    } catch {
      // Diagnostics never own or block the native quit transition.
    }
  }
}
