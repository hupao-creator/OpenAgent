// Native GPU regression; run on a graphical macOS host, without fake timers or GPU mocks.
import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const require = createRequire(import.meta.url)
const tests = dirname(fileURLToPath(import.meta.url))
const core = require.resolve('@liquid-dom/core', { paths: [dirname(require.resolve('@liquid-dom/react'))] })
const evidence = await mkdtemp(join(tmpdir(), 'oa-liquid-capture-'))
const server = await createServer({
  configFile: false, root: join(tests, 'fixtures'),
  resolve: { alias: {
    '@liquid-dom/core': join(dirname(core), 'index.js'),
    // Production CSS is copied unchanged into dist; use its source so this
    // standalone regression also works before workspace packages are built.
    '@openagent/plugin-kit/renderer/styles.css': resolve(tests, '../../../packages/openagent-plugin-kit/src/renderer/components.css')
  } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [resolve(tests, '../../..')] } }
})
try {
  await server.listen()
  const url = server.resolvedUrls.local[0] + 'liquid-capture.html'
  const env = { ...process.env, LIQUID_TEST_URL: url, LIQUID_TEST_EVIDENCE: evidence }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(process.env.LIQUID_TEST_ELECTRON || require('electron'), [join(tests, 'fixtures/liquid-capture-bootstrap.cjs')], { env, stdio: 'inherit' })
  const code = await new Promise((yes, no) => { child.once('error', no); child.once('exit', yes) })
  if (code !== 0) throw new Error(`Liquid capture regression failed (${code}); evidence: ${evidence}`)
} finally {
  await server.close()
  console.log(`Liquid capture evidence: ${evidence}`)
}
