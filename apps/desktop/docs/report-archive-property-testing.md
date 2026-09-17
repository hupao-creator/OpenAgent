# Report association, Overview selection and archive properties (Issue #143 phase 2)

Current cross-family budgets, configurable exploration and parent acceptance:
[M9 governance](property-governance.md). Fault evidence:
[report-archive-property-evidence.json](report-archive-property-evidence.json).

These properties protect the Report / archive business rules that were previously
covered only by example tests. They change no production code: the shared Report
parsers, the Overview layout selector, the auto-archive rule in the shared
reducer and the `archive-report` command are called through their public seams.
The archive family drives a real [`ThreadStateStore`](../src/main/services/thread-state-store.ts)
on a temporary directory with the real SQLite shim, and injects
[`ReportService`](../src/main/use-cases/report-service.ts)'s own
`ReportRepository` interface. Two of that interface's members depart from the
production composition, and the fixture says so at the definition — the other
members it injects are the production bodies, `readThreadTags` among them, which
mirrors the production composition (workspace directory tag first, then the
Thread's tags): `replaceReports` takes only the reports and drops both the `event`
publication and the `relatedExecutionChecks` argument that
[the production composition](../src/main/openagent-service.ts) passes into the
store's locked commit, so this family exercises the eager check in `tagSnapshot`
and cannot observe a regression in the authoritative locked re-validation; and
`resolveExecution` is the stand-in that keeps these worlds self-contained: it
resolves a reference when it names the Thread's current public Execution instead
of delegating to an owning Harness, which these worlds' opaque fixture session
state could not support. That is stricter than the documented rule, which keeps
an **older** completed Execution eligible
([thread-report-organization.md](thread-report-organization.md), "References and
ownership"), so
the worlds that need a superseded reference seed the record rather than calling
`ReportService`; the refusal the update property asserts does not depend on the
difference. Nothing here
is a second lifecycle owner, and no production module gains an export for testing.

## What each family asserts

| Family | Public seam | Invariants |
| --- | --- | --- |
| F1 [Report fields](../tests/property/report-thread.property.test.ts) | `parseReportTitle`, `parseReportHtml`, `parseReportRelatedExecutions`, `exceedsUnicodeLength` from `src/shared/report-thread.ts` | a title normalizes to a fixed point (collapse whitespace runs, trim, then cap) and the cap counts Unicode code points rather than UTF-16 units, so a non-BMP or full-width title is decided by the same rule that iteration sees; `exceedsUnicodeLength(value, limit)` agrees with `Array.from(value).length > limit` for every generated string and limit; related executions keep caller order, deduplicate by first occurrence, refuse one Thread carrying two different Execution IDs, and reject an illegal shape, blank/whitespace ID, unknown field or oversize array **before** any deduplication — the oversize case is drawn in two shapes, one whose references are all distinct and one whose references collapse to a legal size, so a parser regressed to deduplicate first cannot pass on the second; accepted HTML is returned unchanged while a document whose markup was entirely entity-escaped is refused |
| F2 [Overview selection](../tests/property/overview-selection.property.test.ts) | `selectOverviewItems` and the renderer-local `tagKey` from `src/renderer/src/conversation-overview-layout.ts` | a Thread is hidden **exactly when** a visible Report covers its current Execution (a biconditional asserted over every input, not only the candidates); a Report that fails the view or tag filter never hides a Thread — the covering Report's own view is drawn independently of the Thread's, so both legs of that filter are exercised rather than assumed — and a Report with no reference to the Execution cannot cover it however visible it is; disabling merge restores every filtered candidate, merging only removes covered candidates and preserves relative order; the two archive views partition Threads and Reports; ordering is stable by `createdAt` with input position breaking ties; a workspace directory acts as a tag under the shared identity rule and `tagKey` must not drift from the contract's `threadTagKey` |
| L1/L2 [Archive rules and command](../tests/property/report-archive.property.test.ts) | the real `ThreadStateStore` command surface (`replace-thread-session-state`, `set-agent-thread-archived`, `replace-reports`, `archive-report`), which runs the shared reducer's `shouldAutoArchiveFailedExecution` and `reduceOpenAgentState` in `src/shared/openagent-state.ts` — neither reducer entry point is imported directly; the family reaches both through that command surface, and the three bindings it does take from that module are `createOpenAgentState` and the `readAgentThread`/`readBartThread` readers — plus `ReportService` | see below |
| S1 [Archive durability](../tests/property/storage.property.test.ts) | `ThreadStateStore.commit`/`flush`/`close` with the real SQLite shim | an archive is a whole-aggregate commit: its Report and every covered Agent are durable when the commit promise resolves, while a coalescible `running` observation committed before it is still waiting for its debounce; `flush` then seals that observation, a second `close()` returns the same promise as the first, and the durable aggregate equals memory at each step |

## The archive family

Fourteen cases — eight properties plus the six fault boundaries — over a
generator that commits a small world of Thread roles and a Report referencing
them:

| Role | Committed state | What it protects |
| --- | --- | --- |
| `matched` | observes the referenced Execution | the archive covers it |
| `covered` | observes the referenced Execution, with its own id | a world holds **more than one** covered Agent; the interleaving family races the second one |
| `diverged` | observes a different **completed** Execution | a historical reference must not cover or archive the Thread's current Execution |
| `empty` | `latestExecution: null` | an unobserved Thread is never archived |
| `archived` | already archived and covered | the archive is idempotent and does not re-bump a revision |
| `bart` | the Bart Thread, which has no `archived` field | a Report may reference Bart without the archive inventing archive state for it |

Coverage is decided **per Thread** by that Thread's own current Execution, so one
world holds covered and referenced-but-uncovered Agents at the same time — which
is what makes the affected-set assertion discriminating rather than a restatement
of a world-wide constant.

Every sample also commits an unlisted `unrelated` Agent with a completed
Execution. It is never referenced. The archive property asserts its **record
identity** is preserved (`toBe`, not deep equality) next to the whole-aggregate
comparison, and the observation property asserts it against every other Thread in
the state, so an archive that widens its propagation range is caught by the
untouched-object check rather than only by a changed flag. The fault-recovery and
interleaving properties compare the whole aggregate instead, where an archive that
reached an unreferenced Thread would also change the compared state.

The rule under test is stated the way the issue states it: a Report may hold a
reference to a historical completed Execution for a Thread whose current
Execution is something else, and that reference neither covers the Thread in the
Overview nor archives it.

- **Auto-archive rule.** Replaying an observation sequence twice never changes
  the archive flag, asserted after every step so a transient re-archive cannot
  hide behind a later unarchive: a non-failed observation archives nothing, and a
  failure the Thread has already recorded as its latest Execution is not a new
  failure. Only a failure that started **strictly later** than the committed
  latest re-archives after the user unarchived the Thread; an equal timestamp
  cannot be ordered and must not archive. A commit changes only its own Thread.
- **Archive command.** The archive covers exactly the referenced Threads whose
  current Execution matches — checked against an oracle derived from the world,
  not from the reducer. The affected set, each Thread's `archived` flag and its
  revision are all asserted, together with the untouched records of Bart and of
  the unrelated Agent.
- **Fault recovery.** Six boundaries — `prepare-agent`, `prepare-report`,
  `admission`, `statement`, `before-commit` and `after-commit` — fail the
  command at each point. A pre-commit failure restores the complete previous
  aggregate and a lost acknowledgement after the commit record recovers the
  complete new aggregate; a partially archived Report or Agent is never an
  accepted outcome. The assertion is whole-aggregate equality against the
  expected state, not a flag check.
- **Report updates.** A title- or HTML-only update preserves the relations and
  their derived tag snapshot, and rewrites no Thread record (asserted by object
  identity over the whole population). Replacing the references re-evaluates the
  snapshot from the new set only — the newly referenced Thread contributes its
  workspace tag and its own tags, the dropped Threads stop contributing — and
  archives nothing. A replacement that names an Execution its Thread does not
  carry is refused, and the refusal leaves the committed aggregate identical.
- **Controlled interleaving.** Three racers are admitted first and each blocks in
  its own Thread scope behind an explicit barrier: a new Execution for one
  referenced Agent, a deletion of another referenced Agent, and a metadata update
  of the unreferenced Agent. The archive then runs behind them. The racer set is
  pinned to all three (in a generated order) rather than drawn from a subarray, so
  every run exercises all three commands together. Because the deletion therefore
  always takes the matched Agent and the execution racer moves the other referenced
  Agent off the reference, the sample seeds a **third** covered Agent, `spare`,
  that no racer touches: it is what keeps the archive's own coverage observable in
  this world rather than assumed from the deletion not happening. The property
  asserts the per-racer outcome, the revision of every touched Thread (each moved
  exactly once: the archive covers the seeded `spare` Agent, the execution racer
  commits to the raced one, the update to the unreferenced one), that the
  unreferenced Agent carries only its own update and stays unarchived, that the
  deleted Thread is not resurrected, that the **archived population as a whole**
  is exactly the covered Threads — so a widened propagation range or a lost
  archive fails the set comparison rather than only a flag — and that the durable
  aggregate equals memory after `flush`. Disk is always read through a **fresh** store connection (`disk()`), so
  a durable-state expectation never passes because memory happened to agree. The
  raced statuses are terminal only: a non-terminal observation is coalescible,
  never reaches the commit barrier and therefore cannot participate in the gate —
  that restriction comes from the store's own contract, not from a weaker test.

## Budgets, isolation and commands

From the repository root:

```sh
pnpm test:properties -- -t 'Report title'
pnpm test:properties -- -t 'Overview selection'
pnpm test:properties -- -t 'An archive covers exactly'
FC_SEED=143 FC_RUNS=100 pnpm test:properties:explore -- -t 'An archive covers exactly'
FC_RUNS=<detection numRuns> FC_SEED=<seed> FC_PATH='<path>' pnpm test:properties:replay -- -t '<property>'
```

The replay line takes its run count from the detection transcript it replays
rather than from a fixed number — each failure prints the exact command to copy
— so the archive family's fault replays use that family's delivered six runs,
while a replay of a property in one of the pure families uses that family's own
count.

F1 declares 100 normal / 1000 exploration samples per property; F2 uses the
shared synchronous `check` driver and therefore the shared 100/1000 defaults.
Both are pure: no process, socket, clock or file. The archive family declares 6
normal / 60 exploration samples because every sample owns a temporary directory
and a real SQLite store — roughly forty times the cost of a pure sample. The tier
is the smallest one the storage family already uses for its own fault boundaries,
chosen against a direct measurement of this file rather than a suite-level
estimate: its fourteen cases take 6.11 s of Vitest wall time at `FC_RUNS=6` and
9.16 s at `FC_RUNS=10` (logs `/tmp/143-cost2/archive-{6,10}-samples-r13.log`, re-taken
against the delivered revision of this file), so the
delivered tier keeps about 3 s of this family's cost out of the suite. An
earlier preliminary sweep's suite-level figure for the 10-sample tier is not
part of the delivered evidence and is not restated here. The storage family keeps its own 10/100, with 6/40 for the
recovery boundaries. The per-property guard differs by driver: the two families
that call `checkAsync` with an explicit budget (`report-thread`, `report-archive`)
declare 30 s normally and 120 s under exploration with a 35 s / 130 s Vitest
ceiling, while the synchronous `check` families (`overview-selection`) and the new
storage property run under the shared defaults — a 10 s interruption limit and
120 s under exploration — with the storage family's own 130 s ceiling.

Isolation: each sample creates its own `mkdtemp` directory and its own
`ThreadStateStore`, and every sample's resources are closed and removed as soon
as that sample ends — fast-check's per-sample `afterEach` hook on each property
runs `releaseSample` after every predicate invocation, shrinking re-runs
included, so an exploration run does not hold sixty open stores and their SQLite
workers until the property finishes; Vitest's `afterEach` remains as the fallback
for a sample that never returns. The archive fixture sets `persistenceDebounceMs` and
`persistenceMaxWaitMs` to 60 s so that durability is decided by the explicit
`flush()` calls in the properties rather than by a timer that could fire
mid-assertion. `ThreadStateStore` takes no clock or ID (only the debounce and
fault options above); `ReportService` receives an injected clock, and the
properties assert that timestamps move forward rather than restating its floor
rule, so nothing depends on wall-clock time. Cleanup uses
`Promise.allSettled`, so one failing close cannot mask the others.

## Fault detection, shrinking and replay

Three temporary production mutations were applied separately, detected,
minimized, replayed to the identical
counterexample and then restored. They are sensitivity
demonstrations of the tests as delivered, not newly discovered production bugs;
the exact edits are in the evidence JSON and under `.agents/local/146-faults`.

| Temporary mutation | Counterexample (minimized) | Seed / path / shrink steps | Replay |
| --- | --- | --- | --- |
| A: `archiveReport` drops the `latestExecution?.executionId` match, so a referenced Thread is archived whatever its current Execution is | `{referenceId: 'E1', roles: ['diverged'], extraReferences: []}` | `1643310127` / `0:0` / 1 | same counterexample at 0 steps |
| B: `archiveReport` iterates every Thread instead of the referenced one, so the propagation range widens to unreferenced Threads | `{referenceId: 'E1', roles: ['matched'], extraReferences: []}` | `1015862783` / `3:0:0:0` / 3 | same counterexample at 0 steps |
| C: `shouldAutoArchiveFailedExecution` returns `true` for a repeat of the recorded Execution ID, so a dismissed failure archives again | `[1, 1]` (`startedAt` pair) | `-343911620` / `0:0:0` / 2 | same counterexample at 0 steps |

What the seed, the path and the shrink count vary with is which generated sample
happens to fail, not the fault the property catches: every capture of a given
mutation minimizes to a world of the same *kind*, and the kind is what the
mutation needs. Fault A's minimum is not unique across captures — the three most
recent captures each reduced to a `diverged` role (a Thread whose latest
Execution is a different one from the reference's, which the dropped match
clause archives anyway), while an earlier capture reduced to an `empty` role (a
Thread that observes nothing at all, which the same dropped clause archives on
the mere presence of the reference). Either shape discriminates the mutation,
which is why two captures of the same fault can name different roles.

Faults A and B are the two the issue names for this phase. Fault C targets
"failure → recovery → repeated observation" and the Report unarchive rule: with
it applied, the property's dismissed-failure assertion at
`report-archive.property.test.ts:299` fails on every sample — every detection
transcript reports `expected true to be false` there. The mutation cannot reach
the equal-timestamp assertion at `:305`, which runs with a *different* Execution
ID and so never enters the branch the mutation changed; that assertion, like the
equal-timestamp rule itself, is covered by the passing suite rather than by one
of these three mutations.

A replay reports `numShrinks: 0` because it runs the single recorded
counterexample; that is what replaying a minimized input does, not a missing
result. Fault B's detection needs the generated Report to reference the Execution
the always committed `unrelated` Agent observes — otherwise widening the
propagation range archives nothing new — so a sample that draws the other
reference ID passes. That is a property of the generator, and it is recorded
rather than smoothed over: at the delivered six samples the fault is detected in
the large majority of runs, and the recorded detection is from the first attempt.

## Limitations

The interleaving is a controlled one: racers block on explicit gates inside
`ScopedCommands`, so the properties claim the documented scope and ordering
contract, not OS scheduling, real thread preemption or timing. SQLite and the
filesystem are real but local and single-machine; no crash, power loss or
filesystem error is injected, and the store's own `storage` family keeps those
boundaries. The Overview family is pure and claims nothing about layout,
geometry or rendering — it asserts which records are selected, in which order.
Report HTML is asserted as an unchanged opaque document; it is never rendered,
so no sanitization or rendering claim is made.

## Measured validation cost

On 2026-09-10, macOS arm64 / Node 22.22.2 / pnpm 10.17.1 / Vitest 4.1.10, three
alternating runs of the whole property suite reported 42.35 / 47.99 / 42.44 s
without the phase-2 files (12 files / 51 tests) and 53.05 / 51.38 / 51.46 s with
them (15 files / 80 tests) — medians 42.44 s and 51.46 s. Median difference:
+9.02 s, and the same-round paired differences are 10.70 / 3.39 / 9.02 s — inside
the ≤10 s phase gate as the issue reads it (off the median), by about a second,
and the round is reported as it was measured rather than re-run until a quieter
machine appeared. The widest pair is the first: the candidate opened the round at
its slowest (53.05 s) while the baseline ran its fastest (42.35 s), so the drift
reached the two trees at different points of the alternating cycle. The narrowest
is the second (47.99 against 51.38 s), which holds the baseline's slowest run,
and the third (42.44 against 51.46 s) left each tree within about half a second
of its own median, which is why the median difference and the third pair agree.
Of the added time,
`report-archive.property.test.ts` accounts for 5.62 s of test bodies, the new
storage property 2.57 s — that row is the difference of the two sides' medians,
since the file exists on both — and the two pure files 0.04 s and 0.05 s; which
is why the per-file figures and the suite-level median are reported side by side
rather than summed. This measurement has been taken seven times with the same
method and the rounds disagree in both directions — +3.62 s with pairs of 3.84 /
6.12 / -0.94 s, +6.07 s with pairs of 4.03 / 6.67 / 8.17 s, +6.27 s with pairs
of 6.14 / 11.37 / 7.98 s, +4.78 s with pairs of 7.92 / 14.44 / 3.85 s, +6.05 s
with pairs of 6.64 / 4.70 / 6.21 s and +8.71 s with pairs of 7.11 / 9.99 / 8.36 s
before this one — so every round's
pairs are reported next to its median difference rather than one pair standing
in for the measurement, and the gate is read off the median. The per-file test
bodies move with the machine too: the three new files account for 5.71 s of test
bodies and the storage boundary adds 2.57 s in this round, while the unrelated
`native-harness.property.test.ts` fell 1.14 s (11.16 s to 10.02 s as a per-file
median) and `lifecycle.property.test.ts` rose 0.24 s, all with no content change
— so part of every per-file row is machine drift rather than new coverage, in
either direction.
The three new files alone take 6.52 s of Vitest wall time normally
and 56.09 s at their declared exploration defaults, of which 5.81 s and 55.34 s
fall inside the test bodies — the exploration run passed, and repeat runs at that
tier vary by up to a second. These are Vitest's own
suite durations: they include startup and transform, exclude package rebuild or
install, and do not control other desktop activity. The evidence JSON records
the same runs, the slowest individual properties and the sample-count decision
above.
