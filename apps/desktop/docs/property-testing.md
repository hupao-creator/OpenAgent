# Pure-data property testing (Issue #92 M1)

Current cross-family budgets, configurable command exploration, extension guidance and
parent acceptance: [M9 governance](property-governance.md).

fast-check 4.9.0 is a Desktop development dependency. Production algorithms and runtime dependencies are unchanged. This page describes M1. [M3a storage properties](storage-property-testing.md) add scoped durability, version fencing and recovery with their own native-I/O budgets. [M3b attachment ownership properties](attachment-properties.md) add two async properties; [M4 directory ownership properties and the measured pause decision](effect-directory-pilot.md) add another async family. [M2 lifecycle and native Harness properties](lifecycle-property-testing.md) extend the same runner. They reuse these commands. Other milestones remain separate work.

## Commands and budgets

Run from the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm test:properties
pnpm test:properties:explore
FC_RUNS=2000 FC_SEED=92 pnpm test:properties:explore
FC_RUNS=100 FC_SEED=92 FC_PATH='0:0:0:0:0:0' pnpm test:properties:replay -- -t 'markdown prefixes'
```

The last command replays the recorded Markdown fault example; it passes on healthy code. To reproduce the demonstrated failure, first apply its temporary fault below, then restore that exact edit. A failure prints the complete replay command, counterexample, seed, path, original sample budget, shrink count, fast-check/Node versions and event order. Preserve the tested Git SHA and lockfile with the log. `replayPath` is null: M1 uses no model commands or fast-check scheduler. Use exactly one of these unique selectors: `markdown prefixes`, `renderer patches round-trip`, `renderer gap recovery`, `layout is deterministic`. A path is meaningful only with the same property, generator, dependency versions, seed and sample budget. Replay sets `endOnFailure` to avoid further shrinking. See [fast-check parameters](https://fast-check.dev/docs/api/interfaces/Parameters/).

The existing `pnpm test`/verifier discovers `tests/property/*.test.ts`; no separate opt-in is needed. `tsconfig.tests.json` explicitly includes the new `.ts` helpers/tests. The dedicated commands rebuild packages and registries before Vitest. Default: 100 samples for each of three pure properties and 30 for the fixed gap-recovery scenario. Documents contain 1–6 fragments, at most 8 text tokens per fragment and a cyclic list of 1–16 append sizes in 1–32 UTF-16 code units. Renderer aggregates have at most six unique Thread/report IDs and three states. Layouts have at most 12 obstacles. There are no unbounded operation sequences.

Each property has a 10-second fast-check interruption budget with `markInterruptAsFailure`; all four give a 40-second aggregate property budget. The dedicated default Vitest process also has a 120-second wall deadline (registry generation separately has 120 seconds). The bounded predicate may finish before interruption is observed; this is a budget guard, not hard real-time scheduling. Exploration defaults to 1000 samples per property, 120 seconds per property and a 900-second process deadline. `FC_RUNS` accepts 1–100000. No seed is fixed by default, so ordinary runs continue exploring. Fixed seeds are for reproductions and measured comparisons. No automation is created.

## Contracts, input domains and limits

| Family | Public seam and assertion | Limits / resources |
| --- | --- | --- |
| Markdown | `IncrementalMarkdownProcessor.render` / `snapshotMdast`: each generated append prefix equals a fresh full parse after removing only source positions. Structured paragraphs/setext headings, quotes/lists, tables, fences, references inside containers, escaped punctuation, CJK and surrogate pairs are combined. | Parser semantics, not DOM patch application or pixel output. Each sample creates fresh processors; retained state ends with the sample. Existing large-table, reference and concrete boundary regressions remain. |
| Renderer | `renderer-state-contracts.ts`, `createRendererStateMutation`, `applyRendererStatePatch`, `mergeRendererStateMutations`: A→B and B→C round-trip; combined/sequential results equal C; stale overall/entity revisions cannot regress state. | Generated entity revisions advance with commits, including reinsertion; payloads remain opaque. Membership/order/title/archive/cwd/selection/settings change. Public execution arrays stay empty; full lifecycle belongs to M2. |
| Renderer effects / recovery | Previous effect or discontinuous base rejects merge; successor effect remains one cue. `synchronizeRendererState` sees A, then a B→C gap and hydrates C, discarding the subsumed effect. | Fixed event order: subscribe → load/hydrate A → gap → load/hydrate C → discard stale cue → unsubscribe. Real microtasks only; no timer, scheduler or native I/O. Each sample owns a fresh store/subscription, released in `finally`. |
| Bart Dock | `DockPlacementInput` / `resolveDockPlacement`: deterministic output without input mutation; finite coordinates in legal top-left bounds; independent separating-axis assertions check every obstacle plus clearance when non-fallback. | Finite half-pixel coordinates −200..600, positive sizes 0.5..300, clearance 0..30. Fallback need not be collision-free and does not prove no continuous solution exists. Bounds constrain the outer top-left, not the body's far edge. Existing tangency, blocked-home and tie-break examples remain. |

These properties do not replace native Electron, CLI, SQLite, visual or performance acceptance. No Effect object, new lifecycle owner or host capability crosses a boundary.

## Detection, shrinking and replay evidence

[Recorded evidence](property-testing-evidence.json) contains exact paths, minimized inputs, dependency/runtime versions and six timing runs. For each family, one temporary production fault was applied, a seeded 100-sample property run failed, fast-check shrank it, and the reported path reproduced the identical counterexample with shrinking disabled. All faults were restored before final verification. These are mutation demonstrations, not newly discovered production defects.

| Family | Temporary fault | Observed minimized failure |
| --- | --- | --- |
| Markdown | At entry to `parseAppend`, return `{ tree: cache.mdast, parsedChars: 0 }`. | Empty cached parse remains stale while `heading` arrives one character at a time; 5 shrinks. |
| Renderer | In `applyCollection`, replace the upsert assignment with `if (!previous) byId.set(record.id, record)`. | A repeated entity ID keeps its previous revision instead of accepting the next commit. |
| Layout | In `dockBodyIsFree`, return true immediately before computing the body rectangle (after bounds checks). | 0.5×0.5 body and obstacle overlap at origin; 130 shrinks. |

Use the exact family selector and `seed`, `path`, `numRuns` from the JSON after applying the corresponding fault. Save `git diff` and both failure outputs, restore only the temporary edit, then rerun the healthy suite. Never commit the faulty production code. A dropped `removedIds` loop alone was also tried and did not fail: generated membership patches carry an authoritative `order`, so that mutation did not change their observable output. It is not counted as detection evidence.

## Added validation cost

Measured on 2026-09-09, Apple M1 Pro arm64, macOS 26.5.1, Node 22.22.2, pnpm 10.17.1, Vitest 4.1.10. Production code is identical in baseline/candidate. After package generation, run the four existing adjacent suites with `--maxWorkers=1`, then the same command plus `tests/property`; repeat in that order for seeds 92, 93, 94. Exact commands are in the JSON. Baseline wall times: 2.155 / 2.157 / 2.459 s; candidate: 3.436 / 3.429 / 3.327 s. Median added wall time: 1.272 s. This includes Vitest startup/import overhead, excludes package rebuild/install, and is not a whole-verifier benchmark. Dedicated 1000-sample exploration at seed 92 passed all four properties in 6.47 s Vitest wall / 5.80 s test time. The default budget leaves room for slower machines while failing instead of silently skipping exploration.

Future properties should name their current contract, generate legal inputs by construction, use independent observable assertions, scope all resources per sample, demonstrate one meaningful fault and retain the exact replay parameters. Change the budget with a recorded baseline/candidate measurement. M4 separately measured Effect costs and [paused adoption](effect-directory-pilot.md).
