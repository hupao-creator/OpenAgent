# Bart scene boundaries after the fixed-input change

Follow-up to #9. This is a Host module-boundary change, not a new animation
framework or a change to the Worker protocol, trajectories or timing budgets.

## Responsibilities

- `BartCrossPageFlight` adapts React mount/prop changes to a scene and supplies
  synchronous business-state handoff through `flushSync`. It no longer owns
  preparation, leases, textures, observers or compositor tracks.
- `cross-page-scene` owns one navigation flight and its redirects. It retains
  the same surface and Worker resident across reversals and gates landing on
  the latest run identity and the page's readiness.
- `generation-scene` owns one fixed-input batch, bounded geometry retries and
  the prepared reveal/return program. Ordinary streamed updates remain live
  beneath the cover; they do not invalidate the captured content.
- `scene-lifetime` shares cancellation, abortable milestone waits, cleanup and
  synchronous handoff between these two scenes. It owns no FIFO, geometry,
  renderer, timeout policy or definition of obsolete business content.
- `dom-snapshot` owns shared SVG serialization/raster variants. Card asset
  preparation imports it directly, not through the eye-dive scene. Camera
  exports still forward the existing helper names for its other callers.

The eye-dive scene retains its current orchestration and interruption policy;
only its shared raster helpers move in this change. No universal Scene API is
introduced, and navigation invalidation is not copied onto generation.

## Handoff contract

Cancellation stops pending waits, but does not itself uncover the page. A
scene finishes through `handoff(commit)`: enter a non-reentrant handoff phase,
commit the current business DOM synchronously, then detach observers and run
resource releases in the order declared by the scene. A React unmount inside
that commit cannot deliver a second completion callback. Explicit unmount remains
immediate and idempotent: React can mount the next generation batch in that same
commit, so its predecessor must free the shared surface before the new factory
runs. With no explicit unmount, resources release when the host commit returns.

The release list is deliberately explicit. Camera/compositor ownership, DOM
coverage, Worker runs, bitmaps, surface pools and stage leases do not all have
the same lifetime, and the shared helper does not infer their dependencies.
Existing coordinator admission/cancellation semantics are unchanged. Cleanup
attempts every registered release even if one throws, then reports an aggregate
error; late cleanup registrations execute immediately on a disposed lifetime.

`wait` removes cancellation listeners when its milestone settles. A canceled
Worker completion cannot later write generation state; cancellation during
landing can restore current DOM without waiting for a stale acknowledgement.
Underlying asynchronous operations still retain their existing abort/late-asset
checks: a rejected wait alone does not stop the producer.

## Regression scope

The lifetime contract has portable deterministic assertions for handoff order,
reentrant unmount, blocked/already-canceled milestones, errors, late completion,
parent isolation and cleanup. Production React flight regressions cover page
readiness, repeated reversal, stale runs, delayed landing/unmount, scene-cut
sources, the existing admission deadline and parent-driven handoff unmount.
The existing generation preparation/playback and card-input tests remain in
place; the card-input mock now targets the neutral raster module.

DOM/controlled-Worker tests establish lifecycle behavior, not native pixels or
frame cadence. Native Bart isolation and visual acceptance remain separate;
no thresholds or CI gates are relaxed by this refactor.
