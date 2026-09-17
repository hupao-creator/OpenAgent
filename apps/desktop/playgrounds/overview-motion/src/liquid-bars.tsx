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

/* 两个玻璃容器共用一套光学参数，取值照 `IosNotificationDemo`（库自带的展示页）抄。
   它靠**糊**而不是靠**染色**把背后的东西隐藏掉：`blur` 12 把背景糊成一片柔和的色块，
   `tint` 只留 0.22 的极淡染色。这条要点别改反了 —— 库会把弯折后的背景画在玻璃轮廓
   里，却不盖住底下那份没弯折的原图，tint 一重就只是把它涂白，重影和硬切的边都还在。
   剩下的项一律不显式给，用 0.1.1 的默认值（thickness 90 / displacementFactor 1 /
   ior 1.5 / dispersion 0），跟展示页保持一致。
   展示页还传了 `blendSupportGating={false}`，这里没有跟：它只存在于未发布的 master
   （npm 上 latest 就是 0.1.1），而且即便有也用不上 —— 上游是拿它按形状面积调制
   smooth-union 的融合半径，只在同一个容器装了多个形状时才生效
   （core.ts 里 `container.blendSupportGating.enabled && activeCount > 1`）。展示页把
   三个形状放进同一个 GlassContainer 互相滑动融合，所以需要；本场景每个容器只有一个
   Glass，两条栏又分处屏幕两端、永远不会接触，开了也是空转。 */
const GLASS_BASE = {
  spacing: 10,
  blur: 12,
  bezelWidth: 18,
  specularOpacity: 0.6,
  shadowColor: { r: 0, g: 0, b: 0, a: 0.2 },
  shadowOffsetY: 7,
  shadowBlur: 21
}

/* 染色分浅深两套，同样是展示页里 light / night 那一对。 */
const GLASS_TINT = {
  light: { r: 0.82, g: 0.92, b: 0.95, a: 0.22 },
  dark: { r: 0.7, g: 0.7, b: 0.7, a: 0.22 }
}

/* 预先拼好两份，好让每次渲染拿到同一个对象：场景在悬停 / 选中时频繁重渲染，
   每次现拼一个新对象会把这些属性当成一直在变，白白往场景图上写。 */
const GLASS_FOR_THEME = {
  light: { ...GLASS_BASE, tint: GLASS_TINT.light },
  dark: { ...GLASS_BASE, tint: GLASS_TINT.dark }
}

export function glassFor(theme: string): typeof GLASS_FOR_THEME.light {
  return theme === 'dark' ? GLASS_FOR_THEME.dark : GLASS_FOR_THEME.light
}

interface TagFilterBarProps {
  readonly hostRef?: React.Ref<HTMLDivElement>
  readonly selected: string
  readonly hovered: string | null
  readonly onSelect?: (filter: string) => void
}

/** 筛选栏本体：类名与结构和 ConversationOverview 一致，只说数据不说外观。 */
export function TagFilterBar({ hostRef, selected, hovered, onSelect }: TagFilterBarProps): React.JSX.Element {
  return <div className="thread-tag-filter-bar" data-liquid-bar ref={hostRef} role="group" aria-label="按标签筛选">
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
export function OverviewActions({ hostRef, archived, hovered, onActivate }: OverviewActionsProps): React.JSX.Element {
  const buttons = [
    { action: '回到自动视图', icon: <Shrink size={15} />, active: false },
    { action: '已归档', icon: <Archive size={16} />, active: archived },
    { action: '重启 Dev Electron', icon: <RotateCcw size={15} />, active: false },
    { action: '设置', icon: <Settings size={15} />, active: false }
  ]
  return <div className="thread-overview-actions" data-liquid-bar ref={hostRef} role="toolbar" aria-label="俯瞰视图操作">
    {buttons.map(button => <button type="button" key={button.action} data-hit data-action={button.action}
      aria-pressed={button.active}
      className={'icon-button' + (button.active ? ' active' : '') + (hovered === button.action ? ' hovered' : '')}
      aria-label={button.action} title={button.action}
      onClick={onActivate && (() => onActivate(button.action))}>{button.icon}</button>)}
  </div>
}
