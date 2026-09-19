import { spawnSync } from 'node:child_process'

export const fullSteps = [
  'install', 'toolchain', 'registry', 'registry-diff', 'typecheck', 'lint',
  'regressions', 'browser-install', 'development', 'build', 'report-runtime',
  'lifecycle-runtime', 'tracked-diff'
]
const stepOrder = ['pr-gate-tests', 'script-syntax', 'dev-scripts', ...fullSteps]
const gateFiles = new Set(['scripts/pr-gate.py', 'scripts/pr_gate_lib.py', 'scripts/tests/test_pr_gate.py'])
const developmentFiles = new Set(['scripts/dev.mjs', 'scripts/dev-main.mjs', 'scripts/electron-vite-server-host.mjs', 'apps/desktop/scripts/watch-desktop.mjs'])
const appToolFiles = new Set(['scripts/dev-app-lib.mjs', 'scripts/install-dev-app.mjs', 'scripts/open-dev-app.mjs'])

function isDocumentation(path) {
  return /^(?:docs\/|apps\/desktop\/docs\/).*\.md$/.test(path)
    || /^(?:README\.md|packages\/README\.md|packages\/HARNESS_PLUGIN_GUIDE\.md|apps\/desktop\/BUILDING\.md)$/.test(path)
    || /^packages\/[^/]+\/(?:README\.md|docs\/.*\.md)$/.test(path)
}

// Include reverse dependencies transitively, including dev/peer/optional edges.
// Test helpers and shared contracts can affect consumers just like runtime code.
export function affectedWorkspaces(names, workspaces) {
  const affected = new Set(names)
  let changed = true
  while (changed) {
    changed = false
    for (const workspace of workspaces) {
      if (!affected.has(workspace.name) && workspace.dependencies.some(name => affected.has(name))) {
        affected.add(workspace.name)
        changed = true
      }
    }
  }
  return [...affected].sort()
}

// CSS is not reliably represented in the JS import graph. Map known surfaces explicitly.
const assetTests = {
  'apps/desktop/src/renderer/src/components/bart-reply.css': [
    'apps/desktop/tests/bart-reply-lifecycle.dom.test.tsx',
    'apps/desktop/tests/bart-reply-navigation.dom.test.tsx'
  ]
}

export function selectTestJobs(files, targets, workspaces, existingFiles) {
  return workspaces.filter(item => targets.includes(item.name) && item.hasTests).map(workspace => {
    const inputs = new Set()
    let related = false
    let fallback = false
    const notes = []
    for (const path of files) {
      if (isDocumentation(path) || gateFiles.has(path)) continue
      if (!path.startsWith(`${workspace.path}/`) || (existingFiles && !existingFiles.includes(path))) {
        fallback = true
        continue
      }
      if (assetTests[path]) {
        assetTests[path].forEach(test => inputs.add(test))
        notes.push('CSS mapping covers DOM behavior, not screenshot/pixel appearance.')
      } else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)) {
        inputs.add(path)
      } else if (/\.[cm]?[jt]sx?$/.test(path) && path.includes('/src/') && !path.endsWith('.d.ts')) {
        related = true
        inputs.add(path)
      } else {
        fallback = true
      }
    }
    if (existingFiles && [...inputs].some(path => !existingFiles.includes(path))) fallback = true
    return { workspace: workspace.name, mode: fallback || !inputs.size ? 'suite' : related ? 'related' : 'files',
      inputs: fallback ? [] : [...inputs], notes,
      reason: fallback ? 'Cross-workspace, deleted, configuration or unmapped input: run workspace suite.' : 'Changed tests, mapped assets and source import dependencies.' }
  })
}

