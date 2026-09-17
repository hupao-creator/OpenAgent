// Report Thread runtime 的真实 Electron 回归（Node 驱动）。
//
// 覆盖 .agents/architecture.md 的 Report HTML 边界及 src/main/report-runtime.ts：任意 JavaScript 可执行，
// 但报告拿不到 preload / window.openAgent / Node / 宿主 DOM / 宿主会话；
// 页面内导航留在报告视图里，file: 被拒绝，window.open 的外部地址交给系统浏览器。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const testDirectory = dirname(fileURLToPath(import.meta.url))
const desktopRoot = dirname(testDirectory)
const outputDirectory = await mkdtemp(join(tmpdir(), 'oa-report-runtime-'))

try {
  await build({
    configFile: false,
    logLevel: 'warn',
    build: {
      emptyOutDir: true,
      outDir: outputDirectory,
      minify: false,
      ssr: true,
      lib: {
        entry: join(desktopRoot, 'src/main/report-runtime.ts'),
        formats: ['es'],
        fileName: () => 'report-runtime.mjs'
      },
      rollupOptions: { external: ['electron'] }
    }
  })

  const require = createRequire(import.meta.url)
  const electronBinary = require('electron')
  const child = spawn(
    electronBinary,
    [join(testDirectory, 'report-runtime.electron-main.mjs')],
    {
      env: {
        ...process.env,
        REPORT_RUNTIME_BUNDLE: join(outputDirectory, 'report-runtime.mjs'),
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
      },
      stdio: ['ignore', 'pipe', 'inherit']
    }
  )
  let stdout = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  const exitCode = await new Promise((resolve) => child.on('close', resolve))
  const line = stdout.split('\n').find((entry) => entry.startsWith('REPORT_RUNTIME_RESULT '))
  assert.ok(line, `report runtime probe produced no result (exit ${exitCode}): ${stdout || '(no output)'}`)
  const result = JSON.parse(line.slice('REPORT_RUNTIME_RESULT '.length))
  assert.ok(result.ok, `report runtime probe failed: ${result.message}`)

  // 文档内脚本照常执行。
  assert.equal(result.scriptTitle, 'script-ran')
  assert.deepEqual(result.failures, [])

  // 宿主隔离。
  assert.equal(result.preload, null, 'report runtime must not load a preload script')
  assert.equal(result.probe.openAgent, 'undefined')
  assert.equal(result.probe.require, 'undefined')
  assert.equal(result.probe.process, 'undefined')
  assert.equal(result.probe.module, 'undefined')
  assert.equal(result.probe.hostMarker, 'absent', 'report must not see the host DOM')
  assert.equal(result.nodeIntegration, false)
  assert.equal(result.contextIsolation, true)
  assert.equal(result.sandbox, true)
  // 隔离靠边界，不靠关掉 Chromium 的安全机制。
  assert.equal(result.webSecurity, true)

  // 探针窗口全程不上屏：报告边界不靠让运行者看见一个真实窗口来成立。
  assert.equal(result.hostWindowVisible, false, 'report runtime probe must stay off screen')
  assert.equal(result.hostWindowShown, false, 'report runtime probe must never reach the show boundary')

  // 独立浏览器会话：不继承宿主 cookie。
  assert.equal(result.sharesHostSession, false)
  assert.equal(result.usesPersistentReportPartition, true)
  assert.equal(result.hostCookieCount, 1)
  assert.equal(result.reportCookieCount, 0)

  assert.equal(
    result.afterRetiredReferenceNavigation,
    'openagent-report://11111111-2222-4333-8444-555555555555/'
  )

  // 导航。
  assert.match(result.hashHref, /^openagent-report:\/\/.+#section$/)
  assert.ok(
    result.afterFileNavigation.startsWith('openagent-report://'),
    `file: navigation must be refused, got ${result.afterFileNavigation}`
  )
  assert.deepEqual(result.openedExternally, ['https://example.com/report'])
  assert.equal(result.windowCountAfter, result.windowCountBefore, 'window.open must not create an Electron window')

  assert.deepEqual(result.escapedMarkup, {
    headingCount: 0,
    text: '<h2>结论摘要</h2> <p>正文</p>'
  })
  assert.deepEqual(result.entityMarkup, [
    { headingCount: 0, text: '<h2>Heading</h2>' },
    { headingCount: 0, text: '<h2>Heading</h2>' },
    { headingCount: 0, text: '<h2>Heading</h2>' },
    { headingCount: 0, text: '<h2>Heading</h2>' },
    { headingCount: 0, text: '≪h2≫' }
  ])
  assert.deepEqual(result.correctedMarkup, {
    heading: '结论摘要',
    cell: '正文',
    code: '<h2>示例</h2>'
  })

  // 报告自身的早期跳转不是加载失败：实例存活，最终停在 localhost 页面上。
  assert.equal(result.redirectError, null, `self-navigation must not surface as a failure: ${result.redirectError}`)
  assert.deepEqual(result.redirectFailures, [])
  assert.ok(
    result.redirectUrl.startsWith('http://127.0.0.1:'),
    `self-navigation must stay in the report view, got ${result.redirectUrl}`
  )
  assert.equal(result.redirectBody, 'hopped')

  // 离开报告即销毁运行实例。
  assert.equal(result.viewsAfterClose, 0)

  console.log('report runtime isolation OK')
} finally {
  await rm(outputDirectory, { recursive: true, force: true })
}
