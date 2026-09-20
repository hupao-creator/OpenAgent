import { memo, useId, useRef, type RefObject } from 'react'
import type { BartDockRole } from '../bart-role'
import { BART_REASONING_DEFAULTS, reasoningGeometry, type BartReasoningOptions } from '../bart-motion/reasoning-geometry'
import { useBartReasoning } from '../bart-motion/use-bart-reasoning'
import './bart-role.css'

/**
 * The locked role decoration shared by the production Dock and Bart Lab: the
 * reasoning arc with its attentive eyes, and the tool-call signature. Every
 * position comes from the locked 400x310 study stage, scaled by the avatar
 * carrier so Bart's body keeps its production size.
 */
export const BartRoleDecoration = memo(function BartRoleDecoration({
  role, dockRef, active, reasoningOptions = BART_REASONING_DEFAULTS
}: {
  role: BartDockRole
  dockRef: RefObject<HTMLElement | null>
  active: boolean
  reasoningOptions?: BartReasoningOptions
}): React.JSX.Element | null {
  const arcId = `bart-role-arc-${useId().replace(/:/g, '')}`
  const stage = useRef<HTMLDivElement>(null)
  const geometry = reasoningGeometry(reasoningOptions.length, reasoningOptions.tilt)
  useBartReasoning(stage, dockRef, role.kind === 'reasoning' ? role.text : null, active, reasoningOptions)
  if (role.kind === 'idle') return null
  return (
    <div ref={stage} className="bart-role-stage" data-role={role.kind} aria-hidden="true">
      {role.kind === 'reasoning' ? (
        <>
          {role.text ? (
            <svg className="bart-role-arc" viewBox="0 0 400 310" style={{ maskImage: geometry.mask }}>
              <defs>
                <path id={arcId} d={geometry.path} />
              </defs>
              <text>
                {/* The measured tail is centered on the same circle at every
                    length. Streaming moves the retained glyphs along it. */}
                <textPath href={`#${arcId}`} startOffset="50%" textAnchor="end">
                  {role.text}
                </textPath>
              </text>
            </svg>
          ) : null}
          <div className="bart-role-avatar">
            <svg className="bart-role-face" viewBox="0 0 640 640" fill="none">
              <g className="bart-role-gaze">
                <g className="bart-role-eyes">
                  <rect className="bart-role-eye-left" x="270" y="249" width="27" height="63" rx="15" />
                  <rect className="bart-role-eye-right" x="342" y="246" width="27" height="63" rx="15" />
                </g>
              </g>
            </svg>
          </div>
        </>
      ) : (
        <div className="bart-role-arrival">
          <div className="bart-role-signature">
            <span className="bart-role-tool-name">{role.toolName}</span>
            <span className="bart-role-parens">()</span>
          </div>
        </div>
      )}
    </div>
  )
})
