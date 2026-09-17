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
 * 这是液体玻璃候选要计入的平台风险：库跟着旧形状，宿主升到新形状就得有这么一个
 * 垫片，而这个实验性 API 还会继续变。它不是可以长期留下的代码。
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
