# Renderer performance

The renderer now preserves immutable thread references across full IPC snapshots,
shares native overview projections, and skips unchanged cards and historical turns.
This targets renderer CPU and React commits during streaming, background updates,
and typing without dropping committed state transitions.

## Run the benchmark

```sh
pnpm --dir apps/desktop perf:renderer:build
pnpm --dir apps/desktop perf:renderer:serve
```

Open `http://localhost:4177/renderer.html?mode=overview&harness=codex&threads=48&turns=24`.
Run `await window.rendererBenchmark.run(60)` in browser devtools. Modes are
`overview`, `detail` (the selected thread streams), and `background` (another
thread streams while the selected detail stays open). Harness IDs are `codex`,
`claude`. Use `threads=1&turns=160&mode=detail` for long history.

The benchmark mounts the production App and plugin renderers with synthetic,
structured-cloned IPC snapshots. It never starts agents or accesses user data.
It uses React's production profiling build and ten warmup updates before sixty
measured updates. The fixed fixture timestamps deliberately stay unchanged while
content advances, so history reuse cannot rely on timestamps alone.

The median and p95 below measure renderer notification processing plus synchronous
React render/commit. Fixture creation, Main/IPC transport and cloning, asynchronous
Markdown work, and painting are outside this measurement. React totals include
commits occurring during the sampled streaming interval. These are controlled
local workloads, not end-to-end agent latency or frame-rate measurements.

## Results

Measured on 2026-09-07: Apple M1 Pro, macOS 26.5.1, HeadlessChrome 152,
1280×720 viewport, React 19.2.8. Baseline application source: `857a5c8e`.
Optimized application source: `a8c7e1cd` (including Bart revision fixes, #22, and #23).
Both builds use the same benchmark fixtures and profiling setup.
Raw measurements are in [renderer-results.json](./renderer-results.json).

48 threads × 24 native turns; milliseconds per update:

| Harness | Scenario | Baseline median | Optimized median | Baseline p95 | Optimized p95 |
| --- | --- | ---: | ---: | ---: | ---: |
| codex | overview | 173.0 | 1.7 | 179.3 | 1.9 |
| codex | detail | 35.5 | 1.6 | 36.2 | 1.8 |
| codex | background | 35.7 | 0.4 | 40.2 | 0.5 |
| claude | overview | 45.7 | 1.2 | 47.9 | 1.4 |
| claude | detail | 10.0 | 1.2 | 12.2 | 1.4 |
| claude | background | 10.0 | 0.4 | 13.0 | 0.5 |

Overview median update cost falls by 97.4–99.0%. Across sixty overview updates,
public overview-binding calls fall from 11,520 to 60; detail/background scenarios
fall from 2,880 to zero. The original card rendering also recomputed private
projections, outside that counter; the new binding shares that work as well.

One thread × 160 native turns (the existing history window mounts 120 turns):

| Harness | Baseline median | Optimized median | Baseline p95 | Optimized p95 |
| --- | ---: | ---: | ---: | ---: |
| codex | 15.4 | 5.8 | 20.2 | 6.1 |
| claude | 9.0 | 3.1 | 11.7 | 3.4 |

An idle SVG probe observed the same four Bart silhouette paths for two seconds:
240 `d` attribute writes before, zero after. Eye and float animation remain active.

## Implementation

- Connect App to the existing normalized Zustand store. Unchanged thread revisions,
  settings, executions, reports, and unchanged ordered thread collections keep
  their references. The old unused aggregate mutation helper is removed.
- Advance Bart Thread revisions for transcript append, execution finish, tool
  completion, and stale-runtime settlement. Final review found these mutations
  previously bypassed the revision contract. Settings recycling now resolves
  again on a same-identity revision conflict with queued terminal settlement.
- Cache native projections and their public envelopes by immutable thread object
  and discrete column count. Private views stay in their plugin binding. Weak
  keys let obsolete revisions and histories be collected.
- Keep card geometry props and host actions stable; memoize overview cards,
  thread hosts, the overview, and Bart surfaces. Follow-up callbacks read the
  current authoritative snapshot when invoked.
- Project generation targets only while their animation work exists and the
  overview is visible. Every accepted mutation still captures layout revisions,
  preserving queued A → B → A choreography and fresh interaction state.
- Reconcile decoded native snapshots by actual fields and share unchanged
  subtrees. Historical turns and empty interaction maps remain stable. Allocate
  output objects only for changed branches; preserve deletions and actual text
  changes even when timestamps match.
- Reuse settled Bart silhouette paths and avoid animating fully invisible orbit
  geometry. Springs settle below the SVG path's existing two-decimal precision.

## Verification

- On combined source `a8c7e1cd`, `pnpm typecheck` passed, including the thread playground.
- After integrating #23, ten affected interaction/state/service suites passed (219 existing cases).
- [Desktop verification CI](https://github.com/xinyuan0801/OpenAgent/actions/runs/34133077728)
  passed on `837b0aea`, including development source/asset updates and real Electron regressions.
- `pnpm test` passed: 87 desktop test files / 999 cases plus 2 development-script cases.
- `pnpm build` passed for Main, preload, and renderer.
- `pnpm --dir apps/desktop perf:renderer:build` passed, including the benchmark's TypeScript check.
- After reducing snapshot allocations, the six affected renderer suites passed (49 existing cases).
- After fixing the Bart revision paths, seven affected state/service/renderer
  suites passed (167 existing cases). Existing revision assertions were strengthened.
- Generated registry matches the committed files; `git diff --check` passed.
- Browser checks: load 120 → 160 historical turns, toggle user/work rows, submit
  a Claude approval, and observe it return to running.
- A browser probe mounted the real App and applied all four Bart transcript
  mutation kinds through the real reducer and cloned renderer snapshots. Nine
  consecutive revisions stayed current in the renderer store; the Dock moved
  through running/completed/failed and message status through streaming/complete/cancelled.
- No test cases were added. Two existing fixtures were corrected to publish fresh
  objects / advance thread revisions, matching the production immutable contract.

Full IPC snapshots and native schema validation still scale with serialized
history size. This change keeps those contracts intact; the measurements above
isolate the renderer work addressed by this PR.
