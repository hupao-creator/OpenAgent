import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { ApplicationAppearance } from '../src/main/application-appearance'
import {
  assertOpenAgentSettingsShell, createDefaultOpenAgentSettings,
  type OpenAgentAppearance
} from '../src/shared/openagent-settings'

class NativeTheme extends EventEmitter {
  themeSource: OpenAgentAppearance = 'system'
  systemDark = false
  get shouldUseDarkColors(): boolean {
    return this.themeSource === 'system' ? this.systemDark : this.themeSource === 'dark'
  }
}

describe('committed application appearance', () => {
  it('defaults to system and rejects missing or unknown preferences', () => {
    const defaults = createDefaultOpenAgentSettings()
    expect(defaults.appearance).toBe('system')
    for (const appearance of ['system', 'light', 'dark']) {
      expect(() => assertOpenAgentSettingsShell({ ...defaults, appearance })).not.toThrow()
    }
    for (const appearance of [undefined, null, 'auto', {}, false]) {
      expect(() => assertOpenAgentSettingsShell({ ...defaults, appearance })).toThrow()
    }
  })

  it.each([
    ['system', false, '#f8f7f4'], ['system', true, '#20211f'],
    ['light', false, '#f8f7f4'], ['light', true, '#f8f7f4'],
    ['dark', false, '#20211f'], ['dark', true, '#20211f']
  ] as const)('%s on system dark=%s selects matching initial and live window colors', (mode, system, color) => {
    const native = new NativeTheme()
    native.systemDark = system
    const window = { isDestroyed: () => false, setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() }
    const appearance = new ApplicationAppearance(native, 'win32', () => window)
    appearance.apply(mode)
    expect(native.themeSource).toBe(mode)
    expect(appearance.windowOptions.backgroundColor).toBe(color)
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(color)
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({
      color, symbolColor: color === '#20211f' ? '#eeeee9' : '#20211e', height: 40
    })
    native.systemDark = !system
    native.emit('updated')
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(
      mode === 'system' ? system ? '#f8f7f4' : '#20211f' : color
    )
    appearance.dispose()
    expect(native.listenerCount('updated')).toBe(0)
  })

  it('paints the macOS window opaque, applies before a window exists, and tolerates closed windows', () => {
    const native = new NativeTheme()
    const window = { isDestroyed: () => true, setBackgroundColor: vi.fn(), setTitleBarOverlay: vi.fn() }
    let current: typeof window | null = null
    const appearance = new ApplicationAppearance(native, 'darwin', () => current)
    appearance.apply('dark')
    expect(native.shouldUseDarkColors).toBe(true)
    expect(appearance.windowOptions).toEqual({ backgroundColor: '#20211f', titleBarOverlay: undefined })
    current = window
    native.emit('updated')
    expect(window.setBackgroundColor).not.toHaveBeenCalled()
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    appearance.dispose()
  })
})
