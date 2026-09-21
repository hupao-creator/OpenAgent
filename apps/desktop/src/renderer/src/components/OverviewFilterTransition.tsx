import { Component, type ReactNode, type RefObject } from 'react'
import type { OverviewFilterMotion } from '../overview-motion/filter-motion'

interface Props {
  selectionKey: string
  sceneKey: string
  enabled: boolean
  playbackRate: number
  viewport: RefObject<HTMLDivElement | null>
  motion: OverviewFilterMotion
  children: ReactNode
}

type Start = (() => void) | null

/** React's pre-mutation lifecycle is required to retain the outgoing rendered frame. */
export class OverviewFilterTransition extends Component<Props, Record<string, never>, Start> {
  getSnapshotBeforeUpdate(previous: Props): Start {
    const props = this.props
    if (props.enabled && previous.selectionKey !== props.selectionKey) {
      return props.motion.capture(props.viewport.current, props.playbackRate)
    }
    if (!props.enabled || previous.sceneKey !== props.sceneKey || previous.playbackRate !== props.playbackRate) props.motion.cancel()
    return null
  }

  componentDidUpdate(_previous: Props, _state: Record<string, never>, start: Start): void {
    // The parent cuts the scene and commits the new fitted camera in a microtask.
    // Register the new filter lease only after that cut, before the next paint.
    if (start) queueMicrotask(() => queueMicrotask(start))
  }

  componentWillUnmount(): void { this.props.motion.cancel() }

  render(): ReactNode { return this.props.children }
}
