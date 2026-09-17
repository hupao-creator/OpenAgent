// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cardRevealBlocks } from '../src/renderer/src/card-generation/reveal'
import { motionCardRevision } from '../src/renderer/src/bart-motion/card-assets'

afterEach(() => document.body.replaceChildren())
describe('prepared card content ownership', () => {
  it('includes report body and each extension once without changing native clips', () => {
    const card = document.createElement('article')
    card.innerHTML = '<div class="report-overview-preview" style="clip-path:inset(2px)">Report</div>' +
      '<div class="thread-card-extension"><div class="thread-overview-excerpt">Nested content</div></div>'
    document.body.append(card)
    const before = card.innerHTML
    expect(cardRevealBlocks(card).map(block => block.textContent)).toEqual(['Report', 'Nested content'])
    expect(card.innerHTML).toBe(before)
  })
  it('ends a stale snapshot on text, image, layout class or busy changes, excluding rolling time labels', () => {
    const card = document.createElement('article')
    card.innerHTML = '<p>Current</p><img src="first.png"><span class="thread-card-rolling-number">1</span>'
    document.body.append(card)
    let revision = motionCardRevision(card)
    card.querySelector('span')!.textContent = '2'
    expect(motionCardRevision(card)).toBe(revision)
    for (const change of [
      () => { card.querySelector('p')!.textContent = 'Latest' },
      () => { card.querySelector('img')!.src = 'second.png' },
      () => { card.className = 'expanded' },
      () => { card.querySelector('p')!.setAttribute('aria-busy', 'true') }
    ]) {
      change()
      const next = motionCardRevision(card)
      expect(next).not.toBe(revision)
      revision = next
    }
  })
})
