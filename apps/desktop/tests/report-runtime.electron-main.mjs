// Electron 主进程侧的 Report Thread runtime 验证入口。
// 由 tests/report-runtime.electron.mjs 构建产物驱动，跑在真实 Electron 里：
// 只有这里能证明报告运行环境确实没有 preload、没有 Node、不共享宿主会话。
import { app, BrowserWindow, protocol, session, shell } from 'electron'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

const bundleUrl = pathToFileURL(process.env.REPORT_RUNTIME_BUNDLE).href
const {
  ReportRuntimeHost,
  REPORT_SCHEME_PRIVILEGES,
  REPORT_SESSION_PARTITION
} = await import(bundleUrl)

protocol.registerSchemesAsPrivileged([REPORT_SCHEME_PRIVILEGES])

const openedExternally = []
shell.openExternal = async (url) => {
  openedExternally.push(url)
}

const REPORT_ID = '11111111-2222-4333-8444-555555555555'
const REDIRECT_REPORT_ID = '22222222-3333-4444-8555-666666666666'
const REPORT_HTML = `<!doctype html><html><head><title>seed</title></head><body>
<p id="report-body">report</p>
<script>
  document.title = 'script-ran'
  window.__probe = {
    openAgent: typeof window.openAgent,
    require: typeof require,
    process: typeof process,
    module: typeof module,
    hostMarker: document.querySelector('#host-marker') === null ? 'absent' : 'present'
  }
</script>
</body></html>`

function fail(message) {
  console.log('REPORT_RUNTIME_RESULT ' + JSON.stringify({ ok: false, message }))
  app.exit(1)
}

