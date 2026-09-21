# Bart flight / Overview regression follow-up (#257)

## Cold settings GPU stall follow-up (#96)

The recording after #89 still showed a mid-flight catch-up jump. That fix's
handoff checks measured DOM geometry and did not establish smooth native travel.
In a fresh Electron profile, the settings root's full-window `blur(24px)
saturate(1.15)` backdrop filter stalled GPU submissions during its expanding
clip. Both settings panels are opaque, so this filter only affected the fade.
Removing it retains the circular clip, static tint cross-fade, content opacity
tracks and Bart choreography; the underlying Overview is no longer blurred
during the brief translucent portion of the reveal.

Initial paired local native capture (1180×780, DPR 2, light theme, one Overview thread):
the original CSS produced a 117.4ms renderer frame interval and a 123.8ms
`IOSurfaceImageBacking::WaitForCommandsToBeScheduled::Dawn` wait. Disabling only
the backdrop filter reduced those maxima to 9.4ms and 5.7ms. Captured Bart pixels
fell progressively behind the authored route and then caught up with the old
filter. A run without native capture also had a cold-only 33.2ms frame gap;
capture amplifies GPU pressure and its callback times are not presentation times.
These initial diagnostic traces retained full bitmaps; the final check below
uses bounded masks to avoid accumulating their memory pressure.

`bart-settings-cold.electron.mjs` measures the real Overview → settings page,
with a disposable profile on every invocation and three opens per process. It
reads the authored route once and retains a byte mask of every fourth pixel,
bounded to 256 samples (59MB maximum at DPR 2; about 10.6MB observed per round).
Full native bitmaps are transient. It locates the connected Bart silhouette
and optionally encodes mask PNGs **after** capture. During the moving portion, pixel position gives
the route's elapsed time. The spread of callback time minus route time detects
accumulated lag and catch-up while ignoring constant delivery latency. Near the
eased endpoint, pixel quantization cannot resolve time; native roster movement
after landing belongs to a separate clock and is excluded. A flight skipped by
admission, fewer than eight moving samples, or a lag spread of 60ms fails.

```sh
pnpm --dir apps/desktop perf:renderer:build
node apps/desktop/tests/bart-settings-cold.electron.mjs
```

Run alone on a desktop fitting 1180×780. `BART_COLD_OUTPUT` selects an evidence
directory, `BART_COLD_SAVE_FRAMES=1` retains sampled silhouette PNGs, and `BART_BENCH_ROOT` selects a
previous benchmark build for paired comparisons. This is a manual performance
check, outside the small hosted CI display. It cannot prove physical scanout or
smoothness on every GPU. Existing 1x/2x settings compositor checks still cover
the reveal, and #88's checks cover the roster handoff independently.

The old build fails the bounded-mask check with a 90.4ms lag spread. Six complete
fresh-profile runs of the fix pass all 18 opens; first-open spreads are 6.0, 9.5,
7.4, 4.9, 9.1 and 30.5ms, retaining about 10.6MB per round. The initial diagnostic
that retained full bitmaps measured 123.5ms on the old build; one of its fixed
runs had insufficient samples and was counted as failed. Those heavier captures
are not substituted for the final mask-based measurements.

## First settings landing follow-up (#88)

The first installation probe narrows the provisional coordinator roster while
the cross-page flight holds its geometry. At handoff, the synchronous React
commit applies that roster and its layout effects measure the new seat. The
scene still had `transition: none !important` installed until *after* this
commit, so the first read committed the new position without a transition.
Later opens already had the narrowed roster and did not jump.

The scene now restores native transitions immediately before that commit,
retaining its covering canvas, pinned transforms and interaction ownership until
normal release. The existing 720ms seat transition can then carry the newly
discovered roster from the exact landing position. A separate cold preparation
cost came from converting the 48px engine icon's GPU canvas to an ImageBitmap;
that one-shot raster now uses a software context to avoid synchronous GPU readback.

Local Electron 44.4.3 evidence (1180×780, DPR 2, 24 overview threads): the original
first handoff moved the character center from x=441.50 to x=695.50 in one frame
(254.00px). With the fix, both sides of handoff were x=441.50 and the native seat
subsequently travelled through intermediate positions. Warm opens retained
x=695.50. Bitmap conversion in the paired runs dropped from 7.6–21.4ms to
0.1–1.9ms. These measurements establish continuity and preparation cost, not a
claim of zero dropped display frames.

`settings-transition.electron.mjs` now samples the **first** opening before any
settings warmup or slowed reveal at both 1x and 2x. It checks handoff continuity
and intermediate native positions, saving `cold-landings.json`. Optional flight
admission failures are explicitly reported as `admission-fallback`, never as
smooth-flight evidence. The React scene regression deterministically checks that
native transitions resume before the host's synchronous measurement, while the
cover and interaction locks remain held.

## What failed

- Settings opened while cross-page flight waited up to 10 seconds for installation detection. The destination was visible during this wait, then a late flight replayed the journey.
- The Overview camera bound its DOM plane only in the component's initial layout effect. An initially empty Overview has no plane; adding its first card or changing the keyed filter creates a new plane without rerunning that effect. Automatic framing therefore never reached that DOM node, and generation failed at `playPrepared` with no camera surface.
- The first short flight can lose high-refresh frames in GPU work even when Worker JavaScript is fast. Existing acceptance began after readiness and measured the compositor cadence of a larger diagnostic scene; it did not cover action-to-departure timing or a cold Settings flight.

## Changes

Flight reserves presentation before async preparation and uses the coordinator roster already on screen. Background detection continues; its geometry changes apply after landing. A shared 250ms deadline covers residents, resources, stage admission and the first frame. Expired work restores current DOM and cannot replay on a late stage grant.

The existing Worker raster scene backend now handles both cross-page flight and eye-dive camera transitions. Flight keeps a fixed 512px character raster and composites it through Canvas2D, avoiding the per-frame Canvas2D-to-WebGL texture upload. A 256 CSS-pixel actor canvas (512 backing pixels at DPR 2) holds that raster; Chromium animates its transform on the compositor using the same immutable route and Worker start epoch. This replaces a 1180×780 DPR-2 viewport redraw with a 512×512 actor redraw. The Worker owns character state and landing, while travel needs no per-frame Host callback. Fixed raster scale avoids new blur work as flight size changes. Cold raster work completes before the flight clock starts. These preparation readbacks are finite; playback has no readback or Host frame relay. The two shared scene surfaces retain their existing lifetime and memory bounds.

A React ref callback binds the Overview camera to each actual plane, including initial card arrival, filter replacement and StrictMode replay.

## Evidence and limits

`bart-regressions.electron.mjs`, included in `test:bart-isolation`, drives the real Settings page and the real Overview/layout/generation components. It covers 3.6s detection, detection finishing mid-flight, reopening, admission expiry with a late stage grant, first card arrival, filter replacement and subsequent generation. DOM tests separately reproduce the missing camera binding and frozen roster. Existing 2s/5s main-thread blocking cases continue to verify native pixel movement and handoff.

Local diagnostic evidence: `bart-regressions-TVLYMZ` on Electron 43.3.0, a 1180×780 CSS-pixel native window, DPR 2, display frequency 120.0006Hz. Six flights had Worker median intervals around 8.33ms. The first flight's Worker maximum was 25.33ms, P95 12.34ms; later flights had maxima of 10.18–13.19ms. Native Core Animation commits are recorded separately (first flight maximum 33.07ms). The preceding Canvas2D-to-WebGL comparison (`bart-regressions-JLXub0`, with the timing fix already applied) had a first-flight maximum of 48.92ms and a native commit maximum of 53.81ms.

This demonstrates a reduction in the measured stalls and no fixed 60Hz cap. It is not evidence of zero dropped frames: first display still has GPU/compositor costs. Native screenshots establish visible state, not frame rate. Worker trace events measure frame execution; Core Animation commit events measure OS submission, not physical scanout. The cadence guard detects sustained loss and long stalls rather than claiming every frame completes within 8.33ms. Graceful reversal and a public Motion API remain outside this fix.

Further verification exposed variable GPU submission waits even with fast Worker execution, including a single 83ms Dawn wait. Converting all Canvas2D drawing to software did not improve the result and was rejected. Localizing flight to a compositor actor passed six flights and three real Overview creations (`bart-regressions-ZlA4RD`); its first Worker maximum was 41.05ms, with P95 10.04ms. These runs are separate observations, not a claim that every cold frame improves. A concurrently running development window was minimized for isolated measurements; the operating system and other applications still share the GPU. Because travel now runs on the compositor, Worker callback P95 is diagnostic rather than a travel smoothness assertion. The flight gate retains at least 88% of display cadence for both producers and native commits, and enforces a native submission hold below 50ms. Main-thread-blocked pixel movement is checked separately; the existing large-scene compositor P99 gate still uses two refresh periods. Its comparison now respects the trace’s integer-microsecond precision: subtract timestamps before conversion and round the theoretical budget to that same precision, so 16,667µs is not rejected against a 120.0006Hz clock by less than one microsecond.
