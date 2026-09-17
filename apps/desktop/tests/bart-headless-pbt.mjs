#!/usr/bin/env node
/**
 * Bart headless state-machine property-based acceptance entry point.
 *
 * The properties, generated commands, independent model, and replay reporting
 * live in ./bart-headless/pbt/. This file only wires the CLI to the runner so
 * that `pnpm test:bart-headless:pbt` keeps one stable path.
 */
import { main } from './bart-headless/pbt/runner.mjs'

// The plan listing and the failure report are long enough to be piped into a
// pager; a closed stdout must end the process quietly.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error
    cancel('closed output pipe', 0, true)
  })
}

const controller = new AbortController()
let signalExitCode
const interrupt = () => cancel('SIGINT', 130)
const terminate = () => cancel('SIGTERM', 143)
function cancel(signal, exitCode, quiet = false) {
  if (controller.signal.aborted) return
  signalExitCode = exitCode
  if (!quiet) process.stderr.write(`${signal}: cancelling PBT and awaiting sample cleanup\n`)
  controller.abort(new Error(`PBT cancelled by ${signal}`))
}
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal })
} catch (error) {
  if (signalExitCode !== 0) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  if (signalExitCode !== 0 && process.env.OPENAGENT_ACCEPTANCE_DEBUG === '1' && error instanceof Error) {
    process.stderr.write(`${error.stack}\n`)
  }
  process.exitCode = 1
} finally {
  process.off('SIGINT', interrupt)
  process.off('SIGTERM', terminate)
  if (signalExitCode !== undefined) process.exitCode = signalExitCode
}
