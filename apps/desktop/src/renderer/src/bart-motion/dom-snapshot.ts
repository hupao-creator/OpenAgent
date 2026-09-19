import { toSvg } from 'html-to-image'
import type { Options } from 'html-to-image/lib/types'

let captureId = 0

/** Preserve exact font metrics and grid auto margins in the serialized clone.
 * html-to-image rounds font sizes and resolves grid auto margins to zero. */
export async function snapshotSurface(source: HTMLElement, options: Options, prepareClone?: (document: Document) => void): Promise<HTMLCanvasElement> {
  return (await snapshotSurfaceVariants(source, options, [prepareClone]))[0]!
}

/** Variants share one DOM/style read and serialization, keeping sealing bounded. */
export async function snapshotSurfaceVariants(source: HTMLElement, options: Options, variants: readonly (((document: Document) => void) | undefined)[]): Promise<HTMLCanvasElement[]> {
  const attribute = `data-bart-capture-${++captureId}`
  // html-to-image replaces a canvas with its bitmap, but still traverses its
  // children. Those descendants are already represented by the bitmap and
  // must not be cloned into the img.
  const insideCapturedCanvas = (node: Node): boolean => {
    const canvas = node.parentElement?.closest('canvas')
    return !!canvas && source.contains(canvas)
  }
  const elements = [source, ...source.querySelectorAll<HTMLElement | SVGElement>('*')]
    .filter(element => element === source || !insideCapturedCanvas(element))
  const metrics = elements.map((element, index) => {
    const previous = element.getAttribute(attribute)
    element.setAttribute(attribute, String(index))
    return { previous, fontSize: getComputedStyle(element).fontSize, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft }
  })
  let url: string
  try { url = await toSvg(source, {
    ...options,
    filter: node => !insideCapturedCanvas(node) && (options.filter?.(node) ?? true)
  }) }
  finally {
    elements.forEach((element, index) => {
      const previous = metrics[index]!.previous
      if (previous === null) element.removeAttribute(attribute)
      else element.setAttribute(attribute, previous)
    })
  }
  const xml = new DOMParser().parseFromString(decodeURIComponent(url.slice(url.indexOf(',') + 1)), 'image/svg+xml')
  xml.querySelectorAll<HTMLElement | SVGElement>(`[${attribute}]`).forEach((element) => {
    const metric = metrics[Number(element.getAttribute(attribute))]!
    element.style.fontSize = metric.fontSize
    element.style.animation = 'none'
    element.style.transition = 'none'
    element.style.willChange = 'auto'
    if (element.classList.contains('composer-wrap')) {
      element.style.marginLeft = 'auto'
      element.style.marginRight = 'auto'
      element.style.marginInlineStart = 'auto'
      element.style.marginInlineEnd = 'auto'
    }
    if (metric.scrollTop || metric.scrollLeft) {
      Array.from(element.children).forEach((child) => {
        if (child instanceof HTMLElement || child instanceof SVGElement) child.style.translate = `${-metric.scrollLeft}px ${-metric.scrollTop}px`
      })
    }
    element.removeAttribute(attribute)
  })
  return Promise.all(variants.map(async prepare => {
    const clone = xml.cloneNode(true) as Document
    prepare?.(clone)
    const image = new Image()
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(options.width! * options.pixelRatio!)
    canvas.height = Math.round(options.height! * options.pixelRatio!)
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas
  }))
}
