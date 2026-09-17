# Attachment ownership properties (Issue #98 / M3b)

Current cross-family budgets, configurable command exploration, extension guidance and
parent acceptance: [M9 governance](property-governance.md).

These properties protect the existing Core-owned [AttachmentRepository](../src/main/services/attachment-repository.ts) contract. They reuse [M1's runner](property-testing.md) and fast-check 4.9.0 without changing production code, dependencies or adopting Effect. Integration owner: Codex task `01a08419-3f80-72b2-b484-b7e70da723c8`.

## Reference model and observable results

[The suite](../tests/property/attachments.property.test.ts) records each staged attachment's owner **set**, bytes, presence and age. It never reads the production Thread-to-attachment ownership index to derive expectations. After every event, it checks expected file bytes, directory removal and metadata presence/removal. A final forced-expiry GC probe reloads the index from disk and ensures every remaining owner is respected. Releasing all owners then proves expired orphans really are collectible.

| Generated event | Public seam / meaning |
| --- | --- |
| stage | `stage` creates bytes-backed files with no owner. |
| retain / send | `retainInput` accepts a canonical file and accumulates ownership before native I/O; repeated sends retain the union. Both labels intentionally exercise the same repository seam. |
| fork | `inheritOwners` adds the source's set to the target, preserving existing target ownership. Includes empty sources and self-inheritance. |
| release / delete | `releaseOwner` removes that owner only, including absent/repeated releases. Delete means the caller already made the Thread deletion durable. |
| reset | `retainOwners` reconciles a generated surviving Thread catalog, including an empty catalog. |
| reopen | A fresh repository reads the on-disk index; no operation remains in flight. |
| age / GC | `utimes` sets the directory to 2000 or 2100, well outside the one-second TTL; `collectOrphans(1000)` may remove only old entries with no owner. |

Each sample begins with two small staged files, one old and one young. Generated sequences have 0–30 events, four owner IDs, bytes of length 1–16 and bounded selectors over currently present attachments. Selecting a missing file is a documented no-op. The model uses logical order, so random filesystem UUIDs and temporary paths do not affect replay. The mandatory final probe and full-release probe run after generated events and cannot be shrunk away.

A second property runs the same sequences, retains an additional file, ages surviving files and then removes or corrupts `.owners.json`. Corruptions cover missing index, invalid JSON, unsupported version, wrong owners shape, reserved owner ID, malformed attachment ID and extra top-level keys. A fresh instance must reject both GC and reconciliation; repeated GC must still reject, preserving all surviving files and metadata. Reopening is deliberate: external edits to an already loaded index are not claimed to invalidate the in-memory cache.

These are serial filesystem properties, not a second lifecycle authority. The service's existing `retains shared attachments through Bart reset and Agent fork until all Thread owners are deleted` regression in [openagent-service-harness.test.ts](../tests/openagent-service-harness.test.ts) separately exercises actual send/Bart reset/fork/delete wiring. The model does not simulate native prompt completion, failed writes, overlapping staging/GC, worker crashes, arbitrary corruption, exact TTL boundary races, path/symlink attacks or all OS schedules. Existing concrete validation and native Electron/CLI/SQLite regressions remain required as applicable; no new native runtime behavior is introduced here.

## Budgets, isolation and commands

From the repository root:

```sh
pnpm test:properties -- -t 'attachment'
FC_RUNS=1000 FC_SEED=98 pnpm test:properties:explore -- -t 'attachment'
FC_EXPLORE=1 FC_RUNS=100 FC_SEED=98 FC_PATH='4:1:0:1:1:1:1' pnpm test:properties:replay -- -t 'attachment owner sets'
```

Default: 30 samples per async property, at most 30 generated events plus fixed setup/probes; 10 seconds per property with interruption treated as failure. M3b adds a 20-second aggregate property budget. Exploration uses 1000 samples and 120 seconds per property; `FC_RUNS` accepts 1–100000. No fixed seed in ordinary tests. M1's runner retains its 120-second default and 900-second exploration process deadline and package/registry rebuild. Vitest's 130-second per-test limit allows the exploration interruption to report. These guards are cooperative, not OS I/O deadlines; choose sample counts that fit them.

Every predicate invocation, including every shrink and replay, creates a unique `mkdtemp` root. All operations and file streams complete before the next event. `finally` removes the root even on failure and checks its absence; no shared fixture, worker, subscription or timer survives a sample. The repository itself has no close method or persistent process resource.

After each settled repository operation, independent file assertions run concurrently. `Promise.allSettled` drains every read before advancing to the next operation or entering failure cleanup, then reports the first failed entry in model order. Generated repository operations remain serial; every byte, metadata and absence assertion, sample count and wall budget stays unchanged. This avoids accumulating serial read latency under concurrent desktop test load.

Failures print the complete input event array, seed, path, budget, shrink count and dependency/runtime versions via M1's helper. `replayPath` is null because plain arrays are used rather than `fc.commands` or a scheduler. The helper now labels attachment event order as serial awaited operations followed by the probe and cleanup. Paths require the exact generator, versions, seed and original sample count recorded in [the evidence JSON](attachment-properties-evidence.json). A replay on healthy code passes; to reproduce failure first apply only the corresponding temporary fault below, then restore it.

## Fault detection, shrinking and replay

All three temporary mutations were applied separately to production source, detected with seed 98 / 100 samples, replayed to the identical minimized input with zero further shrinks, then restored. These are sensitivity demonstrations, not newly discovered production bugs. The JSON records exact edits, paths, event arrays, environment, source/lockfile hashes and raw-log hashes.

| Temporary mutation | Minimized generated sequence | Path / shrinks |
| --- | --- | --- |
| GC ignores `liveEntries.has(entry.name)` | retain(agent, file 0) → forced-expiry GC | `4:1:0:1:1:1:1` / 6 |
| `inheritOwners` returns before copying any ownership | retain(bart, file 0) → fork(bart, agent) → release(bart) → forced-expiry GC | `54:5:9:9:14:14` / 5 |
| Missing established index returns an empty owner map | empty event array → retain fixture → remove index → reopen → GC | `1:0` / 1 |

Use selector `attachment owner sets` for the first two and `attachment invalid index` for the third. Substitute the table path into the replay command. Detection used the direct Vitest command in the JSON after a normal package rebuild; replay additionally ran against the identical temporary edit. The read-check update recaptured all three faults, including failing replay and a passing replay after byte-exact source restoration. Current raw logs are retained under `.agents/local/attachment-faults/pr-238`, with source/property/log hashes and capture provenance in the committed JSON. No mutation flag or faulty implementation is shipped.

## Measured validation cost

On 2026-09-09, macOS arm64 / Node 22.22.2 / pnpm 10.17.1 / Vitest 4.1.10, seed-98 exploration passed 1000 samples per property in 107.25 seconds of Vitest wall time (105.76 seconds in predicates). After exploration completed, three alternating measurements ran the adjacent repository suite alone, then the same suite plus these two properties, using one Vitest worker and seeds 98/99/100. Baseline wall times were 2.287 / 1.294 / 1.766 seconds; candidate times were 8.476 / 6.245 / 9.634 seconds. Median paired added time: 6.189 seconds. These process measurements include Vitest startup, exclude package rebuild/install, and do not control other desktop activity or represent whole-verifier cost. The retained second batch and exact commands are in the JSON.
