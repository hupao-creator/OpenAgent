import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, type LiquidCanvasRef } from '@liquid-dom/react'
import { RendererCapabilitiesProvider } from '@openagent/plugin-kit/renderer'
import { ConversationOverview } from '../../../src/renderer/src/components/ConversationOverview'
import { getOverviewCameraCockpit } from '../../../src/renderer/src/overview-motion'
import type { OverviewCameraMemory } from '../../../src/renderer/src/overview-motion/camera'
import { BAR_CORNER, EMPTY_BOX, NARROW_BREAKPOINT, OverviewActions, TagFilterBar, barInsets, glassFor, hitTestHost, measureBar, measureInsets, type BarBox } from './liquid-bars'
import { canvasDrawElementGap, installLiquidCaptureCompat } from './liquid-capture-compat'
import { LiquidUnsupported } from './LiquidUnsupported'
import { createMotionFrame } from './scenarios'

installLiquidCaptureCompat()

const GAP = canvasDrawElementGap()

/** 卡片多到能拖动才有得看：24 张按紧凑布局铺开，比屏幕大。 */
const THREAD_COUNT = 24

/* 自动取景的缩放下限。取生产的可读尺寸会让整包缩到 0.37，画布空掉一大半、
   玻璃底下什么都没有；抬到接近 1 让卡片铺满视口，玻璃条才压在真实内容上。 */
const SCALE_FLOOR = 0.8

