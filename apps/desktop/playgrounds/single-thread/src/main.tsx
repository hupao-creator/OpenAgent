import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import { SingleThreadLab } from './SingleThreadLab'
import './lab.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppI18nProvider locale="zh-CN"><SingleThreadLab /></AppI18nProvider>
  </StrictMode>
)
