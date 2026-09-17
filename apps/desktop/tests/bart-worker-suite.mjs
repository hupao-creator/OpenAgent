import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cwd = fileURLToPath(new URL('..', import.meta.url))
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(result.status === 75 ? 'BART_ENVIRONMENT_INCONCLUSIVE:' : 'Bart suite command failed:', command, args, { status: result.status, signal: result.signal })
    process.exit(result.status ?? 1)
  }
}

// Real visible Electron windows run serially. Never overlap measurement with
// bundling, unit tests, PNG encoding from another case, or another native test.
run('pnpm', ['exec', 'vite', 'build', '--config', 'labs/bart/vite.config.ts'])
run(process.execPath, ['tests/bart-generation-visuals.electron.mjs'])
run(process.execPath, ['tests/bart-regressions.electron.mjs'])
run(process.execPath, ['tests/bart-handoff.electron.mjs'])
for (const scenario of [
  ['0', '1500'],
  ['2000', '2600'], ['5000', '1500'], ['--residents'],
  ['--message', '2000'], ['--message', '5000'],
  ['--generation', '2000', '2500'], ['--generation', '5000', '1400'],
  ['--cross-page', '2000'], ['--cross-page', '5000'],
  ['--camera', '2000'], ['--camera', '5000'],
  ['--cross-page', '2000', '--interrupt'], ['--cross-page', '5000', '--interrupt'],
  ['--camera', '2000', '--interrupt'], ['--camera', '5000', '--interrupt'],
  ['--settings', '2000'], ['--settings', '5000']
]) run(process.execPath, ['tests/bart-worker-isolation.electron.mjs', ...scenario])

// Use the locked packager's ASAR implementation, exactly as desktop packaging
// does. loadFile must resolve the dedicated Worker with production security.
const require = createRequire(import.meta.url)
const builder = createRequire(require.resolve('electron-builder'))
const packager = createRequire(builder.resolve('app-builder-lib'))
const { createPackage } = packager('@electron/asar')
const directory = mkdtempSync(join(tmpdir(), 'bart-packaged-'))
try {
  const archive = join(directory, 'app.asar')
  await createPackage(join(cwd, 'out/bart-lab'), archive)
  run(process.execPath, ['tests/bart-worker-isolation.electron.mjs', '2000', '2600'],
    { ...process.env, BART_ISOLATION_ENTRY: join(archive, 'isolation.html') })
} finally { rmSync(directory, { recursive: true, force: true }) }
