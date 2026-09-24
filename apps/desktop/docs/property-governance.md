# Property governance and M9 acceptance

当前测试策略：普通单元/DOM 测试已移除，`tests/property/` 中也只保留生成性质。
`pnpm test` 运行 PBT 和构建缓存集成检查；浏览器、Electron、headless 验收保留独立入口。
2026-09-24 按逐项评分删除低于 8 分的 46 个 PBT 定义，保留恰好 8 分及以上的性质：
普通 PBT 为 21 个文件、52 个定义，参数化后共 62 个 Vitest 用例；
headless 的 3 个性质组均保留，展开为 7 个目标组合。
本文涉及已删除 PBT、helper 单测、普通回归测试和原有数量的记录均为清理前的历史证据。

Current suite: fixed example injection has been removed from `checkAsync`.
Sample budgets now count generated inputs only. Generated properties, shrinking
and replay remain; coverage of an individual mode depends on the generated draw.
The mutation results and replay coordinates below are historical evidence from
before this cleanup, including references to mandatory examples. They must be
recaptured against the current generators before being used as current evidence.

Issue #106; integration owner: Codex task `01a08463-5448-7f10-92ca-bed10cf628f2`.
This is the maintenance entry for the narrowed scope of parent #92. Production
adopts fast-check only as a test dependency. Effect is **not adopted**, including
as a development dependency: Promise implementations are retained after
[M4 exceeded its measured gates](effect-directory-pilot.md#results-and-adoption-decision).
M5a–M5c/M6/M7/M8 (#100–#105) are closed **not planned**, unimplemented and not
accepted as completed rewrites. A new bounded proposal is required to reconsider.

## Daily runs, exploration and replay

`pnpm test` discovers every `tests/property/*.test.ts` suite; the CI `verify`
workflow runs that normal suite on the PR head along with typechecking, build,
browser development and real Electron checks. There is no scheduled job.
Ordinary runs choose random seeds. Fixed seeds reproduce regressions or compare
costs; they must not become the only long-term input set.

From the repository root after `pnpm install --frozen-lockfile`:

```sh
pnpm test:properties
# Bounded, sequential multi-seed exploration; stop at the first failure.
for seed in 106 107 108; do
  FC_RUNS=30 FC_MAX_COMMANDS=60 FC_SEED=$seed pnpm test:properties:explore || break
done
# One family, a larger sample count and longer generated command arrays:
FC_RUNS=100 FC_MAX_COMMANDS=80 FC_SEED=106 pnpm test:properties:explore -- -t 'lifecycle public model'
# Historical replay; omit FC_MAX_COMMANDS to retain the original generator cap.
FC_RUNS=30 FC_SEED=96 FC_PATH='0:0:0' pnpm test:properties:replay -- -t 'lifecycle stale Stop'
```

`FC_RUNS` accepts 1–100000. `FC_MAX_COMMANDS` accepts 1–1000 and sets the maximum
array length for lifecycle public-model operations (default 35), storage scoped
commands (12) and attachment operations (30). It is an upper bound, not an exact
length or a cap on mandatory setup/probes. Other bounded scenarios retain their
own domains: do not shorten a mandatory race or fault skeleton. Normal defaults
and generators are unchanged when the variable is absent. Larger arrays cost more
and do not increase time guards. Keep selectors and sample counts within budget.

`FC_SEED`/`FC_PATH` address exactly one `-t` property. Copy the emitted command,
including `FC_EXPLORE=1` and `FC_MAX_COMMANDS` when present; preserve Git SHA,
lockfile, generator, sample count and fault setup. All present families use explicit
arrays/gates, so `replayPath` is null. Native/OS scheduling remains uncontrolled.
A healthy-code replay normally passes; reproducing a mutation failure requires
its recorded temporary edit or test-only fault variable. Restore that edit before
normal verification. A timeout is a failed exploration, never partial success.

The dedicated runner builds packages/registries before testing and allows 120 s
per subprocess normally, 900 s in exploration (including exploration replay).
Per-property guards below are cooperative and may complete a bounded predicate
before reporting interruption. They are not OS I/O deadlines. The whole-process
cap can be reached before the sum of per-property caps; use family selectors for
large exploration. The full verifier retains its existing step deadlines.

## Maintained family inventory

Each linked guide specifies the current contract, input domain, event order,
resource cleanup, limitations, fault edits and executable replay commands. The
JSON evidence is historical measured data, not a newly executed M9 result.

| Family / maintained guide | Normal samples; generated domain / controlled events | Guard and detection evidence |
| --- | --- | --- |
| [Markdown, Renderer patches/recovery, Bart Dock](property-testing.md) | 100 each pure property, 30 recovery; bounded fragments/append sizes, legal A/B/C revisions, finite geometry; append prefixes and explicit gap hydration | 10 s/property; [M1 JSON](property-testing-evidence.json): stale parse, ignored newer entity revision, missing obstacle checks. Recovery shares Renderer coverage; its individual scenario is also protected by existing sync regressions. |
| [Core lifecycle](lifecycle-property-testing.md) | 30 each of 7; up to 35 commands or fixed authority-transfer races; send/Stop/respond/claim/admission/durability/archive/unarchive/dispose/reopen | 10 s/property; [M2 JSON](lifecycle-property-evidence.json): stale Stop, failed-open convergence, native durability and disposed-context fencing mutations. Fresh store/Handle/gates per sample, settled and closed in finally. |
| [Codex public Handle](harness-property-testing.md) | 30; up to 8 text chunks/4 disposals; real fixture subprocess, waiting/respond or interrupt, execution lookup | 30 s/property; [native evidence](native-harness-fault-evidence.json), Codex lookup mutation. OS/pipe timing and process escalation are not generated. |
| [Claude public Handle](harness-property-testing.md) | 30; generated deltas, native success/error, optional background snapshot, dispose | 30 s/property; same native JSON, Claude lookup mutation. Approval, kill escalation and background completion are excluded. |
| [Pi public Handle](pi-native-property-testing.md) | 30; generated execution ID, 0–3 retry attempts, six terminal modes, 1–3 disposals; real `openPiThread` over a module-mocked `startPiRpc` and an in-process programmable double | 30 s/property; [phase 3 JSON](pi-native-property-evidence.json): "treats `agent_end` as completion" detected, shrunk and replayed. The double is in-process, so OS process escalation and real native protocol timing are excluded. |
| [Pi RPC transport](pi-native-property-testing.md) | 8 each of generated chunk assembly, out-of-order correlation and cancellation, 12 generated failure-mode samples and 6 for the request bound; real `startPiRpc` against a programmable fixture process: generated UTF-8 chunk plans, held/forged/reordered responses, generated cancellations, eight failure modes and a virtual 30 s advance | 30 s/property; same phase-3 JSON: a dropped per-request abort and a disposal that leaves pending work unresolved, both detected, shrunk and replayed. Subprocess pipe delivery and OS teardown are not under a deterministic scheduler. |
| [Storage](storage-property-testing.md) | 10 each scoped commands/preparation order/independent scope and the [Report archive durability](report-archive-property-testing.md) boundary; 6 each of 6 recovery boundaries; up to 12 commands, four preparation releases and mandatory ABA; controlled real workers/SQLite faults | 10 s/property; [storage JSON](storage-property-evidence.json): six mutations covering durability, fences, scope replay, rollback and fatal owner. Finally closes workers; release asserted. Unknown COMMIT results are not assumed rollback or blindly retried. |
| [Attachment ownership](attachment-properties.md) | 30 each of 2; up to 30 operations plus mandatory GC and invalid-index probes; independent owner sets, serial filesystem events | 10 s/property; [attachment JSON](attachment-properties-evidence.json): live-owner GC, lost inheritance, missing-index protection. Unique roots removed in finally; overlapping I/O and exact TTL races excluded. |
| [Harness public settings and command input](harness-settings-property-testing.md) | 100 each of 14 properties plus one coverage test; enumerated native catalogs and permission presets, dependent resets on both settings paths for Codex effort/serviceTier and on one path each for Claude effort (creation) and Pi thinking level (Thread update), retained native tool filters, RPC release on success/refusal/cancellation; Bart submit, attachment import and external-link inputs, one forged field per structured channel, both sides of the 128-part / 20-import / 20 MB bounds | 30 s/property; [phase 1 JSON](harness-settings-property-evidence.json): twelve temporary mutations recorded at delivery time (Codex unknown-field rejection, accepted-branch widening and update-path sibling reset, Claude effort reset and dropped retained tool filters, Pi public-option guard and thinking level, router settings shell and absolute-path guard for file parts, contract trim of the Bart directory tag; the two OpenCode variant-reset entries predate the Harness removal) detected, minimized and replayed at seed 143 — all at 100 samples except the router absolute-path guard, which needed 1000 to reach its rare generated case; two entries come from enumerated-constant generators that fast-check does not shrink across, so they record the first failing sample unchanged while the other ten minimized, and the shrink outcome is recorded for every entry. Every native boundary is a test-owned mock; no real CLI, model request, subprocess or socket. |
| [Codex pure families](harness-property-testing.md) | 14 properties: the three heavy state-machine properties keep 50/500 and the 200-turn truncation window 30/100, the framing/interaction/telemetry/identity properties 100/1000; generated stage/event/settle-or-orphan rounds with per-step validator, monotonicity, reference-uniqueness, truncation and JSON round-trip assertions plus batched-delta equivalence against the production merge; close and progress events retargeted at the live entity they close, with activity timestamp, target survival, per-resolution interaction status and done-outcome settlement asserted from generated scenarios; any line sequence × byte-cut framing with generated byte cuts; the five-method interaction decision matrix with per-method expected action sets, the timeout ≡ user-cancel isomorphism, MCP form round trip and public option-id translation; input-derived telemetry oracles (scope and `limitReached` read out of the resolved bucket map, so a shadowing dictionary bucket contributes its own provider-scoped flags) and fail-closed paths; recursive key-order/binding permutation invariance of the tool identity hash  | 10 s/property normally (30 s for the Codex JsonLines framing property, whose byte-cut plans are the heaviest of the pure set), 120 s in exploration — the shared helper applies that interrupt to every property, synchronous or async, and marks an interruption as a failure; [codex JSON](codex-property-evidence.json): nineteen temporary mutations — turns truncation head-retention, dropped CRLF alternative, approval timeout `cancel`→`decline` (first failing mandatory example), negative percent guard, removed identity name sort, a no-op `usage` event in the state reducer (caught by the per-event model oracle), dropped 200-step plan slice (caught by the 230-step mandatory example), a lossy production delta batcher, a constant `percentValue` (caught only by the input-derived percentage comparison), a `limitReached` that drops the explicit provider reach on the no-window path (caught only by the mandatory reach-without-windows example), a dropped `allow-session` action (caught only by the expected action set), an unwritten session binding (caught only by the explicit binding comparison on the entity-lifecycle example), a stale `activity-end` id, an `activity-update` that never stamps `updatedAt`, an `activity-end` that deletes its target instead of terminalizing it, a flattened `interaction-closed` status and a `done` whose outcome is ignored and marks all streaming assistant items complete (each of the last four caught only by the targeted effect assertion on the mandatory examples), oversized text retaining its head instead of its distinct suffix, and model buckets misclassified as feature scope — detected, replayed and restored byte-exact. |
| [Claude pure families](harness-property-testing.md) | 100 each of 11 properties; generated event/delta sequences driving the controller's timeline composition with an exhaustive sweep of 22 parser fail-closed single-field mutants and encode/decode/parse round trips, bounded-append tail retention plus mandatory over-limit runtime strings; any line sequence × byte-chunk framing with byte-at-a-time multi-byte and CRLF probes; settle idempotence/terminalization, usage-ledger (driven through the production `applyClaudeUsageSample` seam, advanced from the generated events at every prefix and compared as complete objects) and model-cost delta conservation; tagged get_usage telemetry windows | 10 s/property normally, 120 s in exploration — the shared helper applies that interrupt to every property, synchronous or async, and marks an interruption as a failure; [claude JSON](claude-property-evidence.json): eleven temporary mutations — latin1 decoder (first failing mandatory example), appendBounded head-retention, settle idempotence-guard removal, Bart window-drop, duplicate timeline-id guard drop (exhaustive sweep, named-mutant detection), usage dedupe-guard removal (first failing sample via the production seam), a CRLF-ignoring JsonLines framer (caught by the mandatory CRLF example), a `boundedRuntime` that stopped clipping the model field (caught by the over-limit runtime property), a summary family widened to admit token fields (caught only by the complete-object comparison), a dropped capability slice in the persisted runtime (caught by the capability-count property) and a blanked provisional pending snapshot (caught only by the input-derived visible total) — detected, replayed and restored byte-exact. |
| [Report association, Overview selection and archive](report-archive-property-testing.md) | 100/1000 each for the two pure files (Report field parsing and the Overview hiding biconditional over a workspace tag model); 6/60 each for the fourteen archive cases (eight properties plus six fault boundaries) over committed Thread roles (`matched`/`covered`/`diverged`/`empty`/`archived`/`bart` plus an always-present unreferenced Agent), one Report, six fault boundaries, three gated racers (all three raced every run, in a generated order) and the real `archive-report` command; coverage is decided by each Thread's own current Execution, so one world holds covered and referenced-but-uncovered Agents at once, and content-only `ReportService.update` calls are asserted to preserve the relations, their tag snapshot and every Thread record | 30 s/property; [phase 2 JSON](report-archive-property-evidence.json): three temporary mutations — reference-only coverage ignoring the latest-ID match, archive propagation widened past the referenced set, and a dismissed failure re-archiving by recorded ID — detected, minimized (1/3/2 shrink steps) and replayed at the seed/path recorded per entry. Real SQLite store on a temporary directory; racers block on explicit gates in their own Thread scopes, so ordering is contractual rather than an OS schedule. |
| [Bart headless state machine](../tests/BART_HEADLESS_ACCEPTANCE.md#property-based-state-machine-regression-headless-pbt) | Dedicated runner: 6 × 6 fixed-seed regression; exploration uses 40 × 24 batches, at most four, with fresh seeds. Real Bart/Core/Harness/native CLI and file effects; only the LLM HTTP endpoint is mocked. Lifecycle, interaction ownership and two-Thread isolation use independent checkpoint/generated coverage. | Native wait deadlines and bounded batch budgets; [mutation evidence](bart-headless-pbt-evidence.json) records checkpoint and generated shrinking/replay, plus clean-code non-reproduction. Every attempt owns its processes, profiles, ports and proofs; detached native process release is independently checked. Not part of the fast in-process `pnpm test:properties` budget. |

Exploration guards are 120 s/property. Storage exploration defaults to 100 samples
for its first three, the shared archive durability boundary and 40 for each fault
boundary; the issue #143 phase-2 archive family keeps 60 (its samples each own a
temporary SQLite store); the two pure phase-2 files keep 1000. The issue #143
phase-3 families declare their own counts in source — 100 for the Pi Handle and
60 for each Pi RPC property except the request bound, which keeps 30 because its
virtual 30 s advance costs more than the other RPC properties. Other families
default to 1000,
and the settings/command-input files declare 100/1000 in source, overriding
`checkAsync`'s shared `{ normal: 30, explore: 1000 }` fallback (the exploration
count they declare equals the runner's own default, so only the normal tier
changes). An explicit FC_RUNS overrides those defaults. Native cases have a 35/130 s Vitest
ceiling (normal/explore); Core/storage/attachment ceilings allow failure reporting
and teardown. The guides retain the exact per-family limitations. None claims all
microtasks, real network schedules, OS crashes, native feature parity or visual
correctness. Pi was introduced independently in #95 and is outside #92's specified
three-Harness property baseline; its native Handle and RPC transport now have
their own [#143 phase-3 baseline](pi-native-property-testing.md), which extends it
using the driver procedure below. Its public settings contract is covered by the
issue #143 phase-1 settings entry, which is a mock-only contract family rather
than a native Handle driver.

## Extending and changing contracts

For lifecycle authority, admission, cancellation or interaction changes, extend
`lifecycle.property.test.ts` at the public Handle/use-case seam and the relevant
owner-specific native driver. Keep historical races as mandatory skeletons.
For the phase-2 Report families, extend the file that owns the rule: Report field
parsing in `report-thread.property.test.ts`, visibility, ordering and counting in
`overview-selection.property.test.ts`, and the auto-archive rule, `ReportService`
and the `archive-report` command — with its role generator and its gated racers —
in `report-archive.property.test.ts`. Add a storage boundary to
`storage.property.test.ts` when the change touches what an archive commit makes
durable. For persistence/terminal publication, extend `storage.property.test.ts` and retain
real SQLite/Electron recovery; distinguish known rollback from lost COMMIT reply.
For attachment retention/release, extend the independent owner-set model and
service wiring regressions. For a Pi protocol or completion-boundary change,
extend `native-harness.property.test.ts` for public Handle terminal states and
`pi-rpc.property.test.ts` for record framing, request correlation, cancellation
or cleanup — never the in-process double alone, which cannot see transport
framing. Pure transforms belong in M1; directory sharing and native
generations belonged to the M4 directory pilot, whose suite was removed with
the OpenCode Harness. Update this inventory and the owning guide.

A new Harness adds its own scenario/fixture driver beside
`native-harness.property.test.ts`, importing only its owning package and public
contracts. Follow that file's `capture` adapter for public commits and projection,
then instantiate the real plugin/Handle with controlled native events. Generate
expected summaries/outcomes from fixture inputs; never decode another Harness's
sessionState in Core. Declare supported send/interrupt/respond/read/background
operations and exclusions rather than claiming provider parity. Exercise public
terminal projection, JSON round-trip, execution lookup, repeated disposal and
send-after-disposal rejection when supported. Scope each subprocess/subscription
and temporary directory to a sample and release in finally. Prove a meaningful
fault is detected, shrunk and replayed before counting the new family as covered.
No second provider registry, fake universal Handle or new lifecycle owner is needed.

The independent [Overview layout family](overview-layout-properties.md) verifies
the production pure packing solver: tiny exhaustive placement oracles, generated
histories and a complete unit-card frontier for unbounded column counts. Independent
swept-polygon and vacancy-connectivity oracles check straight-move certificates
and the absence of internal holes; finite-domain checks cover repair branches and
origin bounds, while budget properties check legal, monotone, idempotent partial
results. Floating search completion is distinct from exact distance proof. It runs
with `pnpm test:layout` and the normal property suite. These pure properties do not certify animation or camera behavior; renderer
integration has its own regressions linked in the layout guide.

## Cost and adopted boundary

Historical paired runs below are from the linked family evidence, on the local
Apple M1 Pro / arm64 Mac, Node 22.22.2 and pnpm 10.17.1. Commands, raw values,
versions and limitations remain there. They include Vitest startup, exclude
package generation/install and are not whole-verifier measurements. M2/M3a
measurements predate documented final fixture corrections; final PR verification
is separately linked below. Concurrent desktop activity was not isolated. Do not
sum these medians into an aggregate or imply an Effect speedup.

| Scope | Baseline seconds | Candidate seconds | Reported added wall time |
| --- | --- | --- | --- |
| M1 adjacent pure suites + properties | 2.155 / 2.157 / 2.459 | 3.436 / 3.429 / 3.327 | median difference 1.272 s |
| M2 adjacent lifecycle + Core/native properties | 5.465 / 4.734 / 5.326 | 24.293 / 23.732 / 35.240 | median difference 18.967 s |
| M3a adjacent storage + properties | 10.958 / 7.188 / 6.750 | 20.103 / 20.590 / 17.415 | median difference 12.915 s |
| M3b adjacent attachments + properties | 2.287 / 1.294 / 1.766 | 8.476 / 6.245 / 9.634 | median paired difference 6.189 s |
| Phase 2 whole property suite, with/without the three new files | 42.35 / 47.99 / 42.44 (12 files/51 tests) | 53.05 / 51.38 / 51.46 (15 files/80 tests) | median difference 9.02 s (same-round pairs 10.70 / 3.39 / 9.02) |
| Phase 3 whole property suite, with/without the new Pi file and family | 45.50 / 48.10 / 48.80 / 48.05 / 47.42 / 48.22 (15 files/80 tests) | 55.33 / 54.28 / 54.72 / 53.24 / 53.95 / 53.87 (16 files/86 tests) | median difference 6.04 s (median same-round pair +6.05 s) |
| Codex/claude pure families, whole property suite with/without the nine new files (final review) | 67.04 / 71.44 / 95.23 (16 files/100 tests) | 70.62 / 72.71 / 79.21 (25 files/125 tests) | median difference 1.27 s (same-round pairs 3.58 / 1.27 / -16.02) |

The Codex/claude row was remeasured after final local review: three baseline/candidate
pairs alternate in one sitting on the user's active Mac, with registry generation
and one Vitest process using `--maxWorkers=1` per leg. The baseline excludes only
the nine `codex-*.property.test.ts` / `claude-*.property.test.ts` files. Both legs
include `check.test.ts`: the baseline has 16 files / 100 tests and the candidate
25 files / 125 tests. Every test passed in every leg. The median difference is
1.27 s (same-round differences 3.58 / 1.27 / -16.02 s), within issue #143's
≤10 s-per-phase gate; the gate is read from these whole-suite legs.

The two edited Codex files also have three fresh per-file measurements, retaining
a 4.17 s maximum file-wall median across the recorded families (registry included).
Final Codex exploration runs passed all 14 tests in all three rounds at
9.77 / 9.61 / 12.30 s, median 9.77 s. Exploration uses 500 samples for the
three heavy state properties, 100 for the 200-turn property and 1000 elsewhere.
The unchanged Claude family retains its preceding 3.50 s exploration median
(4 files / 11 tests). Source hashes, raw-log hashes and the measurement inventory
are retained in the two evidence JSON files.

The [settings/command-input entry](harness-settings-property-testing.md) measured
the same property suite with and without its two files — 40.59/42.76/43.05 s
against 44.71/41.41/44.74 s, 12 files/51 tests — for a median difference of
+1.95 s against issue #143's ≤10 s-per-phase gate; the two files alone take 1.81 s
of Vitest wall time normally and 4.01 s at 1000 samples per property.

The [phase-2 entry](report-archive-property-testing.md) measured the same whole
property suite the same way — 42.35/47.99/42.44 s without its three files against
53.05/51.38/51.46 s with them — for a median difference of +9.02 s (same-round
pairs 10.70/3.39/9.02 s) against the same ≤10 s-per-phase gate; the three files
alone take 6.52 s of Vitest wall time normally and 56.09 s at their declared
exploration defaults. The archive family's sample count was reduced from 10 to 6
for that margin, and its detection evidence was re-captured afterwards. The same
method measured seven times for this phase has disagreed in both directions (median
differences from +3.62 s to +9.02 s on same-round pairs from -0.94 s to
+14.44 s, the widest round's slowest candidate run being the one outlier at
62.06 s), which is why the pairs are recorded
per round next to the median the gate is read from.

The [phase-3 entry](pi-native-property-testing.md) measured the same whole
property suite the same way — 45.50/48.10/48.80/48.05/47.42/48.22 s without its
file and family against 55.33/54.28/54.72/53.24/53.95/53.87 s with them — for a
median difference of +6.04 s against the same ≤10 s-per-phase gate; the
same-round pairs are +9.83/+6.18/+5.92/+5.19/+6.53/+5.65 s, median pair
+6.05 s. This is the one phase of the four whose capture was extended past three
pairs, because both legs of this suite move several seconds between captures: all
six pairs are reported, and an earlier three-pair capture of a previous revision
of these files read +10.43 s, so the three-sample median a short capture would
have read is a number two more samples can reverse on this machine. The
phase-3 additions alone measure 6.69 s of test-body time inside the sweep: the Pi
RPC file's five bodies sum to 6.47 s, plus 220 ms for the new Pi Handle family's
30 samples. The two are measured separately from the delivered revisions and
reported as their sum. The suite's own test-body total rose by 5.80 s between the
two medians, and the file that did not exist before accounts for more than that:
the fourteen unchanged files move +0.09 s in aggregate and the Handle family's
file reads −0.73 s even though it gained that 220 ms family, because its own runs
range over 11.73–14.40 s and that movement is larger than the addition — so the
attribution is the new file rather than a per-file growth this phase pays for
elsewhere. The baseline and candidate runs
alternate in the same window and absorb that window's load in both trees, which
is why the gate is read from the paired rounds. The RPC family's normal tier was
reduced from 10 to 8 samples (6 for the request bound) after the first sweep
showed real subprocess startup dominating, about 165 ms per sample in the
delivered tier.

M4 is the only actual Effect candidate comparison. Its [table and protocol](effect-directory-pilot.md)
record Promise/Effect startup 69.38/130.19 ms, RSS 74,481,664/142,475,264 B,
heap 9,775,424/15,834,680 B and Main 1,447,094/1,733,972 B. Deltas exceeded the
predeclared +50 ms, +15 MiB RSS, +5 MiB heap and +250 KiB Main gates. Request
scenarios stayed within +0.5 ms/operation; focused wall medians 1.25/1.24 s do not
establish a speedup. The candidate removed explicit deadline/controller plumbing
but retained ready/pending maps, waiter count and generation fencing; it added
Fiber conversion/invalidation reason (83→96 module lines). Compound failure and
invalidation diagnostics were also incomplete. These are project pilot results,
not general claims about Effect. All production Core/Harness/storage/shared-service
modules retain their existing Promise organization; no M5–M8 before/after data
exists and no runtime/IPC/persistence object was changed by M9.

M9 [current aggregate evidence](property-governance-evidence.json) records 28 passing
tests (26 behavioral properties plus two helper regressions): default seed 106
in 35.80 s; 30-sample, 60-command-cap exploration seeds 107/108 in 69.63/70.87 s.
Healthy stale-Stop replay passed in 2.49 s, and `pnpm codex:check` passed 36
architecture/API regressions. These are absolute Vitest wall observations from
source `87f44a7f`, not an additional before/after benchmark. The evidence records
commands, environment and actual log hashes; final candidate verification follows
on [PR #111](https://github.com/xinyuan0801/OpenAgent/pull/111).

## Parent AC1–AC7 disposition

This is an audit of the narrowed authorized scope, not a checkmark on the original
broad Effect target. Parent #92 stays open in this delivery; its owner may decide
closure only after reviewing applicable acceptance and the explicit exclusions.
M9's own current-head verification and review are published on its delivery PR.

| Parent criterion | Disposition and evidence |
| --- | --- |
| AC1 property coverage | Accepted within the specified domains: M1 transforms, M2 Core plus Codex/Claude/OpenCode (OpenCode since removed), M3a persistence, M3b ownership; inventory links concrete tests through their guides. Pi is outside that original three-provider scope. |
| AC2 counterexample quality | Accepted family evidence: JSON records exact mutations or real trial defect, shrunk inputs, seed/path, event order and versions. New production bugs are not inferred from deliberate mutations. Historical source/generator versions must be preserved for exact fault reproduction. |
| AC3 Effect adoption evidence | M4 decision gate delivered as **pause**. Original broad adoption and M5–M8 rewrite/equivalence evidence **not achieved**, removed from current plan; cancelled issue closure is no implementation evidence. |
| AC4 lifecycle | Existing Promise boundaries protected by M2/M4 generated authority/cancellation/background properties and native regressions. Broader Effect resource-scope rewriting is unimplemented, not certified by these bounded models. |
| AC5 single authority | Retained Core/Handle ownership, opaque sessionState and paired observation/revision, terminal durability; M2/M3a plus boundary regressions. No Fiber-based terminal inference, second authority or Effect IPC/JSON values introduced. |
| AC6 cost/governance | Bounded default/random exploration, configurable samples/sequence cap/seed, preserved replay and documented cleanup. Historical baseline/candidate costs above; M9 current aggregate run evidence is separate. No unmeasured M5–M8 gains or exhaustive leak/OS-schedule guarantee. |
| AC7 complete delivery | M1/M2/M3a/M3b/M4 merged as below. M9 is complete only after its exact candidate passes full verification, both review axes and delivery gate and is confirmed merged. Original cancelled rewrites remain incomplete; parent is not auto-closed. |

| Milestone | Confirmed merge SHA | Final delivery verification |
| --- | --- | --- |
| [M1 #94](https://github.com/xinyuan0801/OpenAgent/pull/94) | `1cde0b1d10fce517ed34f565640bbc63c10e03d8` | [candidate ddff64e3](https://github.com/xinyuan0801/OpenAgent/pull/94#issuecomment-5594893549) |
| [M2 #109](https://github.com/xinyuan0801/OpenAgent/pull/109) | `e35c4baa74b357b13132cbbf03401d90d7c7d588` | [candidate 7f179fbe](https://github.com/xinyuan0801/OpenAgent/pull/109#issuecomment-5595431406) |
| [M3a #107](https://github.com/xinyuan0801/OpenAgent/pull/107) | `7e4846fb3fa8799c94424082fa51c9ae45ae0d99` | [candidate 5bbe948c](https://github.com/xinyuan0801/OpenAgent/pull/107#issuecomment-5595580787) |
| [M3b #108](https://github.com/xinyuan0801/OpenAgent/pull/108) | `20b5b83df6c426cf12339aa9ee54fc7e1fc1884b` | [candidate 9122216c](https://github.com/xinyuan0801/OpenAgent/pull/108#issuecomment-5595168925) |
| [M4 #110](https://github.com/xinyuan0801/OpenAgent/pull/110) | `55e32c5201c909b1aa4481fa108d02c7baf86759` | [candidate 95b032ce](https://github.com/xinyuan0801/OpenAgent/pull/110#issuecomment-5595267027) |

Squash merge SHAs differ from the tested PR heads. These are final historical
verification records, not verification of M9; earlier interrupted/failed/stale
runs remain historical and are not relabeled as passing. M3a additionally retains
six real Electron/packaged SQLite recovery cases in its evidence JSON. No new
native protocol or persistence behavior is introduced by M9.
