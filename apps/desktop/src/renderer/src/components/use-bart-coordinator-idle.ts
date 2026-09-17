import { useLayoutEffect, type RefObject } from 'react'

/** One autonomous compositor timeline includes gestures AND the rests between them. */
export function useBartCoordinatorIdle(rootRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const character = rootRef.current?.querySelector<HTMLElement>('.bart-host-character')
    if (!enabled || !character || typeof character.animate !== 'function') return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    let animation: Animation | undefined
    const update = (): void => {
      animation?.cancel()
      if (document.hidden || reduced?.matches) return
      const neutral = 'translate(0, 0) rotate(0) scale(1)'
      const duration = 76000
      const frames: Keyframe[] = [{ transform: neutral, offset: 0 }]
      const gestures = [
        { at: 6000, poses: [neutral, 'translate(3px, -1px) rotate(7deg)', 'translate(3px, -1px) rotate(7deg)', neutral] },
        { at: 19000, poses: [neutral, 'translateY(3px) rotate(-4deg) scale(1.04,.95)', 'translateY(-1px) scale(.99,1.02)', neutral] },
        { at: 32000, poses: [neutral, 'translate(-3px, -1px) rotate(-13deg)', 'translate(-3px, -1px) rotate(-13deg)', neutral] },
        { at: 45000, poses: [neutral, 'translateY(-3px) rotate(3deg) scale(.94,1.13)', 'translateY(1px) scale(1.04,.97)', neutral] },
        { at: 58000, poses: [neutral, 'translateY(2px) scale(1.08,.9)', 'translateY(-8px) rotate(-6deg) scale(.96,1.05)', 'translateY(2px) scale(1.06,.94)', neutral] }
      ]
      for (const gesture of gestures) {
        gesture.poses.forEach((transform, index) => frames.push({ transform,
          offset: (gesture.at + index / (gesture.poses.length - 1) * 1700) / duration, easing: 'ease-in-out' }))
      }
      frames.push({ transform: neutral, offset: 1 })
      animation = character.animate(frames, { duration, iterations: Infinity })
    }
    reduced?.addEventListener('change', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => { animation?.cancel(); reduced?.removeEventListener('change', update); document.removeEventListener('visibilitychange', update) }
  }, [rootRef, enabled])
}
