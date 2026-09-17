import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Archive, Folder, RotateCcw, Settings, Shrink } from 'lucide-react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, type LiquidCanvasRef } from '@liquid-dom/react'
import { installLiquidCaptureCompat } from './liquid-capture-compat'

installLiquidCaptureCompat()

/* 生产里这条筛选栏的标签来自会话数据；这里是固定的一小撮，只为让对照面有同样的
   形状：一个“全部”加若干带计数的标签，其中一个是工作目录标签。 */
const TAG_FILTERS = [
  { tag: 'openagent', count: 12, cwd: true },
  { tag: '渲染', count: 8, cwd: false },
  { tag: '概述视图', count: 6, cwd: false },
  { tag: '性能', count: 4, cwd: false },
  { tag: '文档', count: 3, cwd: false }
]

const SUBSTRATE_CARDS = [
  { title: '重构概述视图的取景逻辑', body: '把相机记忆和布局规划拆开，让离开再返回时先复用旧视角，等新的卡片集合稳定下来再重新取景。这一版只处理串行直线，斜向移动留到下一轮。' },
  { title: '给标签筛选栏加工作目录标记', body: '目录标签和普通标签混在一排里，靠前缀图标区分。计数用等宽数字，选中态走一层内阴影而不是换底色，避免在毛玻璃上叠加出脏边。' },
  { title: '收敛卡片快照的失效条件', body: '内容新鲜度和几何失效原本共用一个版本号，导致任何一次流式更新都会让整块快照重算。现在拆成两个，几何只在布局变化时失效。' },
  { title: '修复顶栏按钮在窄窗口下的遮挡', body: '窗口控件在右上角，按钮组要往左让开一段，筛选栏的居中盒子右边缘只内缩一半，所以预留量要按两倍算，否则最右侧的标签会被按钮组吃掉点击。' },
  { title: '接入 CanvasDrawElement 实验特性', body: '这条 Blink 开关是进程级的，开一次对所有窗口生效，没法按区域或按需打包。启用之后 canvas 可以捕获布局子树，把真实 DOM 当作纹理来源。' },
  { title: '整理 Playground 的主题驱动方式', body: '生产样式里剩下的媒体查询跟随操作系统，页面改不动，所以 playground 按 data-theme 把两组值重述一遍，让外观选择器自洽。' }
]

interface BarBox {
  readonly width: number
  readonly height: number
}

const EMPTY_BOX: BarBox = { width: 0, height: 0 }

/** 把玻璃局部坐标落到它承载的 DOM 上，找出指针底下的元素。 */
function hitTestHost(host: HTMLElement | null, hit: { localX: number; localY: number }): HTMLElement | null {
  if (!host) return null
  const hostRect = host.getBoundingClientRect()
  for (const candidate of host.querySelectorAll<HTMLElement>('[data-hit]')) {
    const rect = candidate.getBoundingClientRect()
    const x = rect.left - hostRect.left
    const y = rect.top - hostRect.top
    if (hit.localX >= x && hit.localX <= x + rect.width && hit.localY >= y && hit.localY <= y + rect.height) {
      return candidate
    }
  }
  return null
}

