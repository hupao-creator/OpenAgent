import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppI18nProvider } from '../../../src/renderer/src/i18n'
import '@fontsource-variable/inter'
import '../../../src/renderer/src/styles.css'
import { OverviewMotionPlayground } from './OverviewMotionPlayground'
import { OverviewLayoutPlayground } from './OverviewLayoutPlayground'
import { OverviewLiquidPlayground } from './OverviewLiquidPlayground'
import { OverviewLiquidLivePlayground } from './OverviewLiquidLivePlayground'
import './playground.css'
import './liquid.css'

/* 动画场景（lifecycle / packing / camera …）由 OverviewMotionPlayground 自己按 scene
   参数选，所以它们不进这张表，落到默认分支。 */
const scenes: Record<string, () => React.JSX.Element> = {
  layout: OverviewLayoutPlayground,
  liquid: OverviewLiquidPlayground,
  'liquid-live': OverviewLiquidLivePlayground
}
const Scene = scenes[new URLSearchParams(location.search).get('scene') ?? ''] ?? OverviewMotionPlayground

createRoot(document.getElementById('root')!).render(
  <StrictMode><AppI18nProvider locale="zh-CN"><Scene /></AppI18nProvider></StrictMode>
)
