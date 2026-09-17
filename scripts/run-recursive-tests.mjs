#!/usr/bin/env node
/** The root test chain has just built every package (generate:registry); the
 * recursive phase reuses that pass instead of rebuilding per package, which
 * would serialize three full-workspace passes behind the build lock.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpmPath = process.env.npm_execpath
const useNode = pnpmPath && /pnpm(?:\.c?js)?$/i.test(pnpmPath)
// Forward focused/update arguments (pnpm test -- -t foo) to every suite.
const forwarded = process.argv.slice(2)
const result = spawnSync(useNode ? process.execPath : 'pnpm', useNode
  ? [pnpmPath, '-r', 'test', ...(forwarded.length ? ['--', ...forwarded] : [])]
  : ['-r', 'test', ...(forwarded.length ? ['--', ...forwarded] : [])], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, OPENAGENT_SKIP_PACKAGE_BUILD: '1' },
  shell: !useNode && process.platform === 'win32'
})
if (result.error || result.status !== 0) {
  throw new Error(`run-recursive-tests: 失败（${result.error?.message ?? result.signal ?? `exit ${result.status}`}）`)
}