/** 读取元素尺寸。量的是生产样式在同一字号下排出来的结果。 */
function measureBar(root: HTMLElement | null, selector: string): BarBox {
  const element = root?.querySelector(selector)
  if (!element) return EMPTY_BOX
  const rect = element.getBoundingClientRect()
  return rect.width <= 0 ? EMPTY_BOX : { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
}

/* 两个玻璃容器共用一套光学参数：薄、低模糊，让背后正文在边缘弯折而不是被糊平，
   这正是和 backdrop-filter 候选的差别所在。 */
const GLASS = {
  blur: 1,
  thickness: 26,
  ior: 1.5,
  dispersion: 0,
  bezelWidth: 14,
  displacementFactor: 1,
  specularStrength: 1,
  specularWidth: 'hairline' as const,
  shadowBlur: 24,
  shadowOffsetY: 10,
  shadowColor: { r: 0.1, g: 0.1, b: 0.09, a: 0.18 },
  tint: { r: 0.98, g: 0.98, b: 0.96, a: 0.62 }
}

interface TagFilterBarProps {
  readonly hostRef?: React.Ref<HTMLDivElement>
  readonly selected: string
  readonly hovered: string | null
  readonly onSelect?: (filter: string) => void
}

/** 筛选栏本体：类名与结构和 ConversationOverview 一致，只说数据不说外观。 */
function TagFilterBar({ hostRef, selected, hovered, onSelect }: TagFilterBarProps): React.JSX.Element {
  return <div className="thread-tag-filter-bar" ref={hostRef} role="group" aria-label="按标签筛选">
    <button type="button" data-hit data-filter="" aria-pressed={!selected}
      className={'thread-tag-filter-option thread-tag-filter-all' + (!selected ? ' active' : '') + (hovered === '' ? ' hovered' : '')}
      onClick={onSelect && (() => onSelect(''))}>
      全部
    </button>
    <div className="thread-tag-filter-groups">
      <div className="thread-tag-filter-group">
        <div className="thread-tag-filter-options">
          {TAG_FILTERS.map(filter => <button type="button" key={filter.tag} data-hit data-filter={filter.tag}
            aria-pressed={selected === filter.tag}
            className={'thread-tag-filter-option' + (selected === filter.tag ? ' active' : '')
              + (filter.cwd ? ' cwd' : '') + (hovered === filter.tag ? ' hovered' : '')}
            onClick={onSelect && (() => onSelect(filter.tag))}>
            {filter.cwd && <Folder className="thread-tag-filter-cwd-icon" size={11} aria-hidden="true" />}
            <span>{filter.tag}</span>
            <small>{filter.count}</small>
          </button>)}
        </div>
      </div>
    </div>
  </div>
}

interface OverviewActionsProps {
  readonly hostRef?: React.Ref<HTMLDivElement>
  readonly archived: boolean
  readonly hovered: string | null
  readonly onActivate?: (action: string) => void
}

/** 按钮组本体：四个图标按钮，展开态由 archived 驱动。 */
function OverviewActions({ hostRef, archived, hovered, onActivate }: OverviewActionsProps): React.JSX.Element {
  const buttons = [
    { action: '回到自动视图', icon: <Shrink size={15} />, active: false },
    { action: '已归档', icon: <Archive size={16} />, active: archived },
    { action: '重启 Dev Electron', icon: <RotateCcw size={15} />, active: false },
    { action: '设置', icon: <Settings size={15} />, active: false }
  ]
  return <div className="thread-overview-actions" ref={hostRef} role="toolbar" aria-label="俯瞰视图操作">
    {buttons.map(button => <button type="button" key={button.action} data-hit data-action={button.action}
      aria-pressed={button.active}
      className={'icon-button' + (button.active ? ' active' : '') + (hovered === button.action ? ' hovered' : '')}
      aria-label={button.action} title={button.action}
      onClick={onActivate && (() => onActivate(button.action))}>{button.icon}</button>)}
  </div>
}

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
          <a href="?scene=lifecycle">动画</a><a href="?scene=layout">Layout</a><a href="?scene=liquid" aria-current="page">Liquid</a>
        </nav>
        <label>外观<select value={theme} onChange={event => setTheme(event.target.value)}><option value="light">浅色</option><option value="dark">深色</option></select></label>
      </div>
    </header>
    <section className="liquid-stage" ref={stageRef} aria-label="Liquid Glass 预览">
      <div className="liquid-measure" aria-hidden="true" ref={measureRef}>
        <TagFilterBar selected="" hovered={null} />
        <OverviewActions archived={false} hovered={null} />
      </div>
      {ready && <LiquidCanvas ref={canvasRef} frameloop="demand" maxDpr={1}
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
      <span>liquid-dom 0.1.1 · 捕获垫片已启用 · 静态预览（frameloop=demand）</span>
      <output aria-live="polite">{notice}</output>
    </footer>
  </main>
}
