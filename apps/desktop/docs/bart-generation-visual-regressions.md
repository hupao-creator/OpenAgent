# Generation visual regressions (#262)

The pre-Worker implementation (`0c432ae8`) kept Bart's departure size on arrival,
then used a 260ms segmented morph: inflate, widen, overshoot, settle. Eyes stayed
visible until late in that morph. Typesetting used a small dark Bart with two eyes.

The Worker compiler instead shrank the arriving actor to radius 16 and replaced
the segmented shape with a simple size tween. The Worker also multiplied the
morph's opacity by the resident's disappearing opacity, weakening its silhouette.
During typesetting the resident was hidden and the replacement pose's eyes were
unconditionally disabled. That combination produced the reported black dot.

The compiler now restores the original shape stops and eye/material timing, and
keeps the arrival size. Prepared pose opacity explicitly selects the morph
geometry. The borrowed live character remains visible for flight, typesetting,
relay and return, above the card textures. The Worker no longer infers pose/eye
visibility from the live character opacity. State and all per-frame drawing stay
in the existing Worker; the external API and interruption policy are unchanged.

`bart-worker-runtime.test.tsx` checks expansion, overshoot, equal-time card/caret
cuts, empty cards, relays and exact return. `bart-generation-visuals.electron.mjs`
drives actual Overview creation and inspects native captures: the morph must grow
with visible eyes, and the small typesetting character must contain bright eye
pixels enclosed by its dark body. PNG encoding and pixel analysis run after the
short capture window. The test is part of the serial native Bart suite, alongside
the existing 2s/5s Renderer-blocking and handoff checks. These pixel assertions
establish appearance, not display frame rate.

Local comparison on the same Electron fixture (DPR 2) rejected the unmodified
pre-fix code: the early morph's dark body was only 64 backing pixels wide, and
both captured typesetting bodies had zero enclosed bright eye pixels. With the
fix, the early morph grew from 256 to 368 backing pixels across the two captures,
and both 35-pixel-wide typesetting bodies had 51 enclosed bright eye pixels.
These are diagnostic samples; the acceptance thresholds allow frame timing and
character pose variation rather than requiring an exact screenshot match.

Native fixture windows stay on top across macOS Spaces so other desktop windows
cannot mark them invisible and suspend Worker RAF. A failed local trace showed
`ProxyMain::SetVisible(false)` immediately before the flight's Worker frames
stopped. This is a foreground test precondition, not a change to application
throttling: explicit hide/show resource checks remain enabled. Failure capture
errors also settle the test with a failure exit instead of stranding its process.
Native measurements must also run without another checkout's tests or builds:
separate verification jobs on the same host still share CPU, GPU and window focus.

Cross-page blocking admission follows the existing camera fixture: observe two
native content frames before freezing the Renderer, and reject admission later
than 25% of the flight. The program-ready mark precedes the initial compositor
commit; blocking just 4ms after that mark had captured only the uncommitted start
frame. This guards active animation isolation without treating preparation as
an already presented animation or allowing the flight to finish before blocking.
