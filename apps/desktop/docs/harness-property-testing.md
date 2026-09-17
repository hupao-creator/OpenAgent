# Native Harness property baseline (M2)

Current cross-family budgets, configurable command exploration, extension guidance and
parent acceptance: [M9 governance](property-governance.md).

Issue #96 specifies Codex, Claude and OpenCode; the OpenCode family was removed
with the OpenCode Harness itself. Pi was merged separately in #95 while this
delivery was in review and is outside that three-Harness baseline; its native
Handle and RPC transport have their own baseline in
[Pi native property tests](pi-native-property-testing.md) (#143 phase 3).

`tests/property/native-harness.property.test.ts` drives each real Harness Handle and
checks its public observation, JSON round-trip projection, historical execution
lookup, exactly one start/terminal transition, repeated disposal and rejection of
send after disposal. The file also hosts the Pi Handle family, which shares the
public assertions but replaces the native process with a module-mocked `startPiRpc`;
its driver is described in the Pi guide rather than in the table below. Expected terminal outcomes and summaries come from fixture
inputs, not decoding native state in Core. The shared capture adapter is a test
commit boundary; these tests do not substitute it for the production Core runtime
covered by the lifecycle property suite.

## Deliberately different drivers

| Harness | Actual production code exercised | Controlled native inputs and Handle calls | Limits |
| --- | --- | --- | --- |
| Codex | Main plugin, Thread Handle, runtime and app-server JSON-RPC subprocess transport | Existing fake app-server: initialize/start, approval request; generated input and execution ID; public waiting → respond allow-once or interrupt; completion/interruption; completed read through native fork; repeated dispose | Native fixture fixes answer and native IDs. OS scheduling and its 5 ms approval timer are observed via public waiting, not exhaustively permuted. No generated process kill/escalation, background work or invalid interaction payloads. |
| Claude | Main plugin, Thread controller, native stream-json subprocess transport | Dedicated `native-claude-fixture.cjs`: control initialization; generated UTF-8 text delta sequence; optional running background task snapshot before success/error result associated with user UUID; foreground terminal retains backgroundWork; send and repeated dispose | Generated failure is a native result, not an interrupt. No approval/respond, read, child process escalation, or background notification completion in this baseline. |

These are Harness-specific fixture drivers with shared public assertions, not a
single fake Handle reused under three names. The narrow inventory is intentional:
M2 establishes executable public-contract baselines; it does not claim provider
feature parity or exhaustive native schedules. Promise implementations and all
existing lifecycle owners remain unchanged.

## Budgets and replay

The M1 `checkAsync` helper supplies 30 cases per property by default. These native
drivers use its explicit 30-second per-property wall budget (120 seconds for
exploration), and still fail on interruption. Vitest allows five additional
seconds normally, ten during exploration, for failure reporting and teardown. Each generated case bounds
text to eight short chunks and disposal calls to four. `FC_RUNS`, `FC_SEED`,
`FC_PATH`, and the normal `test:properties:explore`/`test:properties:replay` scripts
remain the common interface. Normal `pnpm test` and full verification discover
these properties. Native subprocess startup contributes to the budget; a timed
out property is not reported as a pass. A measured four-worker run under concurrent
Core exploration exhausted the original 10-second budget at 20/30 Codex and 24/30
Claude cases. Both correctly failed; the explicit 30-second native budget retains
the 30-case coverage with headroom for this observed load.

Event order is reproducible from the generated object: open → send → native
session/deltas → optional Claude background snapshot → chosen result (or waiting → respond/interrupt for Codex) →
terminal projection/lookup → repeated dispose → rejected send. Chunks retain their generated array order. Subprocess pipe delivery and OS
process teardown are not under a deterministic scheduler; no claim is made about
all microtask or OS orderings.

The OpenCode transport-fault entries in that evidence file are historical: the
fault seam and its property test were removed with the OpenCode Harness, so the
recorded fault, replay and clean-replay commands no longer reproduce against the
current tree. The same evidence file also records separate Codex and Claude property-family
mutation runs. For each, the production session-state adapter's `resolveExecution`
return for a known execution was temporarily replaced with `null`; its native
Handle still ran through the real fixture before the independent lookup assertion
failed. Each mutant was detected, shrunk, replayed with its recorded seed/path,
then removed by restoring the exact original source bytes (SHA-256 recorded).
The same replay passed after restoration. These production mutations are not
retained as runtime switches.

## Claude pure families (transport framing, persistence contract, accounting)

Beside the native Handle family above, `tests/property/claude-*.property.test.ts`
adds four pure in-memory families that drive harness-claude source and the shared
plugin-kit JSON Lines framer. They keep the pure sample budget (100 normal / 1000
exploration per property through the shared `check`/`checkAsync` helpers; no native subprocess, storage or OS
schedule is involved):

| File and property | Production code exercised | Generated domain and mandatory probes | Exclusions |
| --- | --- | --- | --- |
| `claude-jsonlines.property.test.ts` — chunk boundary assembly | `JsonLines` (`packages/openagent-plugin-kit/src/main/json-lines.ts`, imported through `@openagent/plugin-kit/main`) | Any line sequence (blank lines, CRLF, multi-byte UTF-8, U+2028, no trailing newline, final half-line) × any byte-chunk plan; whole-buffer, generated plans and byte-at-a-time push must all emit the reference framing. Opens with a mandatory example that pushes 中🙂文 one byte at a time and one mixing a CRLF-terminated line, a blank line and an unterminated half-line, with plans that cut between the `\r` and `\n` bytes. | Invalid UTF-8 and decoder replacement characters are not generated; the oracle decodes the whole byte stream at once. |
| `claude-state.property.test.ts` — encode/decode/parse round trip, bounded helpers, runtime clipping, parser fail-closed sweep, selectors | `parseClaudeThreadState`/`CLAUDE_STATE_LIMITS`/selectors (`shared/state.ts`), `boundedRuntime`/`encodeClaudeThreadState`/`decodeClaudeMainState` (`main/thread/state.ts`), timeline pure functions (`main/thread/timeline.ts`), `appendBounded`/`truncate` (`main/thread/values.ts`) | Generated event/delta sequences (text/reasoning deltas with per-message interleave, activity/interaction upserts, notices, plans, provisional/settled usage, settle with background ids) drive the same pure timeline composition the controller applies per native event; the produced state must pass `parseClaudeThreadState` unchanged across a JSON storage round trip, carry no NUL, unique non-regressing timeline ids, all lengths within `CLAUDE_STATE_LIMITS` and turn text equal to the tail-retained delta concatenation. A dedicated property drives the shared `appendBounded`/`truncate` helpers with generated previous/next strings and bounds, asserting tail retention for the former and NUL-stripped head keeping with the `…` marker for the latter, and runs a mandatory overflowing probe (previous `aaaaaaaaaaa`, next `zzzz`, bound 5) before any generated draw, so a helper that starts keeping the head fails on every run rather than only when a draw happens to exceed its bound with distinct ends. A dedicated property generates runtime strings whose `minLength` exceeds each persisted bound and asserts the exact clipped form (NUL-stripped, head kept, `…` marker) and bound on every run, for every string the runtime carries: model/cwd/claudeVersion/permissionMode/effort, capabilities and skills (2000) and command argument hints (2000), model/agent/command/MCP-server/background-task names (1000 and 512) and descriptions (8000), plugin name/path/version (1000/4096/256), MCP status and background-task type/status (256), and the remote-control URLs and environment id (8192). A further property forces the capability-count bound: it generates a list of `CLAUDE_STATE_LIMITS.runtimeCapabilities + 1..24` entries and asserts the persisted runtime keeps exactly the first 512, so a dropped slice fails on the first sample. A second, deterministic test sweeps all 22 single-field mutants of a valid state (unknown keys, illegal enums, duplicate activity/attachment/timeline ids, timestamp regressions, out-of-range prompt references, NUL text) and requires the parser to refuse every one of them by name; the sweep is exhaustive by construction, so a guard that goes missing cannot hide behind an unvisited sample. | The mutant sweep enumerates single-field mutants rather than generating arbitrary malformed states; interaction `input`/`schema` JSON bounds are validated by production code but not adversarially generated here. |
| `claude-settle-usage.property.test.ts` — settle idempotence and terminalization; usage ledger; model-cost deltas | `settleClaudeTurn`/`mergeClaudeTurnUsage`/`applyClaudeUsageSample` (`main/thread/timeline.ts`), `claudeModelCostEvents` (`main/runtime/transport.ts`) | Generated activities/interactions/streams with a small id pool (upserts and background exemptions are common); settle must terminalize exactly the running work outside the background set, cancel pending interactions exactly once (one `settled:` snapshot each), and a second settle with different inputs must leave the frozen turn unchanged. Usage events fold one ledger entry per generationId with provisional snapshots visible-only; the ledger property drives `applyClaudeUsageSample` — the production accounting seam the controller calls — rather than reimplementing the dedupe/provisional/settled rules, so a dropped guard in that seam fails the property; it advances an independent pending/recorded expectation from the generated events at every prefix and checks the projection's pending map, the dedupe flag and the settled projection against it, so a blanked provisional snapshot that keeps every derived shape intact is caught by the visible total built from the events rather than from the projection under test. The settled projection and the visible total are compared as whole objects (additive keys plus the last context window) against an independent expectation, so a field leaked into either by the merge is rejected even though no per-key check looks for it. ModelUsage frames (rollbacks, zeros, fresh model keys) must emit positive rebased deltas summing to final − initial with no repeated generationId. Mandatory examples cover duplicate generation ids, a rollback/regrowth cost trajectory, and a summary event carrying a token field beside its cost. | The controller's telemetry ledger sink and generation-id derivation are modeled, not executed; no real ledger records are written. |
| `claude-bart-usage.property.test.ts` — telemetry window invariants | `normalizeClaudeBartTelemetry` (`bart/usage.ts`) and the shared telemetry policy | Tagged raw get_usage payloads (recognized and unknown window ids, case variants, invalid utilization/reset shapes, model-scoped entries) with an oracle that decides validity independently of the parser: every emitted window matches the expected id/label/scope/selector, `usedPercent` is the rounded non-negative draw, `remainingPercent == max(0, 100 − used)` rounded, `exhausted == (used >= 100)`, scope/duration consistent with the id, `limitReached` follows the provider-window rule, and no recognizable window at all degrades to `availability: 'unknown'` with no invented windows. | Pace projection is only implication-checked (pace present requires usable percent/duration/reset); DeepSeek balance normalization has its own non-property coverage. |

Mutations recorded for the delivered families live in
[claude-property-evidence.json](claude-property-evidence.json): the JsonLines
decoder swapped to `latin1` (caught by the mandatory multi-byte example), an
`appendBounded` head-retention regression, removal of the `settleClaudeTurn`
idempotence guard, a window-guard `&&`→`||` that dropped recognizable Bart
windows, removal of the persisted-state parser's duplicate timeline-id guard
(detected by the exhaustive fail-closed sweep, whose failure names the accepted
mutant; as a deterministic sweep it has no fast-check seed to shrink), removal
of `applyClaudeUsageSample`'s per-generation dedupe guard (caught by the
production-seam ledger property on the first generated sample), and five that pin
the review fixes: a `JsonLines` framer split on `\n` alone, ignoring CRLF
(caught by the mandatory CRLF example on every run rather than only when a
generated entry happens to end with one), a `boundedRuntime` that stopped
clipping the model field to its 512-character persisted bound (caught by the
over-limit runtime property on the first sample), and a settled-usage merge whose
summary family was widened to admit token fields (a summary sample's
`inputTokens` leaks into the visible total, 157 against the independent 150; the
previous per-key loop never looked for keys the expectation did not list, so the
complete-object comparison is what rejects it). The last two are the follow-up
probes: dropping the capability slice in the persisted runtime (the over-length
capability property generates a list past the 512-entry bound, so the persisted
runtime keeps the whole list instead of the first 512 and the count assertion
fails on the first sample), and blanking a provisional pending snapshot to `{}`
in `applyClaudeUsageSample` — the projection shape, the settled projection and
the ledger all stay right, so only the visible total derived from the generated
events rejects it (the summary snapshot carries a token field and a cost that
must appear while the generation is in flight). Each was detected, replayed at
its recorded seed/path (the deterministic sweep excepted), and removed by
restoring the exact original source bytes (SHA-256 verified against the
pre-mutation digest); the same replay passed after restoration. Replay uses the
shared `FC_RUNS`/`FC_SEED`/`FC_PATH` + `pnpm test:properties:replay` interface,
and selects tests by the outer `it()` title: every `check`/`checkAsync` property
name in these files equals its `it()` title, so the inner name the helper emits
into the replay command and the recorded selector are the same string. An inner
name that was not a substring of its `it()` title would make `-t` select nothing
and the emitted replay cleanly pass — earlier revisions of these files had that
shape. The recorded `propertySha256` values are the hashes of the delivered
files at capture time, so any later edit to a property file invalidates the
evidence and it must be recaptured.

