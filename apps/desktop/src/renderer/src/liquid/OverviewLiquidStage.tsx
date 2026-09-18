import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Frame, Glass, GlassContainer, Html, LiquidCanvas, Padding, ZStack, type LiquidCanvasRef } from '@liquid-dom/react'
import { getOverviewCameraCockpit } from '../overview-motion'
import { installLiquidCaptureCompat } from './capture-compat'
import { BAR_CORNER, glassFor, useLiquidTheme } from './glass-recipe'

/* 捕获垫片必须在任何 LiquidCanvas 挂载前装好。渲染进程里只有这一个入口会建画布，
   模块求值时装一次即可。 */
installLiquidCaptureCompat()

/**
 * 画布初始化失败就退回普通 DOM。库在拿不到 WebGPU 适配器、拿不到画布上下文、
 * 或者纹理超过设备上限时是直接 `throw`（core 的 `WebGpuDomContentSource`），这些
 * 都发生在挂载期，没有边界就会冒到整棵树上把俯瞰视图一起带走。捕获特性缺失只是
 * 其中一种 —— 有特性、但设备画不出来，同样得退。
 */
class LiquidStageBoundary extends Component<{ readonly onFail: () => void; readonly children: ReactNode },
  { readonly failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[overview-liquid] 画布初始化失败，退回普通 DOM', error)
    this.props.onFail()
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** 浮条在舞台里的盒子，相对舞台左上角，取整数像素。 */
interface BarBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** 浮条入场动画的时长（styles.css 的 `thread-overview-toolbar-in`，320ms）加一点余量。
    动画期间浮条的盒模型没变、`getBoundingClientRect` 却带着 transform，尺寸观察器
    不会在这些帧上回调，所以要主动跟一段时间。 */
const ENTRANCE_FOLLOW_MS = 600

/** 悬停/焦点状态的过渡时长（styles.css 里最长的是 180ms 的 `transform`）加一点余量。
    这几帧里画布得连续重画，否则按钮的位移会停在半路。 */
const STATE_FOLLOW_MS = 220

export interface OverviewLiquidStageProps {
  /** 要进画布当衬底的俯瞰视图主体（滚动容器及其卡片）。 */
  readonly children: React.ReactNode
  /**
   * 画在画布之上、需要玻璃背板的浮条元素。顺序与绘制无关，只影响可读性。
   * 身份变更 = 这组浮条变了（有增删），会重新测一次盒子并重新挂观察器 —— 挂载晚的
   * 浮条（一起初没有标签、之后才出现的筛选栏）只能靠这个信号补上，它的 ref 回填
   * 本身不通知任何人。
   */
  readonly backdropRefs: readonly React.RefObject<HTMLElement | null>[]
  /**
   * 画布挂载、衬底子树已经进 DOM 时回调一次。调用方在画布挂载前拿不到衬底里的
   * 元素（画布要等舞台量出尺寸才渲染），而对象 ref 的回填不会通知任何人 ——
   * 靠这个信号重跑一次测尺寸、重挂一次滚动监听。
   */
  readonly onSubtreeMounted?: () => void
  /**
   * 画布起不来、已经退回画布外那份 DOM 时回调一次。调用方据此把 `.overview-liquid`
   * 一起撤掉 —— 那套样式把两条浮条的背景、模糊、描边都清了，没有玻璃背板撑着就会
   * 变成没有底的字直接压在卡片上。
   */
  readonly onFailure?: () => void
}

/**
 * 把俯瞰视图主体放进 `@liquid-dom` 的画布，并在两条浮条底下画出玻璃背板。
 *
 * 浮条**不进画布**：玻璃内部的 DOM 收不到原生指针事件（库只把指针事件派发到 Glass
 * 上），要保住按钮的原生命中、hover、焦点环和读屏，浮条就得留在画布外、照旧是普通
 * DOM，只是把「半透明表面 + backdrop-filter」那套背景换成背后这一层玻璃。位置按浮条
 * 实测的盒子给，所以玻璃和它背后的控件严格对齐。
 *
 * 玻璃层和衬底层都必须在同一个 GlassContainer 里：`ZStack` 按**子节点顺序**绘制
 * （core 的 `syncSlotZIndices` 把每个子节点放进一个 zIndex = 序号 的 slot），而单独的
 * `Glass` 不是可绘制场景节点（`flattenSceneLayers` 只收 Container / Html）。所以
 * 「Html 在前、GlassContainer 在后」= 玻璃画在捕获到的衬底之上。
 */
export function OverviewLiquidStage({ children, backdropRefs, onSubtreeMounted, onFailure }: OverviewLiquidStageProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<LiquidCanvasRef>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [boxes, setBoxes] = useState<readonly (BarBox | null)[]>(() => backdropRefs.map(() => null))
  const theme = useLiquidTheme()

  /* 舞台自己的尺寸必须按**未变换**的布局盒量：`.thread-overview` 的入场动画是
     `scale(1.012 → 1)`（styles.css 的 `thread-overview-in`），量 `getBoundingClientRect`
     会拿到放大后的值，而动画结束只改 transform、布局盒没变 —— 尺寸观察器不会再回调，
     画布就永远停在放大了 1.2% 的那一版上。`offsetWidth/Height` 不受祖先 transform 影响。 */
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const measure = (): void => {
      const width = stage.offsetWidth
      const height = stage.offsetHeight
      setSize(current => (current.width === width && current.height === height ? current : { width, height }))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  /* 浮条的盒子在三种时候会变，三种都要跟：窗口尺寸（左右边距与断点）、内容（标签增删、
     按钮显隐）、入场动画（期间只有 transform 变，尺寸观察器不会回调）。
     `getBoundingClientRect` 把 transform 也算进去，所以跟动画必须按帧量；量到跟上次一样
     的整数盒子就原样返回，避免拖动期间每帧一次重渲染。 */
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    let frame = 0
    const measure = (): void => {
      const base = stage.getBoundingClientRect()
      const next = backdropRefs.map((ref): BarBox | null => {
        const element = ref.current
        if (!element) return null
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) return null
        return {
          left: Math.round(rect.left - base.left),
          top: Math.round(rect.top - base.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      })
      setBoxes(current => (current.length === next.length && current.every((box, index) => sameBox(box, next[index]))
        ? current
        : next))
    }
    const follow = (until: number): void => {
      measure()
      if (performance.now() >= until) return
      frame = requestAnimationFrame(() => follow(until))
    }
    follow(performance.now() + ENTRANCE_FOLLOW_MS)
    const observer = new ResizeObserver(measure)
    observer.observe(stage)
    for (const ref of backdropRefs) if (ref.current) observer.observe(ref.current)
    window.addEventListener('resize', measure)
    void document.fonts.ready.then(measure)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [backdropRefs])

  const ready = size.width > 0 && size.height > 0
  const [failed, setFailed] = useState(false)
  const handleFailure = (): void => setFailed(true)

  /* 衬底节点本身当信号源，而不是「画布量出尺寸了」这个代理条件：换肤会按外观重挂
     场景图（`<Frame key={theme}>` 下面整棵子树换新），而 `ready` 一直是 true，只认它
     就不会再通知一次 —— 而调用方挂在滚动容器上的尺寸观察器和手势监听还指着已经被摘
     掉的旧节点，换肤之后拖不动也缩不动。
     降级也换衬底节点，但那一趟**不通知**：调用方拿这个信号去重注册 Bart 的空间容器，
     而注册会先注销一次，正在准备的空间转场会因此中止。降级是绘制层面的事，不该把
     已经在跑的转场拽下来；调用方自己按 `liquidDegraded` 重绑观察器和手势就够了。 */
  const [substrate, setSubstrate] = useState<HTMLDivElement | null>(null)
  const bindSubstrate = useCallback((node: HTMLDivElement | null): void => {
    setSubstrate(node)
  }, [])
  useEffect(() => {
    if (substrate && !failed) onSubtreeMounted?.()
  }, [substrate, failed, onSubtreeMounted])

  /* 画布画的是捕获到的那一帧，`frameloop="demand"` 下只有被叫到才重画。相机和滚动
     各有一条失效路径，但它们都不是「内容变了」—— 流式文本、状态点、注意力标记这些
     只改衬底的 DOM，布局盒和偏移都不动。没有这一路，画布会一直停在旧帧，直到用户
     碰一下相机或滚一下才更新。按整棵子树观察，同一帧里的多次改动合并成一次失效。
     这一路还管另外两类衬底不会自己报的变化：
     - 指针悬停和键盘焦点只改伪类，连 DOM 都不动，而归档按钮就是靠
       `:hover`/`:focus-within` 从 `opacity: 0; pointer-events: none` 变成可点的控件
       （styles.css 3172-3185）—— 不跟这几帧，真实 DOM 已经点得到，画布上那个按钮
       却还没出现。切过去还带 140-180ms 的过渡，所以要跟着重画一小段时间。
     - 滚动：偏移只在合成器上变，而展开的关系列表是**独立的滚动区**
       （`data-overview-native-scroll`），它的 scroll 不冒泡到外层滚动容器 —— 只能在
       捕获阶段听。 */
  useEffect(() => {
    if (!substrate || failed) return
    let handle = 0
    let until = 0
    const step = (): void => {
      /* 先放手再重画：`invalidateFrame` 抛了也不会留下已经消费掉的 rAF id，
         否则 `invalidate` 的 `if (handle) return` 会一直把后续失效挡在门外。 */
      handle = 0
      canvasRef.current?.invalidateFrame()
      if (performance.now() >= until) return
      handle = requestAnimationFrame(step)
    }
    /* 同一帧里的多次触发合并成一次重画；带过渡的（悬停、焦点）再跟一段时间，
       期间连续重画。 */
    const invalidate = (window: number): void => {
      until = Math.max(until, performance.now() + window)
      if (handle) return
      handle = requestAnimationFrame(step)
    }
    const observer = new MutationObserver(() => invalidate(0))
    observer.observe(substrate, {
      subtree: true, childList: true, characterData: true, attributes: true
    })
    const onState = (): void => invalidate(STATE_FOLLOW_MS)
    const onScroll = (): void => invalidate(0)
    substrate.addEventListener('pointerover', onState, { passive: true })
    substrate.addEventListener('pointerout', onState, { passive: true })
    substrate.addEventListener('focusin', onState)
    substrate.addEventListener('focusout', onState)
    substrate.addEventListener('scroll', onScroll, { capture: true, passive: true })
    return () => {
      observer.disconnect()
      substrate.removeEventListener('pointerover', onState)
      substrate.removeEventListener('pointerout', onState)
      substrate.removeEventListener('focusin', onState)
      substrate.removeEventListener('focusout', onState)
      substrate.removeEventListener('scroll', onScroll, { capture: true })
      if (handle) cancelAnimationFrame(handle)
    }
  }, [substrate, failed])

  /* 画布彻底起不来时只退回画布外那份 DOM 还不够：`.overview-liquid` 那套「浮条背景
     透明」的样式还挂在外层，两条浮条会变成没有背板的字直接压在下面的卡片上。告诉
     调用方，让它连那条分支和类名一起撤掉。 */
  useEffect(() => {
    if (failed) onFailure?.()
  }, [failed, onFailure])

  /* 平移和缩放是命令式改 plane 的 transform，只落在合成器上，浏览器不会为此给画布发
     paint，库也就不会重捕获 —— 不挂这一路，玻璃底下会一直停着拖动前那一帧。
     同一帧里的多次相机更新合并成一次失效。 */
  useEffect(() => {
    let handle = 0
    const invalidate = (): void => {
      if (handle) return
      handle = requestAnimationFrame(() => {
        handle = 0
        canvasRef.current?.invalidateLayout()
        canvasRef.current?.invalidateFrame()
      })
    }
    const unsubscribe = getOverviewCameraCockpit().subscribeFrame(invalidate)
    return () => {
      unsubscribe()
      if (handle) cancelAnimationFrame(handle)
    }
  }, [])

  return <div className="overview-liquid-stage" ref={stageRef}>
    {ready && (failed
      ? <div className="overview-liquid-substrate" ref={bindSubstrate}>{children}</div>
      : <LiquidStageBoundary onFail={handleFailure}>
          <LiquidCanvas ref={canvasRef} frameloop="demand"
            style={{ width: '100%', height: '100%' }}
            canvasStyle={{ display: 'block', width: '100%', height: '100%' }}
            onError={error => {
              console.error('[overview-liquid] 帧循环失败，退回普通 DOM', error)
              handleFailure()
            }}>
            {/* 换肤只改 CSS 变量，玻璃的染色却是挂载时读进去的，所以按外观重挂一次场景图。 */}
            <Frame key={theme} width={size.width} height={size.height}>
              <ZStack alignment="topLeading">
                <Html sizing="fill">
                  <div className="overview-liquid-substrate" ref={bindSubstrate}>{children}</div>
                </Html>
                {boxes.map((box, index) => box && (
                  <Padding key={index} insets={{ left: box.left, top: box.top }}>
                    <GlassContainer {...glassFor(theme)}>
                      <Frame width={box.width} height={box.height}>
                        <Glass {...BAR_CORNER} />
                      </Frame>
                    </GlassContainer>
                  </Padding>
                ))}
              </ZStack>
            </Frame>
          </LiquidCanvas>
        </LiquidStageBoundary>)}
  </div>
}

function sameBox(left: BarBox | null, right: BarBox | null): boolean {
  if (left === null || right === null) return left === right
  return left.left === right.left && left.top === right.top
    && left.width === right.width && left.height === right.height
}
