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

/* 两个玻璃容器共用一套光学参数：薄、低模糊，让背后正文在边缘弯折而不是被糊平，
   这正是和 backdrop-filter 候选的差别所在。 */
export const GLASS = {
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
