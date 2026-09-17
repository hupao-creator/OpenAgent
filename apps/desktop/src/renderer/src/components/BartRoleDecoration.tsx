import { memo, useId } from 'react'
import type { BartDockRole } from '../bart-role'
import './bart-role.css'

/**
 * The locked role decoration shared by the production Dock and Bart Lab: the
 * reasoning arc with its attentive eyes, and the tool-call signature. Every
 * position comes from the locked 400x310 study stage, scaled by the avatar
 * carrier so Bart's body keeps its production size.
 */
export const BartRoleDecoration = memo(function BartRoleDecoration({
  role
}: {
  role: BartDockRole
}): React.JSX.Element | null {
  const arcId = `bart-role-arc-${useId().replace(/:/g, '')}`
  if (role.kind === 'idle') return null
  return (
    <div className="bart-role-stage" data-role={role.kind} aria-hidden="true">
      {role.kind === 'reasoning' ? (
        <>
          {role.text ? (
            <svg className="bart-role-arc" viewBox="0 0 400 310">
              <defs>
                <path id={arcId} d="M110 154 A90 90 0 0 1 290 154" />
              </defs>
              <text>
                {/* Anchor the newest text above the blue dot. The path clips
                    older glyphs at its start using their actual shaped widths,
                    without measuring layout or compressing the font to fit. */}
                <textPath href={`#${arcId}`} startOffset="80%" textAnchor="end">
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
