# M4 directory preparation pilot

Issue #99; integration owner: Codex task `01a08419-3f94-7d00-b9cd-51b30f151d78`.

> Historical note: the OpenCode directory-preparation subject, its property and
> regression tests (`tests/property/directory.property.test.ts`,
> `tests/opencode-directory-preparation.test.ts`) and its benchmark script
> (`scripts/benchmarks/directory-preparation.mjs`) were removed with the OpenCode
> Harness. This commit-pinned M4 record is retained as evidence; the commands
> below no longer reproduce against the current tree.

## Measurement protocol (fixed before the candidate)

Baseline: `1cde0b1d`; extend behavior tests first and run them against the Promise implementation before editing it. Pilot Effect **3.22.1**, exact lockfile; no platform or test adapter packages are needed. Use the matching [v3 runtime](https://effect.website/docs/v3/runtime), [scope](https://effect.website/docs/v3/resource-management/scope) and installed declarations/source. Public prepare/invalidate and native process ownership remain unchanged.

Measure three fresh processes per variant on this Mac, same Node, lockfile and workload, after package generation. Record each raw value and compare medians. Microbenchmark: import/startup time, 1000 unique-directory preparations, 1000 ready-cache hits, 1000 two-waiter preparations with one cancelled caller; record RSS/heap after GC. This measures adapter overhead with immediate fixture I/O, not CLI/model/network latency. Measure the same directory integration/property suites with fixed seed 99 and one Vitest worker. Build the actual Desktop Main bundle for each variant and compare raw bytes. Count manual ownership fields, explicit timers/listeners and source lines; lines alone do not establish benefit.

Predeclared allowable median deltas: import/startup +50 ms; each request scenario +0.5 ms/operation; retained RSS +15 MiB and heap +5 MiB; Main +250 KiB; focused tests +1 s. Require unchanged public behavior and a concrete reduction in manual cancellation/deadline management. Exceeding any budget, an unreliable cancellation replay, or merely wrapping the existing orchestration means pause or narrow adoption, preserve properties, and leave M5–M8 unstarted pending another decision. These are pilot decision thresholds, not CI timing assertions.

External deferred gates control native response completion; fast-check generates bounded caller counts and event choices, with no fast-check scheduler. Vitest fake timers drive existing public native/provider deadline integration tests. No Effect TestClock drives those same timers; if testing an isolated Effect-only sleep, use TestClock without Vitest fake timers. Microtasks execute normally. None of this claims control over OS process or network scheduling.

## Results and adoption decision

**Pause production adoption**. Production source and dependency lockfile remain the Promise baseline. [Raw measurements](effect-directory-evidence.json) and the [corrected trial patch](effect-directory-candidate.patch) are retained; the patch is evidence, not built code.

Measured on Apple M1 Pro / arm64, macOS 26.5.1, Node 22.22.2, pnpm 10.17.1, Vitest 4.1.10. Baseline behavior commit `147b028a` (production is still `1cde0b1d`); thresholds were committed in `744f41a0` first. Both variants passed 12 tests before measurement. Three process runs per latency/memory/test variant; Main was built once per variant (deterministic bytes, not build-time measurement). Medians:

| Metric | Promise | Effect | Delta / gate |
| --- | ---: | ---: | --- |
| Module import/startup | 69.38 ms | 130.19 ms | +60.82 ms; exceeds +50 ms |
| Unique-directory request | 0.02056 ms | 0.12818 ms | +0.10762 ms; within +0.5 ms |
| Ready-cache request | 0.00030 ms | 0.00395 ms | +0.00365 ms; within +0.5 ms |
| Shared request / one cancelled caller | 0.02753 ms | 0.10296 ms | +0.07543 ms; within +0.5 ms |
| RSS after cleanup/GC | 74,481,664 B | 142,475,264 B | +64.84 MiB; exceeds +15 MiB |
| Heap used after cleanup/GC | 9,775,424 B | 15,834,680 B | +5.78 MiB; exceeds +5 MiB |
| Actual Main index.js | 1,447,094 B | 1,733,972 B | +280.15 KiB; exceeds +250 KiB |
| Focused Vitest wall | 1.25 s | 1.24 s | −0.01 s; within +1 s |
| Focused test execution | 392 ms | 372 ms | −20 ms (noise, not a speedup claim) |

The runtime import is a proxy for adapter startup, not full Electron window readiness. Memory is process-level retained usage after explicit GC, not peak/native-memory attribution or a leak proof. Local three-run timing variance is visible in JSON; no statistical significance claim. Fixture request times intentionally exclude native startup, filesystem hooks and network/model latency. Native transport/deadline behavior remains covered separately by loopback integration tests and the unchanged full verifier. No upstream promotional benchmarks are used.

Manual state comparison: both retain `ready`, `pending`, waiter count and entry-identity checks. Promise pending has controller + promise; Effect has Fiber + invalidation reason. Module source grows 83→96 lines. Effect removes the explicit deadline timer/controller and two uses of the abort-race helper; `acquireUseRelease` owns decrement/interruption. The existing helper also remains needed elsewhere. This is a real but limited local resource benefit, insufficient to offset measured cost.

## Error and cancellation evaluation

The trial converts Promise input only in `tryPromise(initialize)` and output only in public `prepare` (`runPromiseExit`); synchronous `invalidate` is the external interruption seam. Internal sharing uses Fiber and Effect composition, not repeated Promise conversions. `tryPromise` receives Effect's native AbortSignal, which reaches the existing HTTP/marker initialization callback. Deadline expiry interrupts that signal; the independent provider deadline still starts afterward. No runtime object is returned through IPC or persistence, and Fiber does not define an Execution outcome.

| Internal outcome | Trial boundary / diagnostics | Retained production behavior |
| --- | --- | --- |
| Initializer rejection or synchronous throw | `catch: error => error`, then `Cause.squash` returns the original error for a single failure; its Error.cause remains attached. Existing preparation span sees that error. | Original rejection/throw is propagated; same debug span. |
| Deadline | Existing 90s Error text via `timeoutFail`, span status `timeout`; abort reaches underlying I/O. | Deadline AbortController and same Error text/status. |
| Caller cancellation | Public seam throws the caller's signal reason; only last waiter interrupts shared work. | Same caller reason, last-waiter controller cancellation. |
| invalidate / process exit / dispose | Pending reason preserves supplied Error for waiters; shared interruption is diagnosed as cancelled. | Supplied Error propagates and is the span failure reason. |
| Defect or cleanup/diagnostic failure | A single defect is squashed; compound failures are not fully retained by this minimal trial. Invalidation span uses Fiber interruption identity rather than the owner's original error. **This remains an adoption limitation, not a claim of complete diagnostic equivalence.** | Existing behavior remains; the pilot does not introduce new finalizers or change failure mapping. |

The candidate is not approved for production merely because behavioral tests pass. Any renewed adoption must explicitly preserve the original and cleanup causes together as ordinary boundary diagnostics, with the owning context identity; this trial's diagnostic limitation reinforces the pause. Existing `harnessId`, cwd and `opencode.directory.prepare` span context are used; there is no second tracing system.

## Properties, replay and resource isolation

Public seam: `OpenCodeDirectoryPreparation.prepare/invalidate`; native generation and deadline integration uses `OpenCodeNativeServer.prepareDirectory`, catalog reads and its current owner exit/dispose path. Input domain: 2–8 callers, 0–7 cancellation selector, abandon/invalidate/stale-first booleans (448 bounded tuples before duplicate-equivalence reduction). The oracle asserts initializer call counts, each caller's outcome/reason identity, native signal abortion, fresh retries and ready-cache reuse. It does not reproduce the pending-map algorithm or inspect private owner state.

Event order: join callers → cancel prefix/all → optional invalidate → optional stale response → retry → old response → join retry → fresh response → cached read → cleanup. Invalidating an already-ready generation is included when the first phase succeeds. Each sample owns a fresh preparation instance, signals and gates; `finally` invalidates, resolves every external gate, observes all caller outcomes and drains microtasks. Existing integration tests assert zero timers after timeout/dispose and actual socket closure. They do not simulate all OS scheduling or real package-install latency.

Default async family: 30 samples / 10-second fast-check interruption budget (ordinary Vitest also applies its existing timeout); exploration defaults to 1000 and a 120-second property interruption budget through the existing runner. The bounded samples complete rapidly; the default suite remains below its 120-second process budget. No scheduler or TestClock is installed/used; `replayPath` is null. The failure reporter prints actual event order and versions. Both trial and retained Promise passed 1000 samples at seed 99.

```sh
pnpm test:properties -- -t 'directory waiter ownership and generation fencing'
pnpm test:properties:explore -- -t 'directory waiter ownership and generation fencing'
FC_RUNS=30 FC_SEED=99 FC_PATH='1:0:0:1' pnpm test:properties:replay -- -t 'directory waiter ownership and generation fencing'
```

The initial trial forked the shared operation inside uninterruptible acquisition without restoring interruptibility. The property failed at seed 99, path `1:0:0:1`, 30-run budget, 3 shrinks: `{callers:2,cancel:0,abandon:false,invalidate:true,staleFirst:false}`. The native signal stayed un-aborted. Exact replay reproduced that same counterexample; adding `Effect.interruptible` around the shared operation fixed it, and healthy replay passed. Existing deterministic dispose/last-waiter tests also detected that trial defect and remain regression coverage. No defective production implementation is shipped.

To reproduce the corrected trial in a separate local checkout of this delivery:

```sh
git apply apps/desktop/docs/effect-directory-candidate.patch
pnpm install --frozen-lockfile
pnpm build:packages
FC_SEED=99 pnpm --dir apps/desktop exec vitest run tests/opencode-directory-preparation.test.ts tests/property/directory.property.test.ts --maxWorkers=1
node --expose-gc scripts/benchmarks/directory-preparation.mjs
pnpm build
wc -c apps/desktop/out/main/index.js
```

Repeat benchmark and focused tests three times in fresh processes. To reproduce the fault, replace `Effect.forkDaemon(Effect.interruptible(self.run(cwd)))` with `Effect.forkDaemon(self.run(cwd))` in that experimental checkout, then run the replay command above. Restore the single fault before further use. The patch locks Effect 3.22.1 and its transitive dependencies; project properties use fast-check 4.9.0, distinct from Effect's transitive fast-check version. No `@effect/platform` or `@effect/vitest` is required. Preserve the exact patch, lockfile and generator when replaying.

M5a–M5c / M6 / M7 / M8 remain paused and incomplete. M2/M3 are independent property work. M9 must record the narrower accepted scope; this PR does not close parent #92 or mark its broad Effect goal achieved.
