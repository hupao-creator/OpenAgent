import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const turbo = join(repository, 'node_modules/turbo/bin/turbo')

test('real Turbo restores across worktrees, removes stale outputs and invalidates downstream builds', async context => {
  // Installing the declared toolchain is required, just like other dependency-backed checks.
  assert.ok(existsSync(turbo), 'Run pnpm install before build-cache integration tests')
  const root = mkdtempSync(join(tmpdir(), 'openagent-cache-test-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const original = join(root, 'original')
  mkdirSync(original)
  const write = (base, path, content) => {
    const target = join(base, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  function run(cwd, program, args, env = process.env) {
    const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    return result.stdout.trim()
  }
  const git = (...args) => run(original, 'git', args)
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Cache Test')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.hooksPath', '/dev/null')
  write(original, '.gitignore', 'node_modules/\n.turbo/\ndist/\n')
  write(original, 'package.json', JSON.stringify({ name: 'cache-fixture', private: true, packageManager: 'pnpm@10.17.1' }))
  write(original, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
  write(original, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .: {}\n  packages/a: {}\n  packages/b:\n    dependencies:\n      '@openagent/a':\n        specifier: workspace:*\n        version: link:../a\n")
  write(original, 'turbo.json', JSON.stringify({ globalEnv: ['OPENAGENT_BUILD_TOOLCHAIN', 'CACHE_TEST_FLAG'],
    tasks: { build: { dependsOn: ['^build'], outputs: ['dist/**'] } } }))
  mkdirSync(join(original, 'scripts'))
  copyFileSync(join(repository, 'scripts/cached-build.mjs'), join(original, 'scripts/cached-build.mjs'))
  for (const name of ['a', 'b']) {
    write(original, `packages/${name}/package.json`, JSON.stringify({ name: `@openagent/${name}`, version: '1.0.0',
      scripts: { build: 'node build.cjs' }, ...(name === 'b' ? { dependencies: { '@openagent/a': 'workspace:*' } } : {}) }))
    write(original, `packages/${name}/src/value.txt`, name)
    write(original, `packages/${name}/build.cjs`, `const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/value.txt', fs.readFileSync('src/value.txt','utf8') ${name === 'b' ? "+fs.readFileSync('../a/dist/value.txt','utf8')" : ''});`)
  }
  git('add', '.')
  git('commit', '-qm', 'cache fixture')
  // Resolve only Turbo from the host installation; package tasks use the real pnpm.
  const pnpm = join(root, 'pnpm.cjs')
  writeFileSync(pnpm, `if(process.argv[2]==='--version')console.log('10.17.1');else {const r=require('node:child_process').spawnSync(${JSON.stringify(turbo)},process.argv.slice(4),{stdio:'inherit'});process.exit(r.status??1)}`)
  const evidence = join(root, 'evidence')
  const env = { ...process.env, npm_execpath: pnpm, OPENAGENT_FORCE_BUILD: '0', OPENAGENT_BUILD_EVIDENCE_DIR: evidence }
  function build(cwd, extra = {}) {
    const previous = new Set(existsSync(evidence) ? readdirSync(evidence) : [])
    run(cwd, process.execPath, ['scripts/cached-build.mjs', 'packages'], { ...env, ...extra })
    const names = readdirSync(evidence).filter(name => !previous.has(name))
    assert.equal(names.length, 1)
    return JSON.parse(readFileSync(join(evidence, names[0]), 'utf8')).tasks
  }
  assert.ok(build(original).every(task => task.cache.status === 'MISS'))
  const linked = join(root, 'linked')
  git('worktree', 'add', '--detach', linked, 'HEAD')
  assert.ok(build(linked).every(task => task.cache.status === 'HIT'))
  assert.equal(readFileSync(join(linked, 'packages/b/dist/value.txt'), 'utf8'), 'ba')
  const output = join(linked, 'packages/b/dist/value.txt')
  const stable = statSync(output, { bigint: true })
  // Standalone recursive tests each build before importing shared package outputs.
  // Concurrent callers must leave a completed caller's artifacts untouched.
  const beforeConcurrent = new Set(readdirSync(evidence))
  await Promise.all([1, 2].map(() => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/cached-build.mjs', 'packages'], { cwd: linked, env })
    let log = ''
    child.stdout.on('data', data => { log += data })
    child.stderr.on('data', data => { log += data })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(log)))
  })))
  const concurrent = readdirSync(evidence).filter(name => !beforeConcurrent.has(name))
  assert.equal(concurrent.length, 2)
  assert.ok(concurrent.every(name => JSON.parse(readFileSync(join(evidence, name), 'utf8')).tasks.every(task => task.cache.status === 'UNCHANGED')))
  const after = statSync(output, { bigint: true })
  assert.equal(after.ino, stable.ino)
  assert.equal(after.mtimeNs, stable.mtimeNs)
  write(linked, 'packages/b/dist/value.txt', 'corrupted')
  assert.ok(build(linked).every(task => task.cache.status === 'HIT'))
  assert.equal(readFileSync(output, 'utf8'), 'ba')
  write(linked, 'packages/a/dist/stale.js', 'stale')
  assert.ok(build(linked).every(task => task.cache.status === 'HIT'))
  assert.equal(existsSync(join(linked, 'packages/a/dist/stale.js')), false)
  write(linked, 'packages/a/src/value.txt', 'changed')
  assert.ok(build(linked).every(task => task.cache.status === 'MISS'))
  assert.equal(readFileSync(join(linked, 'packages/b/dist/value.txt'), 'utf8'), 'bchanged')
  assert.ok(build(linked, { CACHE_TEST_FLAG: 'different' }).every(task => task.cache.status === 'MISS'))
})
