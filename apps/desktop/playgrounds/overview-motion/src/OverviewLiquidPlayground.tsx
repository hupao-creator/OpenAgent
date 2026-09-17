import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, type LiquidCanvasRef } from '@liquid-dom/react'
import { EMPTY_BOX, GLASS, OverviewActions, TagFilterBar, hitTestHost, measureBar, type BarBox } from './liquid-bars'
import { canvasDrawElementGap, installLiquidCaptureCompat } from './liquid-capture-compat'
import { LiquidUnsupported } from './LiquidUnsupported'

installLiquidCaptureCompat()

const GAP = canvasDrawElementGap()

const SUBSTRATE_CARDS = [
  { title: '重构概述视图的取景逻辑', body: '把相机记忆和布局规划拆开，让离开再返回时先复用旧视角，等新的卡片集合稳定下来再重新取景。这一版只处理串行直线，斜向移动留到下一轮。' },
  { title: '给标签筛选栏加工作目录标记', body: '目录标签和普通标签混在一排里，靠前缀图标区分。计数用等宽数字，选中态走一层内阴影而不是换底色，避免在毛玻璃上叠加出脏边。' },
  { title: '收敛卡片快照的失效条件', body: '内容新鲜度和几何失效原本共用一个版本号，导致任何一次流式更新都会让整块快照重算。现在拆成两个，几何只在布局变化时失效。' },
  { title: '修复顶栏按钮在窄窗口下的遮挡', body: '窗口控件在右上角，按钮组要往左让开一段，筛选栏的居中盒子右边缘只内缩一半，所以预留量要按两倍算，否则最右侧的标签会被按钮组吃掉点击。' },
  { title: '接入 CanvasDrawElement 实验特性', body: '这条 Blink 开关是进程级的，开一次对所有窗口生效，没法按区域或按需打包。启用之后 canvas 可以捕获布局子树，把真实 DOM 当作纹理来源。' },
  { title: '整理 Playground 的主题驱动方式', body: '生产样式里剩下的媒体查询跟随操作系统，页面改不动，所以 playground 按 data-theme 把两组值重述一遍，让外观选择器自洽。' }
]

function Substrate(): React.JSX.Element {
  return <div className="liquid-substrate" aria-hidden="true">
    {SUBSTRATE_CARDS.map(card => <article key={card.title}>
      <h3>{card.title}</h3>
      <p>{card.body}</p>
      <p>{card.body}</p>
    </article>)}
  </div>
}

