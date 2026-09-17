/** A short-lived, inert copy of one mounted card, not a second card renderer. */
export function freezeCardDOM(source: HTMLElement): { element: HTMLElement; dispose(): void } {
  const document = source.ownerDocument
  const element = source.cloneNode(true) as HTMLElement
  const originals = [source, ...source.querySelectorAll<HTMLElement | SVGElement>('*')]
  const copies = [element, ...element.querySelectorAll<HTMLElement | SVGElement>('*')]
  const host = document.createElement('div')
  host.setAttribute('data-bart-card-snapshot', '')
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  // A closed shadow tree avoids duplicate IDs, application selectors and React
  // ownership. Layout remains available to the existing html-to-image pipeline.
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none;contain:strict'
  const shadow = host.attachShadow({ mode: 'closed' })
  const rules: string[] = []
  const scroll: { element: Element; top: number; left: number }[] = []
  const declaration = (style: CSSStyleDeclaration): string => Array.from(style)
    .map(property => `${property}:${style.getPropertyValue(property)};`).join('')
  try {
    // All reads of the live tree are synchronous. The asynchronous encoder must
    // never observe the live card again, even if its content changes mid-decode.
    originals.forEach((original, index) => {
      const copy = copies[index]!
      if (!copy.style) return
      copy.style.cssText = declaration(getComputedStyle(original))
      copy.style.animation = 'none'
      copy.style.transition = 'none'
      copy.style.willChange = 'auto'
      copy.setAttribute('data-bart-snapshot-node', String(index))
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(original, pseudo)
        if (!style.content || style.content === 'none' || style.content === 'normal') continue
        rules.push(`[data-bart-snapshot-node="${index}"]${pseudo}{${declaration(style)}animation:none;transition:none;}`)
      }
      // DOM cloning does not capture these live properties. Keep scroll local
      // and pin responsive images to the source selected at the sampling point.
      scroll.push({ element: copy, top: original.scrollTop, left: original.scrollLeft })
      if (original instanceof HTMLImageElement && copy instanceof HTMLImageElement) {
        copy.removeAttribute('srcset'); copy.removeAttribute('sizes')
        copy.loading = 'eager'
        copy.src = original.currentSrc || original.src
      }
      if (original instanceof HTMLCanvasElement && copy instanceof HTMLCanvasElement) {
        copy.width = original.width; copy.height = original.height
        if (original.width && original.height) {
          const context = copy.getContext('2d')
          if (!context) throw new Error('Bart card canvas snapshot unavailable')
          context.drawImage(original, 0, 0)
        }
      }
      if (original instanceof HTMLInputElement && copy instanceof HTMLInputElement) {
        copy.value = original.value; copy.checked = original.checked
      }
      if (original instanceof HTMLTextAreaElement && copy instanceof HTMLTextAreaElement) copy.value = original.value
      if (original instanceof HTMLSelectElement && copy instanceof HTMLSelectElement) copy.value = original.value
    })
    const style = document.createElement('style')
    style.textContent = rules.join('\n')
    shadow.append(style, element)
    document.body.append(host)
    scroll.forEach(({ element: node, top, left }) => { node.scrollTop = top; node.scrollLeft = left })
    return { element, dispose: () => host.remove() }
  } catch (error) { host.remove(); throw error }
}