export function selectPlan(files, { full = false, baseSha = null, mergeBase = null, workspaces = [], existingFiles } = {}) {
  const steps = new Set(['tracked-diff'])
  const scopes = new Set()
  const targets = new Set()
  const reasons = []
  const desktop = workspaces.find(workspace => workspace.path === 'apps/desktop')
  function add(...names) { names.forEach(name => steps.add(name)) }
  function product(names, { build = false, native = false } = {}) {
    names.forEach(name => targets.add(name))
    add('install', 'toolchain', 'registry', 'registry-diff', 'typecheck', 'lint', 'regressions')
    if (build) add('build')
    if (native) add('build', 'report-runtime', 'lifecycle-runtime')
  }
  if (full || !baseSha || files.length === 0) {
    reasons.push(full ? 'Full verification explicitly requested.' : !baseSha ? 'No comparison baseline supplied.' : 'Empty diff.')
  }
  for (const path of files) {
    if (isDocumentation(path)) { scopes.add('docs'); continue }
    if (gateFiles.has(path)) { scopes.add('pr-gate'); add('pr-gate-tests'); continue }
    if (/^scripts\/tests\/.*\.(?:test\.mjs|py)$/.test(path) && !path.includes('verification')) {
      scopes.add('tooling-tests'); add('dev-scripts'); continue
    }
    if (appToolFiles.has(path)) { scopes.add('app-tooling'); add('script-syntax', 'dev-scripts'); continue }
    if (developmentFiles.has(path) && desktop) {
      scopes.add('development')
      product([desktop.name], { build: true })
      add('dev-scripts', 'browser-install', 'development')
      continue
    }
    // Manifests/configuration, verifier changes and unknown paths fall through to full.
    const workspace = workspaces.find(item => path.startsWith(`${item.path}/`))
    if (!workspace || !desktop) { reasons.push(`Unclassified path: ${path}`); continue }
    const relative = path.slice(workspace.path.length + 1)
    if (relative.startsWith('src/')) {
      const renderer = relative.startsWith('src/renderer/')
      scopes.add(workspace === desktop ? (renderer ? 'renderer' : 'main-shared') : 'packages')
      const affected = affectedWorkspaces([workspace.name], workspaces)
      product(affected, { build: affected.includes(desktop.name), native: !renderer && affected.includes(desktop.name) })
      // Appearance and settings clipping need the native window/compositor.
      if (renderer && /(?:appearance|theme|window|settings-page|HarnessSettingsPage)/i.test(relative)) add('build', 'lifecycle-runtime')
      continue
    }
    if (relative.startsWith('tests/')) {
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative)) {
        scopes.add('tests')
        product([workspace.name])
      } else if (workspace === desktop && relative === 'tests/report-runtime.electron.mjs') {
        scopes.add('report-runtime'); add('install', 'toolchain', 'registry', 'registry-diff', 'lint', 'build', 'report-runtime')
      } else if (workspace === desktop && ['tests/app-lifecycle.electron.mjs', 'tests/application-appearance.electron.mjs', 'tests/settings-transition.electron.mjs'].includes(relative)) {
        scopes.add('lifecycle-runtime'); add('install', 'toolchain', 'registry', 'registry-diff', 'lint', 'build', 'lifecycle-runtime')
      } else {
        // Fixtures/helpers can be shared by native tests; do not guess their import graph.
        reasons.push(`Shared or standalone test support: ${path}`)
      }
      continue
    }
    reasons.push(`Configuration or unclassified path: ${path}`)
  }
  const isFull = reasons.length > 0
  return {
    version: 2, workspaces, testJobs: isFull ? [] : selectTestJobs(files, [...targets], workspaces, existingFiles), profile: isFull ? 'full' : 'scoped', baseSha, mergeBase, files,
    scopes: isFull ? ['full'] : [...scopes].sort(),
    reasons: isFull ? reasons : ['Union of changed areas and transitive workspace consumers.'],
    targets: isFull ? workspaces.map(item => item.name).sort() : [...targets].sort(),
    requiredSteps: isFull ? [...fullSteps] : stepOrder.filter(name => steps.has(name)),
    skippedSteps: isFull ? [] : fullSteps.filter(name => !steps.has(name))
  }
}

export function planVerification({ cwd, sha, base, full = false }) {
  function git(...args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    if (result.error || result.status !== 0) throw new Error(`Cannot determine verification scope: ${result.error?.message || result.stderr}`)
    return result.stdout
  }
  if (!base) return selectPlan([], { full })
  const baseSha = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim()
  const mergeBase = git('merge-base', baseSha, sha).trim()
  // Both rename paths participate; NUL delimiters preserve arbitrary filenames.
  const files = git('diff', '--name-only', '--no-renames', '-z', mergeBase, sha, '--').split('\0').filter(Boolean)
  const existingFiles = git('ls-tree', '-r', '--name-only', '-z', sha).split('\0')
  const manifests = existingFiles.filter(path => /^(?:apps\/desktop|packages\/[^/]+)\/package\.json$/.test(path))
  const workspaces = manifests.map(path => {
    const metadata = JSON.parse(git('show', `${sha}:${path}`))
    return {
      path: path.slice(0, -'/package.json'.length), name: metadata.name, hasTests: Boolean(metadata.scripts?.test),
      dependencies: Object.keys({ ...metadata.dependencies, ...metadata.devDependencies, ...metadata.peerDependencies, ...metadata.optionalDependencies })
    }
  })
  return selectPlan(files, { full, baseSha, mergeBase, workspaces, existingFiles })
}

export function assertPlanCompleted(plan, steps) {
  const passed = new Set(steps.filter(step => step.status === 'passed').map(step => step.name))
  const missing = plan.requiredSteps.filter(name => !passed.has(name))
  if (missing.length) throw new Error(`Required verification steps did not pass: ${missing.join(', ')}`)
}

// Drain every running task before cleanup, including when a sibling rejects.
export async function runVerificationGroup(tasks, serial = false) {
  if (serial) { for (const task of tasks) await task(); return }
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}
