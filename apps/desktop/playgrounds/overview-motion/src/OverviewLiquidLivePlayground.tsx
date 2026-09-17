import { useRef, useState } from 'react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { ConversationOverview, type ConversationTagFilter } from '../../../src/renderer/src/components/ConversationOverview'
import type { OverviewView } from '../../../src/renderer/src/conversation-overview-layout'
import type { OverviewCameraMemory } from '../../../src/renderer/src/overview-motion/camera'
import { canvasDrawElementGap } from '../../../src/renderer/src/liquid/capture-compat'
import { LiquidUnsupported } from './LiquidUnsupported'
import { createMotionFrame } from './scenarios'

const GAP = canvasDrawElementGap()

/** 卡片多到能拖动才有得看：24 张按紧凑布局铺开，比屏幕大。 */
const THREAD_COUNT = 24

/* 自动取景的缩放下限。取生产的可读尺寸会让整包缩到 0.37，画布空掉一大半、
   玻璃底下什么都没有；抬到接近 1 让卡片铺满视口，玻璃条才压在真实内容上。 */
const SCALE_FLOOR = 0.8

/* 标签筛选栏只在有标签可选时才渲染（ConversationOverview 的 showTagFilters），
   而生产的标签来自会话本身。场景这边自己编一组，好让筛选栏真的出现 —— 浮条是
   按实测盒子画玻璃的，栏不渲染就没有盒子，也就看不到玻璃。 */
const TAG_FILTERS: readonly ConversationTagFilter[] = [
  { tag: 'web', count: 9, isCwdTag: false },
  { tag: 'docs', count: 6, isCwdTag: false },
  { tag: 'infra', count: 5, isCwdTag: false },
  { tag: '~/work/OpenAgent', count: 4, isCwdTag: true }
]

/**
 * 真实 `ConversationOverview` 跑在真实宿主里的预览。
 *
 * 这里**不自己搭画布**：俯瞰视图从接入液体玻璃那一刻起就自带舞台（`OverviewLiquidStage`），
 * 场景再套一层就变成画布里嵌画布 —— 内层 canvas 是外层捕获的子树的一部分，两边都会
 * 捕获、都会失效，行为没有定义。所以这个场景只负责给它喂数据，玻璃、浮条对齐、换肤
 * 全部走生产那条路径；看到什么就是生产的样子。
 *
 * 外观没有选择项：玻璃的染色读的是 `prefers-color-scheme`（`useLiquidTheme`），而
 * 解析后的外观由主进程写进宿主，页面上改 `color-scheme` 是改不动媒体查询的。要试深色
 * 就在系统里切，或者用 appearance 那条真实窗口测试的入口。
 */
export function OverviewLiquidLivePlayground(): React.JSX.Element {
  const cameraMemory = useRef<OverviewCameraMemory['current']>(null)
  const [frame] = useState(() => createMotionFrame(THREAD_COUNT))
  const [view, setView] = useState<OverviewView>('default')
  const [selectedTag, setSelectedTag] = useState('')
  const [notice, setNotice] = useState('按住画布空白处拖动，看玻璃底下的卡片怎么弯折')

  return <RendererCapabilitiesProvider capabilities={{ openExternal: url => setNotice(`打开链接 ${url}`) }}>
    <main className="motion-playground liquid-playground">
      <header className="motion-header">
        <div className="motion-brand"><span>OPENAGENT / PLAYGROUNDS</span><h1>Overview Liquid Live</h1></div>
        <div className="motion-environment">
          <nav className="layout-nav" aria-label="Playground">
            <a href="?scene=lifecycle">动画</a><a href="?scene=layout">Layout</a>
            <a href="?scene=liquid">Liquid</a><a href="?scene=liquid-live" aria-current="page">Liquid Live</a>
          </nav>
        </div>
      </header>
      <section className="liquid-stage" aria-label="Liquid Glass 实时预览">
        {GAP ? <LiquidUnsupported /> : <div className="liquid-live-host">
          <ConversationOverview cameraMemory={cameraMemory} threads={frame.threads} reports={frame.reports}
            canvasScaleFloor={SCALE_FLOOR} transitionId={null} embedded motionSceneKey="playground:liquid-live"
            layoutRevisions={[]} onLayoutRevisionsConsumed={() => undefined}
            onLayoutContextChange={() => undefined}
            interrupt={async id => setNotice(`停止 ${id}`)} respond={async () => setNotice('回应问题')}
            onFollowUpOpen={id => setNotice(`续写 ${id}`)} onSelect={id => setNotice(`打开 ${id}`)}
            onOpenReport={id => setNotice(`打开报告 ${id}`)}
            onOpenRelatedExecution={id => setNotice(`打开关联 ${id}`)}
            /* 两条浮条都得真的有内容才渲染得出来，玻璃才有盒子可量。 */
            tagFilters={TAG_FILTERS} selectedTag={selectedTag} onTagChange={setSelectedTag}
            view={view} onViewChange={setView}
            onSetThreadArchived={(id, archived) => setNotice(`${archived ? '归档' : '取消归档'} ${id}`)}
            onSettings={() => setNotice('打开设置')} />
        </div>}
      </section>
      <footer className="motion-stage-footer">
        <span>真实 ConversationOverview · liquid-dom 0.1.1 · {GAP ? '本环境不支持捕获' : '捕获垫片已启用'}</span>
        <output aria-live="polite">{notice}</output>
      </footer>
    </main>
  </RendererCapabilitiesProvider>
}