export function OverviewLiquidPlayground(): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<LiquidCanvasRef>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const filterHostRef = useRef<HTMLDivElement>(null)
  const actionsHostRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [filterBox, setFilterBox] = useState<BarBox>(EMPTY_BOX)
  const [actionsBox, setActionsBox] = useState<BarBox>(EMPTY_BOX)
  const [selected, setSelected] = useState('')
  const [archived, setArchived] = useState(false)
  const [hovered, setHovered] = useState<string | null>(null)
  const [theme, setTheme] = useState('light')
  const [notice, setNotice] = useState('拖动鼠标划过玻璃条，点击标签或按钮')

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

  /* 两条栏的尺寸由库外的一次测量给出：`Html sizing="intrinsic"` 量不出这条筛选栏
     （宿主根本不进 DOM），`sizing="fill"` 则要先有一个确定的盒子。量的是生产样式
     排出来的真实尺寸，量完把盒子交给 Frame。 */
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
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.style.colorScheme = theme
    root.dataset.theme = theme
    // 换肤只改 CSS 变量，元素本身没被标记成 changed，demand 模式下不会自动重绘，
    // 画布会停在上一帧的浅色衬底上。这里显式请求一帧。
    canvasRef.current?.invalidateFrame()
    return () => {
      root.style.removeProperty('color-scheme')
      delete root.dataset.theme
    }
  }, [theme])

  /* 库只在 canvas 的 paint 事件里重捕获玻璃内部的 DOM，而类名是 React 改的、场景图
     没动，所以每次交互态落地后要自己请求一帧；放在 effect 里是为了等 DOM 提交完。 */
  const repaint = useCallback(() => {
    requestAnimationFrame(() => {
      canvasRef.current?.invalidateLayout()
      canvasRef.current?.invalidateFrame()
    })
  }, [])

  useEffect(repaint, [hovered, selected, archived, repaint])

  /* 悬停和离开都按坐标重新命中一次。选中态一变，库会把承载 DOM 换掉，光标底下那个
     <button> 随之消失并触发一次 leave —— 那是重挂载不是真的移开，照坐标再判一次
     就能把悬停留住。真的移出玻璃时 inside 为 false，这时才清空。 */
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

  const ready = size.width > 0 && filterBox.width > 0 && actionsBox.width > 0

  return <main className="motion-playground liquid-playground">
    <header className="motion-header">
      <div className="motion-brand"><span>OPENAGENT / PLAYGROUNDS</span><h1>Overview Liquid</h1></div>
      <div className="motion-environment">
        <nav className="layout-nav" aria-label="Playground">
          <a href="?scene=lifecycle">动画</a><a href="?scene=layout">Layout</a><a href="?scene=liquid" aria-current="page">Liquid</a><a href="?scene=liquid-live">Liquid Live</a>
        </nav>
        <label>外观<select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
      </div>
    </header>
    <section className="liquid-stage" ref={stageRef} aria-label="Liquid Glass 预览">
      <div className="liquid-measure" aria-hidden="true" ref={measureRef}>
        <TagFilterBar selected="" hovered={null} />
        <OverviewActions archived={false} hovered={null} />
      </div>
      {GAP ? <LiquidUnsupported /> : ready && <LiquidCanvas ref={canvasRef} frameloop="demand"
        style={{ width: '100%', height: '100%' }}
        canvasStyle={{ display: 'block', width: '100%', height: '100%' }}
        onError={error => console.error('[liquid] 帧循环失败', error)}>
        <Frame key={theme} width={size.width} height={size.height}>
          <ZStack alignment="topLeading">
            <Html sizing="fill" zIndex={0}><Substrate /></Html>
            <Frame width={size.width} height={size.height} alignment={{ x: 'center', y: 'start' }}>
              <Padding insets={{ top: 16 }}>
                <GlassContainer {...GLASS}>
                  <Frame width={filterBox.width} height={filterBox.height}>
                    <Glass cornerRadius={13} pointerEvents
                      onPointerMove={onFilterMove}
                      onPointerLeave={onFilterLeave}
                      onClick={event => {
                        const filter = hitTestHost(filterHostRef.current, event)?.dataset.filter
                        if (filter === undefined) return
                        setSelected(filter)
                        setNotice(`筛选 ${filter || '全部'}`)
                      }}>
                      <Html sizing="fill">
                        <TagFilterBar hostRef={filterHostRef} selected={selected} hovered={hovered} />
                      </Html>
                    </Glass>
                  </Frame>
                </GlassContainer>
              </Padding>
            </Frame>
            <Frame width={size.width} height={size.height} alignment={{ x: 'end', y: 'start' }}>
              <Padding insets={{ top: 16, right: 18 }}>
                <GlassContainer {...GLASS}>
                  <Frame width={actionsBox.width} height={actionsBox.height}>
                    <Glass cornerRadius={13} pointerEvents
                      onPointerMove={onActionsMove}
                      onPointerLeave={onActionsLeave}
                      onClick={event => {
                        const action = hitTestHost(actionsHostRef.current, event)?.dataset.action
                        if (action === undefined) return
                        if (action === '已归档') setArchived(!archived)
                        setNotice(action)
                      }}>
                      <Html sizing="fill">
                        <OverviewActions hostRef={actionsHostRef} archived={archived} hovered={hovered} />
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
      <span>liquid-dom 0.1.1 · {GAP ? '本环境不支持捕获' : '捕获垫片已启用'} · 静态预览（frameloop=demand）</span>
      <output aria-live="polite">{notice}</output>
    </footer>
  </main>
}
