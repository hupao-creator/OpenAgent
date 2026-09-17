import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import { OverviewMotionPlayground } from './OverviewMotionPlayground'
import { OverviewLayoutPlayground } from './OverviewLayoutPlayground'
import './playground.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppI18nProvider locale="zh-CN">{new URLSearchParams(location.search).get('scene') === 'layout'
    ? <OverviewLayoutPlayground /> : <OverviewMotionPlayground />}</AppI18nProvider></StrictMode>
)
