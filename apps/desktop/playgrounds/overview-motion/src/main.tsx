import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import { OverviewMotionPlayground } from './OverviewMotionPlayground'
import { OverviewLayoutPlayground } from './OverviewLayoutPlayground'
import { OverviewLiquidPlayground } from './OverviewLiquidPlayground'
import './playground.css'
import './liquid.css'

const scene = new URLSearchParams(location.search).get('scene')

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppI18nProvider locale="zh-CN">{scene === 'liquid'
    ? <OverviewLiquidPlayground /> : scene === 'layout'
      ? <OverviewLayoutPlayground /> : <OverviewMotionPlayground />}</AppI18nProvider></StrictMode>
)
