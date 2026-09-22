import { describe, expect, it, vi } from 'vitest'
import { createSystemFontHandler, registerSystemFontProtocol, SYSTEM_FONT_URL } from '../src/main/system-fonts'

describe('application-only system font asset', () => {
  it('serves and caches the installed font with a MIME type usable by font loading and snapshot embedding', async () => {
    const readFont = vi.fn(async () => new Uint8Array([79, 84, 84, 79]))
    const handler = createSystemFontHandler({ platform: 'darwin', readFont })
    for (let i = 0; i < 2; i++) {
      const response = await handler(new Request(SYSTEM_FONT_URL))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('font/otf')
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([79, 84, 84, 79])
    }
    expect(readFont).toHaveBeenCalledTimes(1)
  })

  it('never reads arbitrary paths, query arguments, alternate hosts, or write requests', async () => {
    const readFont = vi.fn(async () => new Uint8Array())
    const handler = createSystemFontHandler({ platform: 'darwin', readFont })
    for (const url of [
      'openagent-font://system/etc/passwd', 'openagent-font://other/sf-mono-regular.otf',
      `${SYSTEM_FONT_URL}?path=/etc/passwd`, 'https://system/sf-mono-regular.otf'
    ]) expect((await handler(new Request(url))).status).toBe(404)
    expect((await handler(new Request(SYSTEM_FONT_URL, { method: 'POST' }))).status).toBe(405)
    expect(readFont).not.toHaveBeenCalled()
  })

  it('lets unavailable fonts fall back without failing startup', async () => {
    const readFont = vi.fn(async () => { throw new Error('missing') })
    const unavailable = createSystemFontHandler({ platform: 'darwin', readFont })
    expect((await unavailable(new Request(SYSTEM_FONT_URL))).status).toBe(404)
    expect((await unavailable(new Request(SYSTEM_FONT_URL))).status).toBe(404)
    expect(readFont).toHaveBeenCalledTimes(1)
    const otherPlatform = createSystemFontHandler({ platform: 'linux', readFont })
    expect((await otherPlatform(new Request(SYSTEM_FONT_URL))).status).toBe(404)
    expect(readFont).toHaveBeenCalledTimes(1)
    const handle = vi.fn()
    registerSystemFontProtocol({ handle })
    expect(handle).toHaveBeenCalledWith('openagent-font', expect.any(Function))
  })
})
