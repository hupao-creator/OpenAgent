#!/usr/bin/env node
/** Creates the `verify` check run from the payload a finished `verify` run uploaded.
 *
 *  This runs from the default branch, because a `workflow_run` workflow always does,
 *  so the credential that can write checks never reaches the pull request's code. The
 *  pull request contributes only `check-run.json`; the head, the base and the
 *  repository it is bound to come from the event, which no pull request can forge. */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const context = 'verify'
const commitSha = /^[a-f0-9]{40}$/
const proofPattern = /scope-v2:(?:full|scoped):([a-f0-9]{40}):([a-f0-9]{40})/
const conclusions = new Set(['success', 'failure'])
const directory = resolve(process.env.VERIFY_EVIDENCE || join(process.env.RUNNER_TEMP || tmpdir(), 'verification-evidence'))
const repository = process.env.GITHUB_REPOSITORY
const head = process.env.VERIFY_HEAD || ''
const base = process.env.VERIFY_BASE || ''
const failure = run()
if (failure) {
  console.error(`::error::verify-publish: ${failure}`)
  process.exitCode = 1
}

function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Usage: node scripts/verify-publish.mjs

Publishes the \`verify\` check run on the verified head from the evidence a finished
\`verify\` run uploaded. Reads the trusted head and base from the workflow_run event
(VERIFY_HEAD, VERIFY_BASE, VERIFY_EVENT, VERIFY_HEAD_REPOSITORY, GITHUB_REPOSITORY),
the payload from $VERIFY_EVIDENCE/check-run.json, and needs GITHUB_TOKEN to write.
Nothing is published for a run that was not a same-repository pull request, and a
missing payload is left unpublished rather than reported.`)
    return null
  }
  // A run that was superseded by `cancel-in-progress` uploads no payload and must not
  // report anything: the replacement run publishes for the head it was cancelled for.
  if (!existsSync(join(directory, 'check-run.json'))) return skip('no check-run payload was uploaded')
  if (process.env.VERIFY_EVENT !== 'pull_request') return skip(`the verify run was triggered by ${process.env.VERIFY_EVENT || 'an unknown event'}`)
  if (process.env.VERIFY_HEAD_REPOSITORY !== repository) return skip('the head repository is not this repository, so the pull request is not verifiable here')
  if (!commitSha.test(head) || !commitSha.test(base)) return 'the event did not report a head and base commit'
  if (!process.env.GITHUB_TOKEN) return 'GITHUB_TOKEN is not set'
  try {
    const payload = JSON.parse(readFileSync(join(directory, 'check-run.json'), 'utf8'))
    if (payload.name !== context) return `the payload names the check ${JSON.stringify(payload.name)}`
    if (payload.head_sha !== head) return `the payload verifies ${payload.head_sha}, but the run was for ${head}`
    if (!conclusions.has(payload.conclusion)) return `the payload reports an unusable conclusion: ${JSON.stringify(payload.conclusion)}`
    const proof = proofPattern.exec(payload.output?.summary ?? '')
    // The evidence line is what the gate reads back. Binding both commits to the event
    // keeps a payload from naming a head or base the run never covered.
    if (!proof || proof[1] !== head || proof[2] !== base) return 'the payload evidence does not name this run\'s head and base'
    publish(payload)
    console.log(`Published ${payload.conclusion} ${context} check run on ${head}.`)
    return null
  } catch (error) {
    return error.message
  }
}

function skip(reason) {
  console.log(`verify-publish: skipped, ${reason}.`)
  return null
}

function publish(payload) {
  const body = {
    name: context,
    head_sha: head,
    status: 'completed',
    conclusion: payload.conclusion,
    completed_at: new Date().toISOString(),
    details_url: process.env.VERIFY_RUN_ID
      ? `https://github.com/${repository}/actions/runs/${process.env.VERIFY_RUN_ID}`
      : `https://github.com/${repository}`,
    output: payload.output
  }
  const result = spawnSync('gh', ['api', '--method', 'POST', `repos/${repository}/check-runs`, '--input', '-'], {
    input: JSON.stringify(body), encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  })
  if (result.error || result.status !== 0) {
    throw new Error(`cannot publish the check run: ${result.error?.message || result.stderr || `exit ${result.status}`}`)
  }
}
