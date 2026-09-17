import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const run = promisify(execFile)

/** Read only this sample's tagged processes; never persist the process environment. */
async function ownedProcesses(token) {
  const { stdout } = await run('/bin/ps', ['axeww', '-o', 'pid=,pgid=,lstart=,command='], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 10_000
  })
  const marker = `OPENAGENT_PBT_SAMPLE=${token}`
  return stdout.split('\n').flatMap(line => {
    const fields = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.*)$/)
    if (!fields || !fields[4].split(/\s+/).includes(marker)) return []
    return [{ pid: Number(fields[1]), pgid: Number(fields[2]), started: fields[3] }]
  })
}

/** The tag is inherited by real detached CLIs, so reparenting cannot hide a leak. */
export class SampleResources {
  constructor(token, artifactPath) {
    this.token = token
    this.artifactPath = artifactPath
    this.observed = new Map()
  }

  async capture() {
    const processes = await ownedProcesses(this.token)
    for (const row of processes) this.observed.set(`${row.pid}:${row.started}`, row)
    return processes
  }

  async assertReleased() {
    const deadline = Date.now() + 2_000
    let remaining = await this.capture()
    while (remaining.length && Date.now() < deadline) {
      await delay(100)
      remaining = await this.capture()
    }
    const errors = []
    try {
      await writeFile(this.artifactPath, JSON.stringify({
        observed: [...this.observed.values()], remaining, released: remaining.length === 0
      }, null, 2) + '\n')
    } catch (error) { errors.push(error) }
    // Clean up only freshly reidentified test-owned PIDs. Cleanup cannot turn a
    // leak into a pass; the original remaining set is the verdict below.
    if (remaining.length) {
      try {
        for (const row of await ownedProcesses(this.token)) {
          try { process.kill(row.pid, 'SIGKILL') } catch (error) {
            if (error.code !== 'ESRCH') errors.push(error)
          }
        }
      } catch (error) { errors.push(error) }
    }
    try {
      assert.equal(remaining.length, 0,
        `sample leaked native processes: ${remaining.map(row => row.pid).join(',')}`)
    } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'sample resource evidence or cleanup failed')
  }
}