app.whenReady().then(async () => {
  // 宿主会话里种一个 cookie；报告会话必须看不到它。
  await session.defaultSession.cookies.set({
    url: 'https://openagent.invalid/',
    name: 'host-session',
    value: 'secret'
  })

  // 探针跑在真实 Electron 进程里，回归不必让运行者看到 Dock 图标。
  if (process.platform === 'darwin') app.dock?.hide()
  const window = new BrowserWindow({ width: 900, height: 700, show: false })
  let shown = false
  window.on('show', () => { shown = true })
  await window.loadURL('data:text/html,<div id="host-marker">host</div>')

  const failures = []
  const host = new ReportRuntimeHost(
    window,
    (failure) => failures.push(failure)
  )
  await host.open(
    { id: REPORT_ID, html: REPORT_HTML },
    { x: 0, y: 0, width: 900, height: 600 }
  )

  const view = window.contentView.children.at(-1)
  const contents = view.webContents
  // 隔离与导航的断言都读 DOM、cookie 与 webPreferences，不需要窗口上屏，也不需要焦点
  // （全部交互都走 executeJavaScript）：窗口保持隐藏，回归才不会在运行者屏幕上弹出报告视图。
  await new Promise((resolve) => setTimeout(resolve, 100))
  const probe = await contents.executeJavaScript('window.__probe')
  const scriptTitle = await contents.executeJavaScript('document.title')
  const preferences = contents.getLastWebPreferences() || {}
  const reportCookies = await contents.session.cookies.get({ name: 'host-session' })
  const hostCookies = await session.defaultSession.cookies.get({ name: 'host-session' })
  const usesPersistentReportPartition =
    contents.session === session.fromPartition(REPORT_SESSION_PARTITION) &&
    REPORT_SESSION_PARTITION === 'persist:openagent-report'

  // 已移除的 Thread 引用协议不再是报告 runtime 的导航目标。
  await contents.executeJavaScript(
    "location.href = 'openagent-report://thread/retired?ref=claim-1'",
    true
  ).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const afterRetiredReferenceNavigation = contents.getURL()

  // 页面内导航留在报告视图里。
  await contents.executeJavaScript("location.hash = 'section'", true)
  const hashHref = contents.getURL()

  // file: 导航被拒绝，报告拿不到本地文件系统。
  await contents.executeJavaScript("location.href = 'file:///etc/hosts'", true).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const afterFileNavigation = contents.getURL()

  // window.open 的外部地址交给系统浏览器，不创建新的 Electron 窗口。
  const windowCountBefore = BrowserWindow.getAllWindows().length
  await contents.executeJavaScript("window.open('https://example.com/report', '_blank')", true)
  await new Promise((resolve) => setTimeout(resolve, 400))
  const windowCountAfter = BrowserWindow.getAllWindows().length

  // 已保存的整篇实体转义输入会原样显示标签；纠正输入后应生成真正的元素，
  // 同时保留 HTML 代码示例中的实体。runtime 本身不能自动解码或改写报告。
  const markupHost = new ReportRuntimeHost(window, failure => failures.push(failure))
  const markupBounds = { x: 0, y: 0, width: 900, height: 600 }
  await markupHost.open({
    id: REPORT_ID,
    html: '&lt;h2&gt;结论摘要&lt;/h2&gt; &lt;p&gt;正文&lt;/p&gt;'
  }, markupBounds)
  const escapedMarkup = await window.contentView.children.at(-1).webContents.executeJavaScript(`({
    headingCount: document.querySelectorAll('h2').length,
    text: document.body.textContent
  })`)
  const entityMarkup = []
  for (const html of [
    '&#60h2&#62Heading&#60/h2&#62',
    '&#x3ch2&#x3eHeading&#x3c/h2&#x3e',
    '&lth2&gtHeading&lt/h2&gt',
    '&lt;h2>Heading&lt;/h2>',
    '&Lt;h2&Gt;'
  ]) {
    await markupHost.open({ id: REPORT_ID, html }, markupBounds)
    entityMarkup.push(await window.contentView.children.at(-1).webContents.executeJavaScript(`({
      headingCount: document.querySelectorAll('h2').length,
      text: document.body.textContent
    })`))
  }
  await markupHost.open({
    id: REPORT_ID,
    html: '<h2>结论摘要</h2><table><tr><td>正文</td></tr></table><pre><code>&lt;h2&gt;示例&lt;/h2&gt;</code></pre>'
  }, markupBounds)
  const correctedMarkup = await window.contentView.children.at(-1).webContents.executeJavaScript(`({
    heading: document.querySelector('h2')?.textContent,
    cell: document.querySelector('td')?.textContent,
    code: document.querySelector('code')?.textContent
  })`)
  markupHost.close()

  // 报告文档自身在加载期间跳到 localhost：这是合法的自跳转，不是加载失败，
  // 且必须留在报告自己的隔离视图里（同时证明 http/localhost 请求可用）。
  const localServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><body><p id="hopped">hopped</p></body></html>')
  })
  await new Promise((resolve) => localServer.listen(0, '127.0.0.1', resolve))
  const localPort = localServer.address().port
  const redirectFailures = []
  const redirectHost = new ReportRuntimeHost(window, (failure) => redirectFailures.push(failure))
  let redirectError = null
  await redirectHost
    .open(
      {
        id: REDIRECT_REPORT_ID,
        html: `<html><head><script>location.replace('http://127.0.0.1:${localPort}/next')</script></head><body>seed</body></html>`
      },
      { x: 0, y: 0, width: 900, height: 600 }
    )
    .catch((error) => {
      redirectError = error instanceof Error ? error.message : String(error)
    })
  const redirectView = window.contentView.children.at(-1)
  const redirectContents = redirectView ? redirectView.webContents : null
  for (let attempt = 0; attempt < 60 && redirectContents && !redirectContents.isDestroyed(); attempt += 1) {
    if (redirectContents.getURL().startsWith('http://127.0.0.1:')) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  const redirectUrl = redirectContents && !redirectContents.isDestroyed()
    ? redirectContents.getURL()
    : 'destroyed'
  const redirectBody = redirectContents && !redirectContents.isDestroyed()
    ? await redirectContents.executeJavaScript("document.getElementById('hopped') ? 'hopped' : 'missing'")
    : 'destroyed'
  redirectHost.close()
  localServer.close()

  // 关闭后运行实例销毁；卡片态不执行 HTML。
  host.close()
  const viewsAfterClose = window.contentView.children.length

  console.log('REPORT_RUNTIME_RESULT ' + JSON.stringify({
    ok: true,
    probe,
    scriptTitle,
    preload: preferences.preload ?? null,
    nodeIntegration: preferences.nodeIntegration === true,
    contextIsolation: preferences.contextIsolation !== false,
    webSecurity: preferences.webSecurity !== false,
    sandbox: preferences.sandbox === true,
    sharesHostSession: contents.session === session.defaultSession,
    usesPersistentReportPartition,
    reportCookieCount: reportCookies.length,
    hostCookieCount: hostCookies.length,
    afterRetiredReferenceNavigation,
    hashHref,
    afterFileNavigation,
    openedExternally,
    windowCountBefore,
    windowCountAfter,
    escapedMarkup,
    entityMarkup,
    correctedMarkup,
    viewsAfterClose,
    hostWindowVisible: window.isVisible(),
    hostWindowShown: shown,
    redirectError,
    redirectFailures,
    redirectUrl,
    redirectBody,
    failures
  }))
  app.exit(0)
}).catch((error) => fail(error instanceof Error ? error.stack || error.message : String(error)))