## Codex pure families (persistence reducer, framing, interaction matrix, accounting)

Beside the native Handle family above, `tests/property/codex-*.property.test.ts`
adds five pure in-memory families that drive harness-codex source and the shared
plugin-kit JSON Lines framer.
Sample tiers: codex-state's three
heaviest properties keep 50 normal / 500 exploration (reduced from the 100/1000
pure tier after a measured whole-suite with/without median difference of 10.08 s
exceeded the ≤10 s-per-phase gate), its 200-turn truncation window keeps 30/100
because each sample stages MAX_TURNS + 1 rounds, and the other four files keep
100 normal / 1000 exploration; no native subprocess, storage or OS schedule is
involved:

| File and property | Production code exercised | Generated domain and mandatory probes | Exclusions |
| --- | --- | --- | --- |
| `codex-state.property.test.ts` — reducer-cluster oracle, truncation, delta-batch equivalence | Reducer cluster and `isCodexState`/`decodeCodexState` (`shared/state.ts`), `codexSessionState` project/resolve/settle (`shared/session-state.ts`), the production `mergeDeltaEvents` (`main/thread/thread-handle.ts`) | Generated rounds of stage → native events (text/reasoning deltas, plans up to 230 steps, activities, interactions, usage, warnings, done, session) plus follow-ups, rejections, native-activity and background operations, then settle or orphan-settle; every intermediate state must pass the validator, keep `updatedAt` strictly increasing, cap turns at 200, carry unique timeline references and survive a JSON round trip that `project` accepts. Separate properties pin the 200-turn tail window, the documented `…\n` + suffix truncation for oversized reasoning/error/answer text, and the equivalence of the production delta-batch merge with per-delta reduction. A mandatory 230-step plan example pins the reducer's 200-step head-keeping plan slice, which the generated domain alone would never reach, and mandatory entity-lifecycle examples open an activity, an interaction and a Primary Session so each close/progress event can be retargeted at the live entity it closes (a running activity for `activity-end`/`activity-update`, a pending blocking interaction for `interaction-closed`) and the resulting status change asserted — closing the last blocking interaction must resume the turn from `waiting-input`, derived from the pre-state and the closed id rather than read off the result, so a dropped resume transition fails even though the resolution itself is still persisted. The targeted examples also pin the effect details the generic invariants cannot see: an `activity-update` must stamp the turn's `updatedAt`, an `activity-end` must leave its live target terminalized rather than removed, an `interaction-closed` must persist the resolution's exact status (an eight-entry map, not one flattened status), and a `done` must settle former streaming assistant items to its outcome's status; mandatory resolution and outcome examples rewind single steps of the entity-lifecycle scenario so each of those mappings runs on every execution. The session branch additionally asserts the accepted event's binding directly, because that binding is the event's only observable effect and `observe` skips the monotonicity check when the reducer returns the prior object. Every native event is checked against a per-event expected effect derived from the pre-state before the generic invariants, so a reducer branch that silently returns the prior state fails here. | Free text excludes NUL (validator refuses it on load); a conflicting Primary Session binding is mirrored, not generated; post-terminal native traffic is dropped by the driver as the reducer does. |
| `codex-jsonlines.property.test.ts` — chunk boundary independence | `JsonLines` (`packages/openagent-plugin-kit/src/main/json-lines.ts`, imported through `@openagent/plugin-kit/main`) | Any line sequence (blank lines, CRLF, multi-byte UTF-8, U+2028/2029, no trailing newline) × any byte-cut plan, whole-buffer baseline included; opens with a mandatory example that pushes 中🙂文 one byte at a time through an unterminated stream. | Invalid UTF-8 and decoder replacement behavior are not generated; the oracle takes interior lines verbatim and trims only the unterminated tail. |
| `codex-interaction.property.test.ts` — decision matrix, decline isomorphism, form round trip, public option ids | `parseInteraction`/`encodeInteractionResponse`/`defaultInteractionDecline`/`nativeQuestionAnswers` (`main/runtime/app-server.ts`), `nativeCodexInteractionResponse`/public ids (`main/thread/thread-handle.ts`, `shared/public-interactions.ts`), `assertCodexInteractionAdmission` (`shared/interaction-admission.ts`) | Every generated native request of the five methods must clear admission unchanged (question ids stay distinct inside one request, because the public contract requires unique question ids and the native side keys its answers by id), every advertised action must encode into its kind's wire union (approval decisions, permissions scopes, user-input answers, elicitation actions), and each admitted interaction's advertised action ids must equal an independently declared expected set for that method (commandExecution/fileChange approvals: allow-once, allow-session, deny, cancel; permissions approval: allow-once, allow-session, deny; tool requestUserInput: submit, cancel; mcpServer elicitation: submit, deny, cancel) — so losing a decision fails even though every remaining action still encodes. The timeout decline must equal the encoded cancel (or deny) action wire for every kind, MCP form answers must round-trip JSON-parse → accepted content object with error paths pinned, and public option ids must translate back to native ids (free text through) with the wire labels matching `nativeQuestionAnswers`. Mandatory examples open one sample per native method. | URL elicitations without a URL throw at parse time and are skipped as outside the honest domain; one native question id repeated inside a single request cannot be projected to the public contract, so admission refuses it fail-closed and the generator keeps ids distinct rather than asserting on a payload the native side never sends; wire shapes beyond the documented unions are not enumerated. |
| `codex-bart-usage.property.test.ts` — telemetry window invariants, fail-closed paths | `normalizeCodexBartTelemetry`/`createCodexBartTelemetryContributor` (`bart/usage.ts`) and the shared telemetry policy | Provider/model id spaces that may overlap (the primary bucket is insert-only, so a dictionary bucket carrying the same id stays authoritative) with a mandatory overlap example carrying one id in both places with distinguishable quotas (`usedPercent` 11 against the primary's 88) so that precedence runs on every execution, a second mandatory example in which the shadowing dictionary bucket carries the reach flag and no window at all, and generated windows including boundary and >100 percentages, invalid negatives, positive/zero/negative/NaN/Infinity durations and ISO/numeric/garbage/empty resets: the emitted window set must equal the input-derived one (dictionary later-wins merge, primary insert-only), every window's `usedPercent` equals its input-derived rounded-or-rejected value, its `durationMinutes` the positive-or-omitted one and its `resetsAt` the ISO form of the raw reset (omitted when the raw value names none), `remainingPercent == round(max(0, 100 − usedPercent))`, `exhausted == (usedPercent >= 100)`, scope/selector pairing follows the provider id, `limitReached` folds provider exhaustion and the explicit-reach flag read out of the resolved bucket map (a shadowing dictionary bucket contributes its own provider-scoped flags, and a frame with no recognizable window reports the explicit reach instead of that fold), availability is 'available' exactly when windows survive, and reader errors or garbage payloads never report available capacity. | Pace projection is not asserted; label composition beyond non-emptiness is out of scope. |
| `codex-tool-identity.property.test.ts` — identity hash invariance | `toolConfigurationIdentity`/`canonicalJson` (`main/thread/thread-handle.ts`) | Generated nested JSON values and tool bindings with distinct names: key-order permutations recurse through every nested object and array, so the canonical string and the identity hash survive reversing inner key orders rather than only the top level, binding permutations leave the hash unchanged, while renames and tool-mode flips are detected; undefined/untooled injections yield an undefined identity. Mandatory examples supply a nested object with reversed inner keys and a two-binding tool with swapped bindings, so the two-binding swap runs on every execution instead of only when a generated injection happens to carry two distinct names. | Keys stay in a safe ASCII range (localeCompare ties would re-expose insertion order); duplicate binding names are excluded for the same reason. |

Mutations recorded for the delivered families live in
[codex-property-evidence.json](codex-property-evidence.json): a head-keeping
turns truncation in `stageCodexExecution`, dropping the `JsonLines` CRLF
alternative, replacing the approval timeout fallback `cancel` with `decline`
(caught by the mandatory decline-isomorphism example), accepting negative
`usedPercent` values in `percentValue`, removing the identity's name sort, and
turning the `usage` event into a no-op in the state reducer (caught because the
model oracle asserts each event's effect on the turn rather than only the
end-state validity). Ten further mutations pin the review fixes: dropping the plan reducer's
200-step slice fails on the mandatory 230-step plan example, which the generated
domain never reaches, and dropping `allow-session` from `CODEX_APPROVAL_ACTIONS`
fails on the independently declared expected action set per method (every
remaining action still encodes, so nothing else notices). A `percentValue`
returning a constant zero is caught only
by the input-derived percentage comparison — the downstream rounding, remaining
and exhaustion assertions all stay satisfied — and the mandatory overlap
example now detects it without shrinking. A
production `mergeDeltaEvents` that keeps the buffered delta and drops the newer
one under the same entity fails the batch-versus-sequential equivalence now
driven through the production batcher. The remaining two make the driver's
targeted probes fail: a session branch that accepts a native session event and
returns the prior state is invisible to every invariant — the binding
comparison is the only thing that rejects it — and a reducer matching
`activity-end` against a stale activity id never terminalizes the activity it
closes, which the mandatory entity-lifecycle example exposes because it names
the running activity the following event closes (without that example no
generated plan reliably closes the activity the driver picked). The last four
drop effect details that the generic invariants cannot see: an `activity-update`
that returns the prior turn without stamping `updatedAt` keeps every invariant
satisfied, because the target survives and only the timestamp assertion notices
the turn never moved; an `activity-end` that filters the target out of the
activity list instead of terminalizing it leaves a valid but wrong turn, and the
target-survival assertion on the mandatory example is what rejects it; an
`interaction-closed` that persists every resolution as one flat status passes
the shape checks, so the exact per-resolution status map is what fails it; and a
`done` event that ignores its outcome marks every previously streaming assistant
item complete, which only the settlement assertion compares
against the outcome-specific expectation. Each was detected, replayed at its
recorded seed/path, and removed by restoring the exact
original source bytes (SHA-256 verified against the pre-mutation digest); the
same replay passed after restoration. Replay uses the shared
`FC_RUNS`/`FC_SEED`/`FC_PATH` + `pnpm test:properties:replay` interface, and
selects tests by the outer `it()` title: every `check`/`checkAsync` property name
in these files equals its `it()` title, so the inner name the helper emits into
the replay command and the recorded selector are the same string. An inner name
that was not a substring of its `it()` title would make `-t` select nothing and
the emitted replay cleanly pass — earlier revisions of these files had that
shape. The recorded `propertySha256` values are the hashes of the delivered files
at capture time, so any later edit to a property file invalidates the evidence
and it must be recaptured.

Three additional mutations bring the Codex evidence to nineteen: dropping
explicit provider reach when no window survives; retaining the head of oversized
text instead of its suffix; and misclassifying a model bucket as feature scope.
The text property ends its reasoning, error and answer payloads with distinct
`R`/`E`/`A` characters, so head retention cannot match its expected suffix.
The telemetry property checks the exact provider/model scope and derives the
selector from the input bucket's name or id; a mandatory example includes both
named and unnamed model buckets. Final local review recaptured all twelve
existing mutations tied to the two edited property files and the two new
mutations, including failing replay and passing replay after byte-exact restore.

The Codex and Claude transports both import `JsonLines` from
`@openagent/plugin-kit/main`; plugin-kit owns the provider-neutral framing
implementation, without a cross-harness dependency. Both property families keep
their independent oracles and generated domains against that shared class.

The `jsonLinesRecapture` section in each evidence file records the relocated
source and edited property hashes, capture environment and raw log directory.
It supersedes the older capture metadata for JSON Lines only; unrelated mutation
records keep their original provenance. All three JSON Lines mutations (Claude
UTF-8 and CRLF, Codex CRLF) were detected and replayed against the shared source,
then the same replay passed after byte-exact source restoration.

Because the public package import resolves built output, run
`pnpm --dir packages/openagent-plugin-kit run build` after applying a JSON Lines
source mutation and again after restoring it, before the evidence file's
`mutationDetect` or `mutationReplay` command. This ensures the test executes the
mutated or restored source rather than a stale `dist` copy.
