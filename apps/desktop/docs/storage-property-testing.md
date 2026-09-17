# Storage properties (Issue #97 M3a)

Current cross-family budgets, configurable command exploration, extension guidance and
parent acceptance: [M9 governance](property-governance.md).

These fast-check properties exercise the existing [storage contract](STATE_PERSISTENCE.md)
through `ThreadStateStore` and `SqliteStatePersistence`. Production algorithms,
dependencies and ownership are unchanged. An internal `preparationFault` diagnostic
option exits a real preparation worker only after it receives an admitted request;
it is absent from application composition and does not cross public IPC. Effect adoption and its before/after
cost comparison remain separate work; [M4 paused adoption](effect-directory-pilot.md),
so this delivery does not approve M7. The synthetic `{ value }` payload is opaque
fixture data, not an interpretation of any Harness's private sessionState.

## Commands and budgets

```sh
pnpm test:properties
pnpm test:properties:explore -- -t storage
FC_RUNS=50 FC_SEED=97 pnpm test:properties:explore -- -t storage
FC_RUNS=10 FC_SEED=97 FC_PATH='0:0' pnpm test:properties:replay -- -t 'storage preparation order'
```

The replay command passes on healthy code. To reproduce the recorded fault,
apply the exact temporary edit in [the evidence JSON](storage-property-evidence.json),
run its selector with its recorded seed/path/sample budget, then restore the edit.
Failures print those parameters, minimized inputs, shrink count and fast-check/Node
versions. `replayPath` is null: generated arrays drive explicit gates; there is no
fast-check scheduler or `fc.commands` runner requiring a second replay path.

Default: 10 samples each for scoped commands, preparation order, unrelated
scope progress and the [Report archive durability](report-archive-property-testing.md)
boundary added by issue #143 phase 2; 6 samples for **each** of six fault
boundaries (76 total). Exploration: 100 for each of the first three plus the
archive boundary and 40 for each fault (640 total).
An explicit `FC_RUNS` overrides every family's budget. M1 retains 100 default pure
samples, 30 async recovery samples and 1000 exploration samples. The runner now
lets each family choose its exploration default rather than injecting FC_RUNS.
All suites are discovered by ordinary `pnpm test` and the full verifier.

Each property has the shared 10-second default / 120-second exploration
interruption budget, with interruption counted as failure. Ten storage cases
therefore have a 100/1200-second aggregate upper budget, plus M1's 40/480 seconds;
other families such as M3b have additional budgets. The dedicated process caps
the whole run at 120/900 seconds. These are ceiling
guards, not expected runtime or hard real-time preemption. The storage Vitest
case deadline is 130 seconds so fast-check can report exploration interruption.
Progress gates have a five-second watchdog, always cleared on settlement, to
report a lost progress guarantee and release held preparation in `finally`.

## Inputs, event control and independent assertions

