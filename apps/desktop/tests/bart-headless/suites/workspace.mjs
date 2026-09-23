import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { exactCallDirective } from '../bart.mjs'
import {
  assertContainsToken,
  assertMissing,
  bounded,
  findThread,
  shellQuote
} from '../support.mjs'

const run = promisify(execFile)
const PROOF_FILE = 'acceptance-proof.txt'

/**
 * Workspace ownership is Core's, not the Harness'. These cases prove that an
 * omitted cwd really produces an isolated temporary workspace and that a
 * requested Git worktree really executes in its own checkout.
 */
export const workspaceSuite = {
  id: 'workspace',
  tier: 'extended',
  description: 'Temporary workspaces and Git worktrees observed from real work',
  cases: [
    {
      id: 'temporary-workspace',
      requires: ['shell'],
      description: 'an omitted cwd isolates the Thread in its own workspace',
      async run(context) {
        const marker = `WORKSPACE_OK:${context.token}`
        const { threadId } = await context.start({
          options: context.permissiveOptions(),
          prompt: writeInWorkspacePrompt(context, marker)
        })
        const terminal = await context.waitForCompleted(threadId)
        assertContainsToken(terminal.summary, marker, bounded(terminal))

        const thread = findThread(await context.client.loadState(), threadId)
        const temporaryRoot = await realpath(join(context.openAgentHome, 'tmp-workspaces'))
        const relativeCwd = relative(temporaryRoot, await realpath(thread.cwd))
        assert.notEqual(thread.cwd, context.repositoryRoot)
        assert.ok(
          relativeCwd !== '' && relativeCwd !== '..' &&
            !relativeCwd.startsWith(`..${sep}`) && !isAbsolute(relativeCwd),
          `the Thread did not receive an owned temporary workspace: ${thread.cwd}`
        )
        assert.equal(await readFile(join(thread.cwd, PROOF_FILE), 'utf8'), context.token)
        await assertMissing(
          join(context.repositoryRoot, PROOF_FILE),
          'repository proof'
        )
        return { threadId, cwd: thread.cwd }
      }
    },
    {
      id: 'git-worktree',
      requires: ['shell'],
      description: 'a requested worktree executes in its own checkout',
      async run(context) {
        const baseCwd = await context.createTemporaryGitRepository()
        const marker = `WORKTREE_OK:${context.token}`
        const { threadId } = await context.start({
          cwd: baseCwd,
          worktree: true,
          options: context.permissiveOptions(),
          prompt: writeInWorkspacePrompt(context, marker)
        })
        const terminal = await context.waitForCompleted(threadId)
        assertContainsToken(terminal.summary, marker, bounded(terminal))

        const thread = findThread(await context.client.loadState(), threadId)
        assert.ok(thread.worktree, `the Thread has no worktree record: ${bounded(thread)}`)
        assert.equal(thread.worktree.baseCwd, baseCwd)
        const worktreeCwd = thread.worktree.cwd
        assert.ok(worktreeCwd, `the worktree has no checkout path: ${bounded(thread.worktree)}`)
        assert.notEqual(worktreeCwd, baseCwd)
        // The record keeps the requested base workspace; the isolated checkout
        // the Harness actually executes in is only ever the worktree cwd.
        assert.equal(thread.cwd, baseCwd)

        assert.equal(await readFile(join(worktreeCwd, PROOF_FILE), 'utf8'), context.token)
        await assertMissing(join(baseCwd, PROOF_FILE), 'base checkout proof')
        const listed = await run('git', ['worktree', 'list', '--porcelain'], { cwd: baseCwd })
        assert.match(
          listed.stdout,
          new RegExp(`worktree ${escapeForList(worktreeCwd)}`),
          `Git does not know the created worktree: ${listed.stdout}`
        )

        const statusOperation = await context.bart.askForTool({
          name: 'thread_status',
          expectedArguments: { threadId },
          directive: exactCallDirective(
            'Inspect the worktree acceptance Thread.',
            'thread_status',
            { threadId }
          )
        })
        assert.equal(
          statusOperation.result.thread.workspace?.worktreeCwd,
          worktreeCwd,
          `the public workspace projection lost the worktree: ${bounded(statusOperation.result)}`
        )
        return { threadId, baseCwd, worktreeCwd }
      }
    },
    {
      id: 'unusable-cwd-is-rejected',
      requires: ['plain'],
      description: 'a missing cwd fails the start tool without creating a Thread',
      async run(context) {
        const missingCwd = join(context.runRoot, `absent-${context.token}`)
        const startArguments = context.startArguments({
          cwd: missingCwd,
          worktree: false,
          options: context.options(),
          prompt: `This start must be rejected. Marker ${context.token}.`
        })
        const before = await context.client.loadState()
        const { message } = await context.bart.askForToolFailure({
          name: 'thread_create',
          expectedArguments: startArguments,
          errorPattern: /cwd/,
          directive: exactCallDirective(
            'Attempt one deliberately invalid Thread start.',
            'thread_create',
            startArguments,
            ['Report the tool error verbatim. Do not retry with a different cwd.']
          )
        })
        const after = await context.client.loadState()
        assert.equal(
          after.threads.length,
          before.threads.length,
          'a rejected start still created a Thread'
        )
        return { message }
      }
    },
    {
      id: 'worktree-without-cwd-is-rejected',
      requires: ['plain'],
      description: 'worktree requires an explicit Git workspace',
      async run(context) {
        const startArguments = context.startArguments({
          worktree: true,
          options: context.options(),
          prompt: `This start must be rejected. Marker ${context.token}.`
        })
        const before = await context.client.loadState()
        const { message } = await context.bart.askForToolFailure({
          name: 'thread_create',
          expectedArguments: startArguments,
          errorPattern: /参数无效|invalid/i,
          directive: exactCallDirective(
            'Attempt one deliberately invalid Thread start.',
            'thread_create',
            startArguments,
            ['Report the tool error verbatim. Do not retry with a cwd.']
          )
        })
        const after = await context.client.loadState()
        assert.equal(
          after.threads.length,
          before.threads.length,
          'a rejected start still created a Thread'
        )
        return { message }
      }
    },
    {
      id: 'non-git-worktree-is-rejected',
      scope: 'once',
      requires: ['plain'],
      description: 'worktree creation refuses a directory outside a Git repository',
      async run(context) {
        const cwd = join(context.runRoot, `non-git-${context.token}`)
        await mkdir(cwd, { recursive: true })
        const startArguments = context.startArguments({
          cwd,
          worktree: true,
          options: context.options(),
          prompt: `This worktree start must be rejected. Marker ${context.token}.`
        })
        const before = await context.client.loadState()
        const { message } = await context.bart.askForToolFailure({
          name: 'thread_create',
          expectedArguments: startArguments,
          errorPattern: /git|repository|仓库|worktree/i,
          directive: exactCallDirective(
            'Attempt one worktree start from a non-Git directory.',
            'thread_create',
            startArguments,
            ['Report the tool error verbatim. Do not retry without worktree.']
          )
        })
        const after = await context.client.loadState()
        assert.equal(
          after.threads.length,
          before.threads.length,
          'a rejected non-Git worktree start still created a Thread'
        )
        return { cwd, message }
      }
    }
  ]
}

function writeInWorkspacePrompt(context, marker) {
  const command = `printf %s ${shellQuote(context.token)} > ${shellQuote(PROOF_FILE)}`
  return [
    `This is a native ${context.harness} workspace acceptance case.`,
    `Run exactly this command in your working directory with the native ${context.provider.permissionTool} tool: ${command}`,
    'Use a relative path. Do not write anywhere else and do not change directory.',
    `After the command succeeds, reply with exactly ${marker}.`
  ].join('\n')
}

function escapeForList(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
