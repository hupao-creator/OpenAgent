import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import { harnessRendererTranslations } from '../../../src/renderer/src/harness-composition'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import { BartTransitionPlayground } from './BartTransitionPlayground'
import './transitions.css'
import './playground.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RendererCapabilitiesProvider capabilities={{ openExternal: (url) => { console.info('[pg] openExternal', url) } }}>
      <AppI18nProvider locale="zh-CN" translations={harnessRendererTranslations}>
        <BartTransitionPlayground />
      </AppI18nProvider>
    </RendererCapabilitiesProvider>
  </StrictMode>
)