export function OverviewLiquidLivePlayground(): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<LiquidCanvasRef>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const filterHostRef = useRef<HTMLDivElement>(null)
  const actionsHostRef = useRef<HTMLDivElement>(null)
  const cameraMemory = useRef<OverviewCameraMemory['current']>(null)
  const [frame] = useState(() => createMotionFrame(THREAD_COUNT))
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [filterBox, setFilterBox] = useState<BarBox>(EMPTY_BOX)
  const [actionsBox, setActionsBox] = useState<BarBox>(EMPTY_BOX)
  const [selected, setSelected] = useState('')
  const [archived, setArchived] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [theme, setTheme] = useState('light')
  const [notice, setNotice] = useState('按住画布空白处拖动，看玻璃底下的卡片怎么弯折')
  const narrow = size.width > 0 && size.width <= NARROW_BREAKPOINT

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const observer = new ResizeObserver(() => {
      const rect = stage.getBoundingClientRect()
      setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    })
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const node = measureRef.current
    if (!node) return
    const measure = (): void => {
      setFilterBox(measureBar(node, '.thread-tag-filter-bar'))
      setActionsBox(measureBar(node, '.thread-overview-actions'))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    void document.fonts.ready.then(measure)
    return () => observer.disconnect()
  }, [narrow])

  useEffect(() => {
    const root = document.documentElement
    root.style.colorScheme = theme
    root.dataset.theme = theme
    return () => {
      root.style.removeProperty('color-scheme')
      delete root.dataset.theme
    }
  }, [theme])

  /* 拖动是这里唯一的重绘源。overview 的平移是命令式改 transform 的，场景图不动，
     库只在 canvas 的 paint 事件里重捕获，所以画布会停在拖动前那一帧。挂到相机的帧
     订阅上，每帧请求一次失效 —— 拖动时卡片才会在玻璃底下真的动起来。
     rAF 合并同一帧里的多次相机更新，一个帧只失效一次。 */
  useEffect(() => {
    const camera = getOverviewCameraCockpit()
    let handle = 0
    const invalidate = (): void => {
      if (handle) return
      handle = requestAnimationFrame(() => {
        handle = 0
        canvasRef.current?.invalidateLayout()
        canvasRef.current?.invalidateFrame()
      })
    }
    const unsubscribe = camera.subscribeFrame(invalidate)
    return () => {
      unsubscribe()
      if (handle) cancelAnimationFrame(handle)
    }
  }, [])

  const repaint = useCallback(() => {
    requestAnimationFrame(() => {
      canvasRef.current?.invalidateLayout()
      canvasRef.current?.invalidateFrame()
    })
  }, [])

  /* 量出来的盒子也要进依赖：字号加载完、窗口变窄都会让测量翻新一次，而画布不会
     自己知道 —— 少了它，玻璃里会一直留着第一次量到的那个宽度。 */
  useEffect(repaint, [hovered, selected, archived, filterBox, actionsBox, narrow, repaint])

  const onFilterMove = useCallback((event: { localX: number; localY: number }) => {
    setHovered(hitTestHost(filterHostRef.current, event)?.dataset.filter ?? null)
  }, [])
  const onActionsMove = useCallback((event: { localX: number; localY: number }) => {
    setHovered(hitTestHost(actionsHostRef.current, event)?.dataset.action ?? null)
  }, [])
  const onFilterLeave = useCallback((event: { localX: number; localY: number; inside: boolean }) => {
    setHovered(event.inside ? hitTestHost(filterHostRef.current, event)?.dataset.filter ?? null : null)
  }, [])
  const onActionsLeave = useCallback((event: { localX: number; localY: number; inside: boolean }) => {
    setHovered(event.inside ? hitTestHost(actionsHostRef.current, event)?.dataset.action ?? null : null)
  }, [])

  /* 玻璃内部的 <button> 收不到原生指针事件，但**收得到键盘**：Tab 能聚焦、回车会
     派发一次 click。所以坐标命中和按钮自己的回调要走同一个入口，否则键盘激活的是
     一个没有处理器的按钮 —— 有标签、能聚焦、按下去什么都不发生。 */
  const onAction = useCallback((action: string) => {
    if (action === '已归档') setArchived(value => !value)
    setNotice(action)
  }, [])

  const ready = size.width > 0 && filterBox.width > 0 && actionsBox.width > 0

  return <RendererCapabilitiesProvider capabilities={{ openExternal: url => setNotice(`打开链接 ${url}`) }}>
    <main className="motion-playground liquid-playground">
      <header className="motion-header">
        <div className="motion-brand"><span>OPENAGENT / PLAYGROUNDS</span><h1>Overview Liquid Live</h1></div>
        <div className="motion-environment">
          <nav className="layout-nav" aria-label="Playground">
            <a href="?scene=lifecycle">动画</a><a href="?scene=layout">Layout</a>
            <a href="?scene=liquid">Liquid</a><a href="?scene=liquid-live" aria-current="page">Liquid Live</a>
          </nav>
          <label>外观<select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
        </div>
      </header>
      <section className="liquid-stage" ref={stageRef} aria-label="Liquid Glass 实时预览">
        <div className="liquid-measure" aria-hidden="true" ref={measureRef}
          style={{ '--liquid-measure-side': `${measureInsets(narrow).left}px` } as React.CSSProperties}>
          {/* 顺序照生产：动作栏在前，窄屏竖排下来才是「按钮组在上」。 */}
          <OverviewActions archived={false} hovered={null} />
          <TagFilterBar selected="" hovered={null} />
        </div>
        {GAP ? <LiquidUnsupported /> : ready && <LiquidCanvas ref={canvasRef} frameloop="demand"
          style={{ width: '100%', height: '100%' }}
          canvasStyle={{ display: 'block', width: '100%', height: '100%' }}
          onError={error => console.error('[liquid] 帧循环失败', error)}>
          <Frame key={theme} width={size.width} height={size.height}>
            <ZStack alignment="topLeading">
              <Html sizing="fill" zIndex={0}>
                <div className="liquid-live-substrate">
                  <ConversationOverview cameraMemory={cameraMemory} threads={frame.threads} reports={frame.reports}
                    canvasScaleFloor={SCALE_FLOOR} transitionId={null} embedded motionSceneKey="playground:liquid-live"
                    layoutRevisions={[]} onLayoutRevisionsConsumed={() => undefined}
                    onLayoutContextChange={() => undefined}
                    interrupt={async id => setNotice(`停止 ${id}`)} respond={async () => setNotice('回应问题')}
                    onFollowUpOpen={id => setNotice(`续写 ${id}`)} onSelect={id => setNotice(`打开 ${id}`)}
                    onOpenReport={id => setNotice(`打开报告 ${id}`)}
                    onOpenRelatedExecution={id => setNotice(`打开关联 ${id}`)} />
                </div>
              </Html>
              <Frame width={size.width} height={size.height} alignment={{ x: 'center', y: 'start' }}>
                <Padding insets={barInsets(narrow, 'filter', actionsBox.height)}>
                  <GlassContainer {...glassFor(theme)}>
                    <Frame width={filterBox.width} height={filterBox.height}>
                      <Glass {...BAR_CORNER} pointerEvents
                        onPointerMove={onFilterMove}
                        onPointerLeave={onFilterLeave}
                        onClick={event => {
                          const filter = hitTestHost(filterHostRef.current, event)?.dataset.filter
                          if (filter === undefined) return
                          setSelected(filter)
                          setNotice(`筛选 ${filter || '全部'}`)
                        }}>
                        <Html sizing="fill">
                          <TagFilterBar hostRef={filterHostRef} selected={selected} hovered={hovered}
                            boxWidth={filterBox.width}
                            onSelect={filter => {
                              setSelected(filter)
                              setNotice(`筛选 ${filter || '全部'}`)
                            }} />
                        </Html>
                      </Glass>
                    </Frame>
                  </GlassContainer>
                </Padding>
              </Frame>
              <Frame width={size.width} height={size.height} alignment={{ x: 'end', y: 'start' }}>
                <Padding insets={barInsets(narrow, 'actions', actionsBox.height)}>
                  <GlassContainer {...glassFor(theme)}>
                    <Frame width={actionsBox.width} height={actionsBox.height}>
                      <Glass {...BAR_CORNER} pointerEvents
                        onPointerMove={onActionsMove}
                        onPointerLeave={onActionsLeave}
                        onClick={event => {
                          const action = hitTestHost(actionsHostRef.current, event)?.dataset.action
                          if (action === undefined) return
                          onAction(action)
                        }}>
                        <Html sizing="fill">
                          <OverviewActions hostRef={actionsHostRef} archived={archived} hovered={hovered}
                            boxWidth={actionsBox.width} onActivate={onAction} />
                        </Html>
                      </Glass>
                    </Frame>
                  </GlassContainer>
                </Padding>
              </Frame>
            </ZStack>
          </Frame>
        </LiquidCanvas>}
      </section>
      <footer className="motion-stage-footer">
        <span>真实 ConversationOverview · liquid-dom 0.1.1 · {GAP ? '本环境不支持捕获' : '捕获垫片已启用'}</span>
        <output aria-live="polite">{notice}</output>
      </footer>
    </main>
  </RendererCapabilitiesProvider>
}
