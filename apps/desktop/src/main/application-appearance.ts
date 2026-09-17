import type { OpenAgentAppearance } from '../shared/openagent-settings'

/** Main is the sole owner. Electron also applies themeSource to Chromium. */
export interface NativeAppearance {
  themeSource: OpenAgentAppearance
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export interface AppearanceWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setTitleBarOverlay(options: { color: string; symbolColor: string; height: number }): void
}

export function windowAppearance(dark: boolean, platform: string): {
  backgroundColor: string
  titleBarOverlay: { color: string; symbolColor: string; height: number } | undefined
} {
  const color = dark ? '#20211f' : '#f8f7f4'
  return {
    backgroundColor: color,
    titleBarOverlay: platform === 'darwin' ? undefined : {
      color, symbolColor: dark ? '#eeeee9' : '#20211e', height: 40
    }
  }
}

export class ApplicationAppearance {
  constructor(
    private readonly native: NativeAppearance,
    private readonly platform: string,
    private readonly window: () => AppearanceWindow | null
  ) {
    native.on('updated', this.synchronizeWindow)
  }

  apply(preference: OpenAgentAppearance): void {
    if (this.native.themeSource !== preference) this.native.themeSource = preference
    this.synchronizeWindow()
  }

  get windowOptions(): ReturnType<typeof windowAppearance> {
    return windowAppearance(this.native.shouldUseDarkColors, this.platform)
  }

  dispose(): void {
    this.native.removeListener('updated', this.synchronizeWindow)
  }

  private readonly synchronizeWindow = (): void => {
    const window = this.window()
    if (!window || window.isDestroyed()) return
    const options = this.windowOptions
    window.setBackgroundColor(options.backgroundColor)
    if (options.titleBarOverlay) window.setTitleBarOverlay(options.titleBarOverlay)
  }
}
