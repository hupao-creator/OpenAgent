import type { RendererCapabilities } from '@openagent/plugin-kit/renderer'

export const browserRendererCapabilities = {
  openExternal: async (href: string): Promise<void> => {
    const url = new URL(href, window.location.href)
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      window.open(url.href, '_blank', 'noopener,noreferrer')
    }
  }
} satisfies RendererCapabilities
