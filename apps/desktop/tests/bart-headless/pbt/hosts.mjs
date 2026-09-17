import { HARNESS_IDS, HOST_HARNESS_IDS } from '../providers.mjs'

/** Preserve product auto-selection while keeping a run's replay host concrete. */
export class HostSelection {
  constructor(requested, config, targets) {
    this.requested = requested ?? config.hosts?.[0] ?? HARNESS_IDS[0]
    this.actual = null
    if (this.requested !== 'auto' && !HOST_HARNESS_IDS.includes(this.requested)) {
      throw new Error(`${this.requested} does not declare the Bart host capabilities`)
    }
    this.requiredClis = [...new Set([...(this.requested === 'auto' ? [] : [this.requested]), ...targets])]
    this.probeClis = [...new Set([...this.requiredClis,
      ...(this.requested === 'auto' ? HOST_HARNESS_IDS : [])])]
  }

  accept({ actualHost }, versions) {
    if (!HOST_HARNESS_IDS.includes(actualHost)) throw new Error(`auto selected unsupported Bart host ${actualHost}`)
    if (!versions[actualHost] || versions[actualHost].startsWith('unavailable:')) {
      throw new Error(`selected Bart host ${actualHost} is unavailable: ${versions[actualHost] ?? 'not probed'}`)
    }
    if (this.actual !== null && this.actual !== actualHost) {
      throw new Error(`Bart host changed within the run: ${this.actual} -> ${actualHost}`)
    }
    this.actual = actualHost
  }
}
