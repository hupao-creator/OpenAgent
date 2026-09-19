/**
 * 俯瞰视图里两条浮条的玻璃配方。生产与 `?scene=liquid` playground 共用同一份，
 * 否则调好的光学参数会在两处各自漂移。
 */
import { useEffect, useState } from 'react'

export type LiquidTheme = 'light' | 'dark'

/* 光学参数的**配方**照 `IosNotificationDemo`（库自带的展示页）抄，但**数值要按元素
   大小缩**——展示页那条通知是 616×112，本项目的浮条只有 ~490×42，直接把绝对值搬过来，
   厚度类的项会占满整个形状。`bezelWidth` 18 就是这个坑：它表示边缘往里多少像素走
   折射，展示页整条高度 112 时中段还留 76px 的平窗，压到 42 高就只剩 6px —— 整条栏
   都成了折射带，于是出现横贯的明暗条纹和糊开的背景，看着很不自然。按高度比例
   （42/112≈0.375）缩到 5，`thickness` 90 缩到 30，阴影 7/21 缩到 3/10。
   `blur` 反而是**越小越干净**：它与尺寸无关，12 会把远处卡片的明暗差也采样进来，
   在条上摊成一片灰；衬底就在浮条背后，5 已经够柔。
   展示页还传了 `blendSupportGating={false}`，这里没有跟：它只存在于未发布的 master
   （npm 上 latest 就是 0.1.1），而且即便有也用不上 —— 上游是拿它按形状面积调制
   smooth-union 的融合半径，只在同一个容器装了多个形状时才生效
   （core.ts 里 `container.blendSupportGating.enabled && activeCount > 1`）。展示页把
   三个形状放进同一个 GlassContainer 互相滑动融合，所以需要；本项目每个容器只有一个
   Glass，两条浮条又分处屏幕两端、永远不会接触，开了也是空转。 */
const GLASS_BASE = {
  spacing: 8,
  blur: 5,
  bezelWidth: 5,
  thickness: 30,
  specularOpacity: 0.6,
  shadowColor: { r: 0, g: 0, b: 0, a: 0.2 },
  shadowOffsetY: 3,
  shadowBlur: 10
}

/* 不染色，但**必须显式写出来、不能把这个键删掉**：库的默认 tint 是白色 15%
   （`MaterialOptions` 里 `tint = { r: 1, g: 1, b: 1, a: 0.15 }`），删键等于换回那层白雾。
   着色器里 tint 只出现一次 —— `mix(refractedColor, tint.rgb, tint.a)` —— a 为 0 时这个
   mix 恒等于折射色本身，所以零 alpha 才是真的没有叠加。浅深两套共用一份（零 alpha 下
   rgb 不起作用），但要的是一个稳定对象：悬停 / 选中会频繁重渲染，每次现拼一个新对象
   会被当成属性一直在变，白白往场景图上写。
   代价是浮条内部回到背景被折射 + 模糊后的原样，底下的深色卡片会直接透上来，
   可读性只能靠浮条外那套 DOM 样式兜 —— 这是取舍不是开关。 */
const GLASS_TINT = { r: 1, g: 1, b: 1, a: 0 }

/* 预先拼好两份，好让每次渲染拿到同一个对象。两套目前内容相同，按键留着是为了
   给 `glassFor` 一个按外观取值的形状 —— 哪天浅深要分开调光学参数，就在这里分。 */
const GLASS_FOR_THEME = {
  light: { ...GLASS_BASE, tint: GLASS_TINT },
  dark: { ...GLASS_BASE, tint: GLASS_TINT }
}

export function glassFor(theme: LiquidTheme): typeof GLASS_FOR_THEME.light {
  return theme === 'dark' ? GLASS_FOR_THEME.dark : GLASS_FOR_THEME.light
}

/* 两条浮条的圆角是 CSS `border-radius: 13px`，正圆角。库的 `cornerSmoothing` 默认
   0.6，走的是 iOS 那种连续曲率的方圆形（`core` 里 `DEFAULT_CORNER_SMOOTHING = 0.6`，
   注释说 "tuned for an iOS-like squircle"）—— 同样写 13，看着比生产更圆，弧也拉得更长，
   因为方形圆的曲率过渡铺得比圆弧宽。要和生产对齐就得把这个默认值按回 0。 */
export const BAR_CORNER = { cornerRadius: 13, cornerSmoothing: 0 }

/** 应用当前的解析外观。生产把浅深两套写在 `@media (prefers-color-scheme)` 里，
 *  所以这里也问媒体查询，而不是读某个主题属性。 */
export function useLiquidTheme(): LiquidTheme {
  const query = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    /* An engine whose MediaQueryList answers `matches` but has no listener API
       cannot report a change; the read above is the whole answer it has. */
    if (typeof media.addEventListener !== 'function') return
    const onChange = (): void => setDark(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return dark ? 'dark' : 'light'
}