| Family | Input domain and observable contract | Controlled event order |
| --- | --- | --- |
| Scoped commands | 1–12 operations on two valid Threads; integer payload −1000..1000; running/completed/failed/interrupted updates, deliberately mismatched revision, or scoped flush. A tiny model tracks only expected revision, opaque value and public status. Each sample prefixes running, completed and an old-revision rejection and suffixes an admitted running update plus close. | Await each generated command; streaming must not create a transaction; terminal/flush success must already be visible through a separate read connection. Stale commands change no model fact. Close starts before the final admitted update settles, rejects new commit/save, is idempotent and must persist that update. |
| Preparation/version order | Four captures with increasing revision and distinct payloads followed by returning to A; all 24 release permutations are generatable. The oracle is the highest released version, independent of the production version map. | Hold all four Bart preparations, release in generated order, await each write, reopen/read and assert the newest capture. Then explicitly run exact-record A → held B → same A → release B, ensuring content equality cannot erase the version fence. |
| Independent scopes | Generated payload and running/completed/failed/interrupted state on Agent while Bart terminal preparation is held. | Hold Bart before encoding → commit Agent → flush Agent → read durable Agent while Bart is still unpublished → begin close → release Bart → assert both records survive reducer replay and close. |
| Report archive durability (issue #143 phase 2) | 1–3 covered Agent Threads with unique generated Execution IDs and revisions 0–4, one Thread whose Report reference points at a superseded Execution, one deferred Thread and one Report referencing all of them. The oracle is derived from the seeded aggregate, never from the reducer under test. | Save the seed and read it back from disk → commit a running observation and assert memory advanced while disk still equals the seed → commit `archive-report` and assert disk already equals the whole expected aggregate (Report plus every covered Agent archived with revision +1, the historical Thread untouched, the deferred observation still absent) → `flush` → `close` is idempotent → a fresh reader after close returns exactly that aggregate. |
| Recovery | Every boundary gets its own generated suite. Multi-entity changes include paired Thread records, reversed catalog order, selected Thread, locale, a Report/HTML and 0–4 unique legal tags (integers 0..20 converted to tag DTOs). | Save old aggregate → inject one fault → reject write → read exact expected complete aggregate → verify owner usability/fatal rejection → close → reopen and write again. |

Recovery distinguishes preparation callback rejection, actual preparation-worker
exit with a request in flight, transaction-admission rejection, SQL statement failure (rollback), writer
exit before COMMIT and writer exit after COMMIT but before its reply. The last
case **must read the new aggregate despite the rejected Promise**. Fatal owners
reject later writes/drain without reaching transaction admission. Only known
nonfatal failures are retried; unknown-result owners must be closed and reopened.
The deterministic exit hooks tell the test which side committed; arbitrary
worker exits promise only a complete old or new state, not a specific side.

Each sample owns a fresh temporary directory and all writers/readers. Readers
close in `finally`; held gates release and pending writes settle in `finally`;
owners close even on assertion failure, then files are removed. Worker references
are inspected only for resource diagnostics (existing private seam, as in the
SQLite regression suite): normal close and every fault case assert all three
started workers have `threadId === -1`. No private value/version map is read.

## Evidence and limits

The evidence JSON records temporary production mutations for terminal durability,
version fencing, unchanged-content ABA fencing, cross-scope replay, lost owner invalidation after an admitted preparation exit and SQL rollback, with actual detection and identical-counterexample
replay. No production defect was discovered. These mutations were restored.
The command family also covers cross-scope progress/close; native worker-release
and close regressions remain in `thread-state-store.test.ts` and
`sqlite-state-persistence.test.ts`.

These are real SQLite transactions and Node workers with controlled preparation
and transaction faults, not an exhaustive OS scheduler or power-loss model. Worker
reply loss is exercised by exit immediately after COMMIT. We do not reorder arbitrary
worker messages, cover every command kind (fork/reset remain existing regressions),
or claim Windows/Linux validation from macOS results. No timers are virtualized;
streaming tests use a 60-second debounce/max-wait and explicit barriers. Native
Electron process recovery and packaged-app acceptance must still run separately:

```sh
pnpm --dir apps/desktop run pack:local:mac
OPENAGENT_SQLITE_EVIDENCE_ROOT=/absolute/new/local/run node apps/desktop/tests/sqlite-state-runtime.electron.mjs
pnpm verify --pr 107 --publish
```

Measured exploration, cost and native evidence are recorded with the delivery PR.

## Measured validation cost

On 2026-09-09, macOS arm64, Node 22.22.2, pnpm 10.17.1 and fast-check 4.9.0,
run the two adjacent storage suites with one Vitest worker, then add the storage
property file; repeat for seeds 97, 98, 99 after package generation. Baseline wall
times: 10.958 / 7.188 / 6.75 s; candidate: 20.103 / 20.59 / 17.415 s.
Median added wall time: 12.915 s. Other desktop tasks were active; these are local
wall measurements, not isolated CPU or whole-verifier performance claims. Exact
commands and log hashes are in the evidence JSON. All three seeded default runs passed on the measured version, before the final
ABA fixture correction to reuse the loaded object. Current-candidate verification
is published separately on the PR. The earlier 540-sample exploration passed in 145.88 s, before the
additional mandatory stale-revision assertion; see the JSON for that scope.
The six native Electron/packaged recovery cases passed; their actual artifact
hashes and results are also retained in the JSON.

Review caught and corrected an ABA fixture gap: reading A through a second
reader creates a new object and bypasses the identity-based unchanged-content
optimization. The final fixture reuses the writable owner’s loaded object. A
fifth temporary mutation removes the pending-scope equality exception and is
detected/shrunk/replayed at seed 97, path `0:0`. This is a test coverage correction,
not a discovered production defect.

Remote review also corrected the preparation-exit scenario: terminating an idle
worker before `persist` only tests admission rejection. The final fault exits
inside the real worker message handler after a preparation request arrives,
asserts exit code 93 and at least one admitted preparation request, then verifies
the failed write, fatal owner, resource release and reopen. A sixth mutation
suppresses owner invalidation; this property detects and replays that defect.
