// Test-only process setup: production Main/Preload/Renderer and settings IPC stay intact.
const { app, nativeTheme } = require('electron')
const { join } = require('node:path')
const fs = require('node:fs')
const root = process.env.OPENAGENT_APPEARANCE_ROOT
app.setPath('home', join(root, 'home'))
app.setPath('userData', join(root, 'user-data'))
// 外观回归驱动真实窗口但不把它放到运行者的屏幕上：隐藏窗口照常布局、渲染与合成，
// 断言读到的主题、DOM 与截图都是真实结果；Dock 也不显示。生产路径走的是 `show()`，
// 替换它即可保持隐藏；绕过它的上屏路径都会发出 show 事件，记成 shown 由 driver 断言不存在。
if (process.platform === 'darwin') void app.whenReady().then(() => app.dock?.hide())
app.on('browser-window-created', (_event, window) => {
  // This test keeps the native window hidden but exercises real Worker/rAF
  // transitions. Background throttling would suppress the very frames it waits
  // for; Playwright's page clock does not control the Worker's native clock.
  window.webContents.setBackgroundThrottling(false)
  const record = phase => fs.appendFileSync(join(root, 'startup.jsonl'), JSON.stringify({
    phase, source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors,
    background: window.getBackgroundColor(), at: Date.now()
  }) + '\n')
  window.show = () => undefined
  window.on('show', () => record('shown'))
  record('created')
  window.once('ready-to-show', () => record('ready-to-show'))
})
require(process.env.OPENAGENT_APPEARANCE_MAIN)
