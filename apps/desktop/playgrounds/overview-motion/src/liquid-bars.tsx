import { Archive, Folder, RotateCcw, Settings, Shrink } from 'lucide-react'

/* 生产里这条筛选栏的标签来自会话数据；这里是固定的一小撮，只为让对照面有同样的
   形状：一个“全部”加若干带计数的标签，其中一个是工作目录标签。 */
const TAG_FILTERS = [
  { tag: 'openagent', count: 12, cwd: true },
  { tag: '渲染', count: 8, cwd: false },
  { tag: '概述视图', count: 6, cwd: false },
  { tag: '性能', count: 4, cwd: false },
  { tag: '文档', count: 3, cwd: false }
]

export interface BarBox {
  readonly width: number
  readonly height: number
}

export const EMPTY_BOX: BarBox = { width: 0, height: 0 }

/** 把玻璃局部坐标落到它承载的 DOM 上，找出指针底下的元素。 */
export function hitTestHost(host: HTMLElement | null, hit: { localX: number; localY: number }): HTMLElement | null {
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
export function measureBar(root: HTMLElement | null, selector: string): BarBox {
  const element = root?.querySelector(selector)
  if (!element) return EMPTY_BOX
  const rect = element.getBoundingClientRect()
  return rect.width <= 0 ? EMPTY_BOX : { width: Math.ceil(rect.width), height: Math.ceil(rect.height) }
}

/* 生产的窄屏规则（`styles.css` 的 `@media (max-width: 620px)`）把两条栏竖排：动作栏
   在上、靠右，筛选栏回常流撑满一整条、落在它下面，间距 8px；边距同时收紧到 14px。
   场景里两条栏是各自独立的 Frame，没有那个 column 容器，得自己把排布算出来 ——
   否则两帧都停在 top:16，后画的动作栏会盖住筛选栏的右半边，还会吃掉它的点击。 */
export const NARROW_BREAKPOINT = 620
const NARROW_TOP = 10
const NARROW_SIDE = 14
const NARROW_GAP = 8
/* 生产里 header 是 `top:16 / left:18 / right:18`（宽屏），两条栏各自贴合。 */
const WIDE_TOP = 16
const WIDE_SIDE = 18

export interface BarInsets {
  readonly top: number
  readonly right?: number
  readonly left?: number
}

/** 量尺寸副本的横向边距要和生产的 header 内容盒一致，否则筛选栏那条
    `max-width: calc(100% - 300px - …)` 里的 100% 就不是生产里的那个 100%。 */
export function measureInsets(narrow: boolean): { left: number; right: number } {
  const side = narrow ? NARROW_SIDE : WIDE_SIDE
  return { left: side, right: side }
}

/** 两条栏在场景里的内边距。`actionsHeight` 只在窄屏下用得到：筛选栏要排在动作栏下面。 */
export function barInsets(narrow: boolean, bar: 'filter' | 'actions', actionsHeight: number): BarInsets {
  if (!narrow) return bar === 'filter' ? { top: WIDE_TOP } : { top: WIDE_TOP, right: WIDE_SIDE }
  if (bar === 'actions') return { top: NARROW_TOP, right: NARROW_SIDE }
  return { top: NARROW_TOP + actionsHeight + NARROW_GAP, left: NARROW_SIDE, right: NARROW_SIDE }
}

/* 生产两条栏的圆角是 CSS `border-radius: 13px`，正圆角。库的 `cornerSmoothing` 默认
   0.6，走的是 iOS 那种连续曲率的方圆形（`core` 里 `DEFAULT_CORNER_SMOOTHING = 0.6`，
   注释说 "tuned for an iOS-like squircle"）—— 同样写 13，看着比生产更圆，弧也拉得更长，
   因为方形圆的曲率过渡铺得比圆弧宽。要和生产对齐就得把这个默认值按回 0。 */
export const BAR_CORNER = { cornerRadius: 13, cornerSmoothing: 0 }

interface TagFilterBarProps {
  readonly hostRef?: React.Ref<HTMLDivElement>
  readonly selected: string
  readonly hovered: string | null
  readonly onSelect?: (filter: string) => void
  /** 进画布那一份的显式宽度，取量出来的盒子。见 liquid.css 里那段说明。 */
  readonly boxWidth?: number
}

/** 筛选栏本体：类名与结构和 ConversationOverview 一致，只说数据不说外观。 */
export function TagFilterBar({ hostRef, selected, hovered, onSelect, boxWidth }: TagFilterBarProps): React.JSX.Element {
  return <div className="thread-tag-filter-bar" data-liquid-bar ref={hostRef} role="group" aria-label="按标签筛选"
    style={boxWidth === undefined ? undefined : { width: boxWidth }}>
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
  /** 同 TagFilterBar 的 boxWidth。 */
  readonly boxWidth?: number
}

/** 按钮组本体：四个图标按钮，展开态由 archived 驱动。 */
export function OverviewActions({ hostRef, archived, hovered, onActivate, boxWidth }: OverviewActionsProps): React.JSX.Element {
  const buttons = [
    { action: '回到自动视图', icon: <Shrink size={15} />, active: false },
    { action: '已归档', icon: <Archive size={16} />, active: archived },
    { action: '重启 Dev Electron', icon: <RotateCcw size={15} />, active: false },
    { action: '设置', icon: <Settings size={15} />, active: false }
  ]
  return <div className="thread-overview-actions" data-liquid-bar ref={hostRef} role="toolbar" aria-label="俯瞰视图操作"
    style={boxWidth === undefined ? undefined : { width: boxWidth }}>
    {buttons.map(button => <button type="button" key={button.action} data-hit data-action={button.action}
      aria-pressed={button.active}
      className={'icon-button' + (button.active ? ' active' : '') + (hovered === button.action ? ' hovered' : '')}
      aria-label={button.action} title={button.action}
      onClick={onActivate && (() => onActivate(button.action))}>{button.icon}</button>)}
  </div>
}
