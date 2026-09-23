# Multi-thread latency regression

Measured on 2026-09-23 using an Apple M1 Pro, macOS 26.5.1, Chrome 153,
1280 × 800 viewport and the production React profiling build. Baseline:
`dc5c0530`; comparison: this change with the same benchmark files copied into
both checkouts. No live agents or user profiles were used.

## Evidence from the internal test

The retained September 22 evening logs contain 330,456 observation completions.
Of 319,964 retained observation inputs, 296,481 were Pi; the peak was 612 inputs
in one second. 310,033 inputs repeated the previous public observation for that
Thread, although private message state could have changed. The log writer also
reported 20,691 dropped events. Retention means these are incomplete totals.

Each Pi cumulative delta previously committed a full session before renderer
IPC batching. That repeated cloning, validation and persistence preparation on
the main process even while a detail page was open. Unrelated Thread mutations
also reparsed Bart's unchanged private history in every renderer view. The
observation span excludes some upstream work and is not a renderer frame metric.

## Repeatable browser comparison

Build with `pnpm --dir apps/desktop perf:renderer:build`, serve with
`pnpm --dir apps/desktop exec vite preview --config benchmarks/vite.renderer-bench.config.ts`,
and open `/renderer.html?harness=pi&mode=overview&threads=48&turns=24&streams=8&bartSession`.
Run `await window.rendererBenchmark.run(60)` three times. Each run includes ten
warmup updates. Use `mode=background` for eight other Threads updating while the
selected Thread stays unchanged, or `mode=detail` to include the selected Thread.

Every update rewrites eight latest messages, stressing simultaneous excerpt
reveal boundaries. This is intentionally different from ordinary token appends.
All 48 Threads and Bart contain 24 executions of synthetic native history.

The table reports the median of three run-level metrics in milliseconds:

| View | Sync update median before → after | Sync update P95 before → after | Frame interval median before → after | Frame interval P95 before → after |
| --- | ---: | ---: | ---: | ---: |
| Overview | 19.3 → 8.1 | 32.6 → 12.3 | 25.4 → 17.6 | 43.4 → 33.9 |
| Detail, other Threads updating | 0.5 → 0.4 | 1.9 → 1.5 | 8.3 → 8.3 | 9.9 → 9.9 |
| Detail, selected Thread updating | 1.2 → 1.1 | 1.8 → 1.6 | 8.3 → 8.3 | 10.3 → 10.0 |

Unrelated Bart projections fell from 60 to 0 per run in all three views.
Overview projection counts stayed at 480 (one per changed Thread per update),
and detail produced no Overview projections. The measured Overview runs had
4/180 frame intervals over 50 ms before and 0/180 after.

`updateMs` measures synchronous renderer notification and React work. It excludes
fixture creation, transport, microtasks, asynchronous Markdown and paint. Frame
intervals include work between animation frames, including deferred reveal work
and fixture creation; they are not input-to-paint latency. These local synthetic
runs demonstrate reduced renderer work, not a replay of the full internal test.
Browser font loading uses fallback fonts because the Electron-only
`openagent-font:` protocol is unavailable in both browser builds.

## Correctness and interaction checks

- Pi's native-event regression feeds 501 cumulative updates inside one fixed
  50 ms window and observes one full session commit, preserving text, reasoning
  and ordered reasoning → text → reasoning activity. Message/tool boundaries,
  reads, interruption and disposal flush pending state without late commits.
- Actual-store tests verify that 100 unrelated Thread patches do not project
  Bart history; activity-only deliveries and authoritative recovery still work.
- Eight simultaneous excerpt reveals share one animation checkpoint. Ordinary
  same-batch appends perform no excerpt DOM measurement or copying.
- Delayed-worker integration verifies FIFO planning against the preceding
  presented layout, scene cancellation and stale-result rejection. The existing
  solver and its logical search budget are unchanged.
- The real bundled Worker also planned a 48-card 2×1 layout with one card growing
  to 2×2: 2,000,000 search steps took 113.9 ms while the UI delivered 14 animation
  frames. All 48 placements were returned with the enlarged footprint.
- Filter regression preserves live survivors and clones only exiting cards;
  interrupted, empty, reduced-motion and hidden-view behavior remains covered.
- With `rendererBenchmark.startStreaming()` delivering eight updates every
  50 ms, real mouse dragging moved the Overview plane by the exact gesture
  delta (160, 50). Selecting a tag changed 48 cards to 12, with no hidden live
  survivors or retained exit tree after animation. Detail navigation, user-message
  visibility and loading earlier turns were exercised while updates continued.

Queued structural layout revisions now run in a dedicated Worker. Initial
mount and filter-scene planning still use the synchronous solver; pathological
mixed-footprint cold layouts remain a separate limitation. Moving those calls
requires coordinating scene readiness with the existing filter animation.

[Recorded runs](./multi-thread-results.json) retain the individual measurements.
