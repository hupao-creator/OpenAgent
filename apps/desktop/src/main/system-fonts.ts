import { readFile } from 'node:fs/promises'
import type { Protocol } from 'electron'

export const SYSTEM_FONT_URL = 'openagent-font://system/sf-mono-regular.otf'
const SF_MONO_PATH = '/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts/SF-Mono-Regular.otf'
export const SYSTEM_FONT_SCHEME_PRIVILEGES = {
  scheme: 'openagent-font',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
}

/** Only the installed font is readable; this is not a general filesystem endpoint. */
export function createSystemFontHandler(options: {
  platform?: string
  readFont?: () => Promise<Uint8Array>
} = {}): (request: Request) => Promise<Response> {
  let font: Promise<Uint8Array | null> | undefined
  return async (request) => {
    if (request.url !== SYSTEM_FONT_URL) return new Response(null, { status: 404 })
    if (request.method !== 'GET') return new Response(null, { status: 405 })
    if ((options.platform ?? process.platform) !== 'darwin') return new Response(null, { status: 404 })
    font ??= (options.readFont ?? (() => readFile(SF_MONO_PATH)))().catch(() => null)
    const bytes = await font
    if (!bytes) return new Response(null, { status: 404 })
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': 'font/otf',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400'
    } })
  }
}

/** Installed on the application session only, never on isolated Report sessions. */
export function registerSystemFontProtocol(protocol: Pick<Protocol, 'handle'>): void {
  protocol.handle(SYSTEM_FONT_SCHEME_PRIVILEGES.scheme, createSystemFontHandler())
}
