/**
 * `@liquid-dom/core@0.1.1` 调用的是被取代的 `copyElementImageToTexture` 形状：
 *
 *   queue.copyElementImageToTexture(element, width, height, { texture })
 *
 * 本机 Chromium（Electron 43 / Blink CanvasDrawElement）的签名已经收敛成两个参数：
 *
 *   queue.copyElementImageToTexture({ source }, { destination: { texture }, width, height })
 *
 * 不做转换时每次捕获都抛 TypeError，采样纹理恒为空，玻璃一帧都渲染不出来。
 * 这里只翻译这一次调用的形状；玻璃的着色、折射、高光、合成仍然全部由库完成。
 *
 * 这是液体玻璃要计入的平台风险：库跟着旧形状，宿主升到新形状就得有这么一个垫片，
 * 而这个实验性 API 还会继续变。它不是可以长期留下的代码。
 */
export function installLiquidCaptureCompat(): void {
  if (typeof GPUQueue === 'undefined') return

  const proto = GPUQueue.prototype as unknown as {
    copyElementImageToTexture?: (source: unknown, ...rest: unknown[]) => void
    __liquidCaptureCompat?: boolean
  }
  if (proto.__liquidCaptureCompat) return

  const original = proto.copyElementImageToTexture
  if (typeof original !== 'function') return

  proto.copyElementImageToTexture = function (this: GPUQueue, source: unknown, ...rest: unknown[]): void {
    if (source && typeof source === 'object' && 'source' in source) {
      original.call(this, source, ...rest)
      return
    }
    const [width, height, destination] = rest as [number, number, { texture: GPUTexture }]
    original.call(this, { source }, { destination: { texture: destination.texture }, width, height })
  }
  proto.__liquidCaptureCompat = true
}

/**
 * CanvasDrawElement 是未发布的实验特性，只有宿主进程开了 Blink 开关才有
 * （见 apps/desktop/src/main/index.ts 的 enable-blink-features=CanvasDrawElement）。
 * 渲染进程里没有这个开关 —— 单元测试的 DOM 环境、浏览器的 playground、任何没带上
 * 开关的宿主都缺这两个成员，库每次捕获都会抛 TypeError。
 *
 * 返回缺什么；有就返回 null。
 */
export function canvasDrawElementGap(): string | null {
  if (typeof HTMLCanvasElement === 'undefined') return '当前环境没有 DOM。'
  // 这两个成员都不在 TS 的 DOM 类型里 —— 特性还没发布，只能按运行时实际有没有来判。
  const prototype = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  if (typeof prototype.captureElementImage !== 'function' || !('layoutSubtree' in prototype)) {
    return '这个环境没有 CanvasDrawElement。它是未发布的实验特性，需要宿主进程在启动前'
      + '打开 Blink 开关（apps/desktop/src/main/index.ts 的 enable-blink-features=CanvasDrawElement）。'
  }
  return null
}
