const { app, BrowserWindow, nativeTheme } = require('electron')

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark'
  // Fits the hosted macOS display; each test gets a separate, disposable app.
  const window = new BrowserWindow({
    width: 900, height: 600, titleBarStyle: 'hiddenInset', backgroundColor: '#20211f',
    webPreferences: { backgroundThrottling: false }
  })
  void window.loadURL(process.env.SETTINGS_RENDERER_URL)
})
