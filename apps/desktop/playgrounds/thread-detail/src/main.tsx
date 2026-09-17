import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import '@fontsource-variable/inter'
import '@openagent/plugin-kit/renderer/styles.css'
import '../../../src/renderer/src/components/thread-workspace.css'
import { Playground } from './Playground'
import { browserRendererCapabilities } from './browser-capabilities'
import './playground.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererCapabilitiesProvider capabilities={browserRendererCapabilities}>
      <AppI18nProvider locale="zh-CN">
        <Playground />
      </AppI18nProvider>
    </RendererCapabilitiesProvider>
  </StrictMode>
)
