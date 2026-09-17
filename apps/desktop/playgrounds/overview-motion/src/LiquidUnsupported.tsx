import { canvasDrawElementGap } from './liquid-capture-compat'

/**
 * 两个 liquid 场景共用的能力缺失提示。缺了 CanvasDrawElement 时库一帧都渲染不出来，
 * 舞台会是空白的；这里把原因和出路写在舞台上，而不是让错误堆在 console 里。
 */
export function LiquidUnsupported(): React.JSX.Element {
  return <div className="liquid-unsupported" role="status">
    <strong>此环境无法渲染液体玻璃</strong>
    <p>{canvasDrawElementGap()}</p>
  </div>
}
