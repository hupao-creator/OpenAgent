# Architecture fix renderer verification

Measured 2026-09-08 with the production profiling build, Apple M1 Pro,
macOS 26.5.1, HeadlessChrome 152, React 19.2.8, and a 1280 × 720 viewport.
Each scenario uses 48 threads × 24 native turns, ten warmup updates, and
`await window.rendererBenchmark.run(60)`. No real Agent was started.

| Harness | Scenario | Median update (ms) | P95 update (ms) | Overview projections | React commits |
| --- | --- | ---: | ---: | ---: | ---: |
| Codex | overview | 1.5 | 1.8 | 60 | 192 |
| Codex | background | 0.2 | 0.3 | 0 | 60 |
| Claude | overview | 1.1 | 1.6 | 60 | 191 |
| Claude | background | 0.2 | 0.3 | 0 | 60 |

All four scenarios reached Renderer revision 71, with no browser errors or
warnings. Each background scenario kept the selected 24-turn detail mounted
while another thread streamed. Overview projection counts stayed at one per
changed Agent update; background updates produced none. The scoped subscription
regressions additionally verify that Bart-only streaming performs no Agent
Overview rendering or projection, and that batched A → B → A layout revisions
remain observable.

The user-message toggle, return to the 48-item overview, and opening
a visible card were exercised through browser controls. Detail and overview
screenshots were inspected. One attempt to select an off-viewport canvas card
timed out; selecting a visible card from a fresh snapshot succeeded.

Benchmark TypeScript checking and the Vite build passed. Measurements cover
notification processing and synchronous React work, excluding fixture creation,
transport, cloning, asynchronous Markdown and paint. These are single local
runs, not a statistical before/after comparison: Claude overview P95 was
1.6 ms versus the historical 1.4 ms, so the results do not establish a uniform
latency improvement. The subscription/projection and revision checks establish
the intended behavior directly.

[Raw results and provenance](./architecture-fix-results.json) are stored
separately from the unchanged historical `renderer-results.json`.
