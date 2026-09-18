import { Component, type ReactNode } from 'react'

/** One boundary for every liquid stage. The library throws while mounting its
 * canvas when it cannot get a WebGPU adapter, a canvas context, or a capture
 * texture within the device limits; without a boundary that escapes into the
 * host scene graph. The stage's contract is to fall back to plain DOM instead. */
export class LiquidStageBoundary extends Component<
  { readonly label: string; readonly onFail: (error: unknown) => void; readonly children: ReactNode },
  { readonly failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { readonly failed: true } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error(`[${this.props.label}] canvas unavailable; falling back to plain DOM`, error)
    this.props.onFail(error)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
