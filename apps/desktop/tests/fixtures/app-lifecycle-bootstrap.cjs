// Instrument startup boundaries without replacing Service, IPC or Electron quit.
const { app } = require('electron')
const fs = require('node:fs')
const promises = require('node:fs/promises')
const { syncBuiltinESMExports } = require('node:module')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const root = process.env.OPENAGENT_LIFECYCLE_CASE_ROOT
const mode = process.env.OPENAGENT_LIFECYCLE_CASE
const log = (event, data = {}) => fs.appendFileSync(
  join(root, 'native-lifecycle.jsonl'),
  JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data }) + '\n'
)
app.setPath('home', join(root, 'home'))
app.setPath('userData', join(root, 'user-data'))
// 回归必须观察到真实启动边界，但不能把窗口放到运行者的屏幕上。生产路径走的是
// `show()`，所以替换它即可记录请求并保持隐藏；绕过它的上屏路径（构造时 show: true、
// showInactive）都会发出 show 事件，由 window-visible 兜底，driver 断言其不存在。
if (process.platform === 'darwin') void app.whenReady().then(() => app.dock?.hide())
app.on('before-quit', () => log('before-quit'))
app.on('will-quit', () => log('will-quit'))
app.on('quit', (_event, code) => log('quit', { code }))
app.on('browser-window-created', (_event, window) => {
  log('window-created')
  window.show = () => log('window-show-requested')
  window.on('show', () => log('window-visible'))
  window.once('ready-to-show', () => log('window-ready'))
})

async function gate() {
  log('gate-entered', { mode })
  while (!fs.existsSync(join(root, 'release-startup'))) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  log('gate-released', { mode })
}

const filesystemModes = new Set(['directories', 'telemetry', 'second-term'])
if (filesystemModes.has(mode)) {
  const method = mode === 'directories' || mode === 'second-term' ? 'mkdir' : 'stat'
  const original = promises[method]
  let entered = false
  promises[method] = async function (...args) {
    const path = String(args[0])
    const matches = mode === 'directories' || mode === 'second-term'
      ? path.endsWith('/bart-workspace')
      : path.includes('/bart-telemetry-ledgers/')
    if (!entered && matches) {
      entered = true
      await gate()
    }
    return original.apply(this, args)
  }
  syncBuiltinESMExports()
}
if (mode === 'service-load') {
  // SQLite reads run in their own worker; hold the real load request before it
  // starts so shutdown still has to join the Service initialization owner.
  const { Worker } = require('node:worker_threads')
  const original = Worker.prototype.postMessage
  let entered = false
  Worker.prototype.postMessage = function (...args) {
    if (!entered && args[0]?.operation === 'load') {
      entered = true
      void gate().then(() => original.apply(this, args))
      return
    }
    return original.apply(this, args)
  }
}
if (mode === 'headless-listen') {
  const { Server } = require('node:net')
  const original = Server.prototype.listen
  let entered = false
  Server.prototype.listen = function (...args) {
    const callback = args.at(-1)
    if (!entered && typeof callback === 'function') {
      entered = true
      args[args.length - 1] = () => { void gate().then(() => callback.call(this)) }
    }
    return original.apply(this, args)
  }
}

void import(pathToFileURL(process.env.OPENAGENT_LIFECYCLE_MAIN).href)
