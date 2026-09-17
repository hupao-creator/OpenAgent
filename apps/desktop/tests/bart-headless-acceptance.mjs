#!/usr/bin/env node
/**
 * Bart headless native acceptance entry point.
 *
 * The matrix, the suites, and the parallel worker pool live in
 * ./bart-headless/. This file only wires the CLI to the runner so that
 * `pnpm test:bart-headless` keeps one stable path.
 */
import { main } from './bart-headless/runner.mjs'

// The matrix listing is long enough that operators pipe it into a pager; a
// closed stdout must end the process quietly rather than as an unhandled error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error
  })
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // Planning and startup failures are operator errors: report them as one line
  // and keep the stack behind an opt-in so the matrix output stays readable.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  if (process.env.OPENAGENT_ACCEPTANCE_DEBUG === '1' && error instanceof Error) {
    process.stderr.write(`${error.stack}\n`)
  }
  process.exitCode = 1
}
