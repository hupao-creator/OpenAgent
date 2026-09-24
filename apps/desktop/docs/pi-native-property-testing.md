# Pi native Handle and RPC transport properties (Issue #143 phase 3)

Historical phase 3 record: the 2026-09-24 quality cleanup removed all five RPC
transport properties and their `fake-pi-rpc.mjs` fixture. The native Handle
property remains. See [governance](property-governance.md) for the current suite.

Current suite: fixed example injection has been removed from `checkAsync`.
Sample budgets now count generated inputs only. Generated properties, shrinking
and replay remain; coverage of an individual mode depends on the generated draw.
The mutation results and replay coordinates below are historical evidence from
before this cleanup, including references to mandatory examples. They must be
recaptured against the current generators before being used as current evidence.

Current cross-family budgets, configurable exploration and parent acceptance:
[M9 governance](property-governance.md). Fault evidence:
[pi-native-property-evidence.json](pi-native-property-evidence.json).

These properties protect the two Pi seams that decide when an Execution is over
and how a native record becomes a correlated response. They change no production
code. The Handle family drives the real [`openPiThread`](../../../packages/harness-pi/src/main/thread/handle.ts)
against an in-process process double; the transport family drives the real
[`startPiRpc`](../../../packages/harness-pi/src/main/runtime/rpc.ts) against a real
child process. Neither family substitutes for the other: the in-process double
cannot see record framing, and the transport family has no Thread or public
observation.

Pi's native Handle was merged in #95 and had no property baseline; issue #92
specified only Codex, Claude and OpenCode. This is that baseline for Pi, added
without changing the #92 families in
[the native Harness guide](harness-property-testing.md).

## The completion boundary

The production boundary is `agent_settled`, not `agent_end`. The Handle family
asserts that boundary directly, because a Pi turn can end while the Execution is
still retrying, and a retry sequence can end while the session is still working:

| Generated finish | Native traffic before the terminal state | Public outcome |
| --- | --- | --- |
| `settled` | assistant `message_end` (`stop`), `agent_end { willRetry: false }` | `completed` with the answer as summary |
| `settled-error` | assistant `message_end` (`error`, `errorMessage`), `agent_end { willRetry: false }` | `failed` with the native error message |
| `settled-aborted` | assistant `message_end` (`aborted`), `agent_end { willRetry: false }` | `interrupted`, with the turn's text as summary when it emitted one |
| `interrupt` | caller `interrupt()` | `interrupted` |
| `process-failure` | native `onFailure` (`Pi RPC process exited`) | `failed` |
| `extension-failure` | `extension_error` event | `failed` with `Pi extension failed: …` |

The terminal Execution is summarised by the last assistant text the Handle saw —
the turn's answer on a settled path (including the aborted one, which still
delivers an answer), otherwise the last retry's message — and the field is
omitted when that text is empty. The property asserts all three states: the
answer, the retry text, and expected absence for an empty answer.

Every generated retry attempt (0–3 of them) emits an assistant error message, an
`agent_end { willRetry: true }` and an `auto_retry_start`, and the sample asserts
after each one that the public Execution is still `running`. The `settled` legs
then emit a final `agent_end { willRetry: false }` and assert the Execution is
*still* `running` before `agent_settled` arrives. That assertion is what the
"treats `agent_end` as completion" fault trips (see below).

## The programmable process double

`fake-pi-rpc.mjs` already served the Pi RPC example regressions. Phase 3 makes it
programmable per command instead of per spawn, so one connection can carry many
framings and orderings:

- `chunked` splits one emitted record at generated **byte** sizes (UTF-8 aware,
  cycling a generated size list, optional CRLF), so a record boundary lands in
  the middle of a multi-byte character or a surrogate escape. Writes issued in
  the same turn of the event loop are coalesced into a single pipe read, so each
  chunk waits for its write to drain, and the double additionally yields a real
  timer once per record at the first boundary that falls **inside** a multi-byte
  sequence: that is the boundary a decoder can see, and the read after it begins
  with a UTF-8 continuation byte, which is what "the character reached the
  reader in separate chunks" means observably. Measured on a reader attached to
  the same fixture and the same kind of pipe, twenty runs of each revision
  delivered that boundary separately 20/20 times after the change and 19/20
  before it — the pre-fix fixture's separation is a scheduler race, so it can
  hide the split, which is the case the mutation below cannot see. The probe,
  its twenty-run logs for both revisions and the discarded every-boundary
  sweep's log are [recorded with their hashes](pi-native-property-evidence.json)
  under `chunkBoundarySeparation`. Yielding at
  *every* interior boundary instead costs about 2 ms per boundary, which took
  this family's chunk-assembly property from about 1.3 s to 4.3 s — enough to
  push a sweep pair over the ≤10 s gate — so the guarantee is scoped to the
  boundary that matters rather than to every boundary the generator draws.
  Commands are handled one at a time so a reply's records keep their emitted
  order while a reply awaits between its own chunks.
- `echo` replies with a generated raw string, holding the reply (`hold`),
  chunking it (`split`) or terminating with CRLF (`crlf`) — the same command
  carries a different framing each time. `event` frames a non-response record
  (`extension_ui_request`) the same way, with the caller's text in the payload,
  so events are reassembled across generated chunk boundaries too, not only
  correlated responses.
- `release` emits every held reply in a generated order (`forward`, `reverse`,
  `alternate`), so response arrival order is the fixture's choice, not the
  caller's.
- `forge` emits a `response` for an arbitrary id. A response only means anything
  on stdout, so the test cannot forge one by writing it — the double emits it and
  the reader is what decides whether an unknown id is dropped.
- `halt` (exit 3), `break` (stdout end), `truncate` (partial record then end),
  `invalid` (non-JSON), `oversized` (one byte past the 8 MB cap), `reject`
  (`success: false`) and `hang` (no reply) cover the failure modes.
- `PI_RPC_FIXTURE_EXIT_MARKER` makes the double write a marker file in its
  `exit` hook, so a test can prove the process reached its own terminal state
  rather than assuming it from the parent's side.

The `--version` branch answers the 0.83 execFile probe without a session.

## What each property asserts

| Property | Generated domain | Assertion |
| --- | --- | --- |
| `pi rpc assembles records identically under generated chunk boundaries` | raw multi-byte text (BMP, astral, combining, U+2028), a spawn-time handshake chunk plan and 2–4 per-request chunk plans, CRLF or LF | every echo returns exactly the generated text; an `extension_ui_request` carrying the same generated text arrives once per request and unchanged under every plan; a final unchunked request still correlates on the same connection |
| `pi rpc correlates out-of-order responses to their own requests` | 3–5 unique held values, a release order, up to 3 ids the double forges a `response` for | each request resolves with *its own* value, the **arrival** order equals the generated order and is asserted to differ from the request order, and a response for an id the adapter never issued is dropped instead of surfacing as an event |
| `pi rpc cancels only the requested work and keeps the session usable` | 2–5 entries, each held and independently cancelled | cancelled requests reject with `cancelled`, others resolve with their own value, no failure is reported, a later request still works, and aborting an already-answered request leaves its value intact |
| `pi rpc ends pending work and releases its process for every failure mode` | a generated choice among eight modes (`exit`, `halt`, `invalid`, `oversized`, `break`, `truncate`, `dispose`, `context-abort`), 1–3 pending requests, 2–4 disposals | every pending request rejects without leaking native text, the triggering command ends too, failures are reported exactly once (`dispose` reports none), the failure released the process on its own (the marker reads `exited` before the property disposes), no pending request bound survives (the virtual timer registry is empty once that disposal settles), and repeated disposal and late request/write reject |
| `pi rpc bounds silent requests and releases the pending set` | 1–3 silent requests, 2–4 disposals | after a virtual 30 s advance every request rejects with `timed out`, one failure is reported, late requests reject, and the double still exits |

The Handle property (`native Pi public Handle and projection contract`) uses the
shared `capture`/`assertTerminal` helpers from
[the native Harness guide](harness-property-testing.md): one `started` and one
`terminal` lifecycle change with the generated execution ID, JSON round-trip
projection through `piSessionAdapter`, historical lookup of the settled
Execution and `null` for an unknown ID. The terminal summary is asserted in all
three of its states — the turn's answer on a settled path, including an aborted
one, the last retry's message where no answer was delivered, and expected
*absence* when that text is empty — so an empty answer and a terminal path with
no assistant text cannot pass by leaving the field unchecked. After the terminal state it emits a late
`agent_end`, `message_end`, `tool_execution_end` and a second `agent_settled`,
performs a public read, disposes repeatedly and asserts the record is byte-equal
to the pre-late-traffic snapshot and that send after disposal rejects. The double
counts its own `dispose` calls, and the property asserts exactly one after the
repeated public disposals: the Handle must release the native connection, not
only fence itself. Terminal modes, retries and empty answers are generated;
there is no fixed prefix requiring each combination on every run.

The failure-mode property makes its two cleanup claims the same way — through an
observation the report itself cannot supply. Its rejects, its failure count and
its repeated disposals all settle identically whether or not the failure path
cleaned up behind them, so the property reads the cleanup instead. It holds the
virtual clock while it does, which makes each pending request's 30 s bound a
fake timer: once the disposal the failure started has itself settled, a live
request bound is the only timer that can still be registered, and the property
asserts the registry is empty (`rpc-fails-without-clearing-pending-bounds`
below). The process claim is ordered the other way round: the double's exit
marker is asserted *before* the property issues any disposal of its own, because
every later disposal would release the process whether or not the failure did
(`rpc-failure-does-not-release-its-process`). That poll runs on the real clock
the file captured before any fake one was installed, since the timers under test
are virtual. The `dispose` mode is the one case where a caller disposal is the
terminal, and it reads the same assertions the other seven do.

## Budgets, isolation and commands

Both files use the shared `checkAsync` helper and its 30 s per-property wall
budget (120 s exploration) with the 35 s / 130 s Vitest ceilings. The Handle
family declares `{ normal: 30, explore: 100 }`; each RPC property declares
`{ normal: 8, explore: 60 }` except the request bound, which keeps
`{ normal: 6, explore: 30 }` because its virtual advance costs more than the
other RPC properties, and the failure-mode property, which declares
`{ normal: 12, explore: 60 }`. Subprocess startup, not case count, dominates the
RPC families, which is why their normal tier is 8 rather than 30.

`checkAsync` spends the full sample budget on generated values. No fixed examples
run ahead of them; a small debug budget can miss modes or combinations.

Every sample owns its temporary directory and its connection, and closes both
itself: the RPC file's `connect()` returns a `close` that disposes the
connection and removes the root it created, and each property body calls it from
a `finally`. A `connect()` that throws removes the root it made. A sample that
fails or throws therefore releases its child process before the next sample
starts. An *interrupted* sample is the one case where that is not enough: the
wall-clock budget is enforced by racing the property against a timer
(fast-check's `SkipAfterProperty`), so when the budget expires the abandoned
sample is neither cancelled nor awaited and a body blocked past it never reaches
its own `finally`. `afterEach` is the safety net for exactly that path — it
drains any connection whose sample did not close it, and is empty on ordinary
runs. The entry stays registered until the disposal and the root removal have
both finished rather than being dropped when a `close` starts, because the
abandoned sample this net exists for is one blocked *inside* that disposal: an
entry removed on entry would leave `afterEach` with nothing to await and let the
test finish over a live child. The returned promise is memoised, so the
sample's own `finally` and the net's drain share one closure instead of racing
two. A property that would hang is a failed property:
`settledWithin` races the controlled work against a 5 s guard and reports
"controlled work did not settle", which is what the disposal fault below trips.
That guard runs on the real clock in every property, including the two that
install Vitest fake timers: `globalThis.setTimeout` is captured at module load,
before any fake one exists, so a timer made through that reference is genuine.
The fake timers here never auto-advance, so a guard built on the virtual clock
could never fire at all — a hung sample would surface as a budget overrun rather
than as the failure it is. The timeout property enables its fake timers
*after* the handshake (fast-check binds its own clock at import) and returns to
real timers before disposal, because an advanced virtual clock would escalate to
`SIGKILL` before the double can run its own exit path.

```
pnpm test:properties -- -t 'pi rpc'
```

`FC_RUNS`, `FC_SEED`, `FC_PATH`, `pnpm test:properties:explore` and
`pnpm test:properties:replay` are the same common interface as the other
families, and normal `pnpm test` discovers both files.

## Fault detection, shrinking and replay

Nine temporary production mutations were applied one at a time, detected by the
delivered properties, shrunk, replayed at the recorded seed and path, and then
removed by restoring the original bytes (`git status --porcelain` empty for
`apps/desktop/src` and `packages` afterwards, and the restored tree passes its
whole property suite, 16 files / 86 tests).

| Fault | Production edit | Detection |
| --- | --- | --- |
| `handle-settles-on-agent-end` | `handle.ts` treats `agent_end` as the settlement event | `AssertionError: retrying agent_end: expected 'failed' to be 'running'`, seed -1146108822, path `0`, 0 shrink steps, replay at 0 |
| `rpc-drops-per-request-abort` | `rpc.ts` no longer registers the caller's abort listener on a pending request | `AssertionError: expected 'fulfilled' to be 'rejected'`, seed 1277439374, path `0`, 0 shrink steps, replay at 0 |
| `dispose-leaves-pending-work-pending` | `rpc.ts` `dispose` sets the failure but no longer rejects or clears the pending map | `Error: dispose pending requests: controlled work did not settle`, seed 770700095, path `6`, 0 shrink steps, replay at 0 |
| `rpc-delivers-response-for-unknown-id` | `rpc.ts` broadcasts a `response` whose id matches no pending request to the event listeners instead of dropping it | `AssertionError: expected [ { type: 'response', …(3) } ] to deeply equal []`, seed 215905466, path `0:0:0:0:0`, 4 shrink steps, replay at 0 |
| `rpc-decodes-latin1` | `rpc.ts` constructs its streaming `StringDecoder` as `latin1` rather than `utf8` | `AssertionError: expected 'ä¸\u00adð\u009f\u0099\u0082æ\u0096\u0…' to be '中🙂文'`, seed -1226496066, path `0`, 0 shrink steps, replay at 0 |
| `handle-keeps-summary-after-empty-turn` | `handle.ts` `finish` falls back to the Execution's accumulated summary when the final assistant message carries no text | `AssertionError: expected 'Temporary failure' to be null`, seed 1721966190, path `6`, 0 shrink steps, replay at 0 |
| `handle-clears-summary-on-stop-path` | `handle.ts` `finish` omits the summary whenever the terminal arrived through `stop()` | `AssertionError: expected null to be 'Temporary failure'`, seed 332238431, path `3`, 0 shrink steps, replay at 0 |
| `rpc-fails-without-clearing-pending-bounds` | `rpc.ts` `fail` rejects and clears the pending map but no longer calls each entry's `clean()` | `AssertionError: expected 2 to be +0`, seed 437158413, path `0`, 0 shrink steps, replay at 0 |
| `rpc-failure-does-not-release-its-process` | `rpc.ts` `fail` reports the failure and rejects the pending work but no longer calls `dispose()` | `Error: ENOENT: no such file or directory, open '/var/folders/yh/1n42q4_n0wqd_fx2s24092gh0000gn/T/pi-rpc-property-Kyhtv7/exited'`, seed -497047326, path `2:1:1`, 2 shrink steps, replay at 0 |

Seven of the nine fail on the property's own mandatory example at its own index
and need no shrinking — the settled execution while a retry is still in flight
(`0`), the mixed kept-and-cancelled pair (`0`), the multi-byte record whose plan
splits it one byte at a time (`0`), the seventh example's empty completed turn
that follows a retry (`6`), the interrupted terminal whose summary must keep the
retry's text (`3`), the `dispose` sample that cannot settle (`6`), and the
failure path that leaves a request bound registered (`0`). The `dispose` row is
the settle guard's own report rather than a fast-check assertion: a failure path
that sets the error but never rejects the pending work leaves the sample unable
to settle at all, so the guard fires, and the counterexample it produces is the
mandatory `dispose` example itself. The remaining two are the ones that shrink:
the forged-identifier mutation minimises to the smallest world that discriminates
it (one forged empty identifier and four held values released in reverse), and the
failure path that keeps its process alive minimises to the third mandatory
example (`invalid`) with one pending request and two disposals. The `latin1`
mutation was reachable only through a generated draw before the mandatory
example was added; the recorded run catches it on the example itself at path 0
with no shrinking, which shows the example calls the decoder in on every run —
not that a generated boundary reaches it, for the reason the next paragraph
gives.
The mutation diffs, raw run and replay logs live in `.agents/local/151-faults/`
(gitignored); the evidence JSON records their hashes. No fault switch ships in
the test sources, so normal runs cannot silently weaken an assertion.

Six of the nine were added while answering review findings, and each is the
direct evidence for its finding rather than a free-standing experiment: the
forged-id mutation shows the correlation property really fails when an unknown
id is delivered, the `latin1` mutation shows the assembly must be encoding-aware
— a record carrying a multi-byte character is mangled unless the decoder is
UTF-8 — the empty-turn mutation shows that a completed turn which keeps the
retry text as its summary fails on the mandatory example every run, not on a
draw a run might never make, the stop-path mutation shows the same for a Handle
that clears a stop-driven terminal's summary, and the two failure-path mutations
show that the failure-mode property can tell a wait that was cleaned and a
process that was released from one that only looked settled. The last two are
not assertions about the adapter's observable rejections — those were already
asserted — but about the cleanup behind them, which is why each is a mutation of
the cleanup rather than of the report.

The `latin1` mutation is *not* evidence that the generated boundaries reach the
decoder, and an earlier draft of this section claimed that it was. A latin1
`StringDecoder` is stateless per byte, so U+4E00 decodes to the same three
mojibake code points whether the record arrives whole or one byte at a time; the
mutation would be detected under the pre-fix coalescing fixture too, so it cannot
show that a boundary ever fell inside a character. The probe that would
discriminate — accumulating `chunk.toString('utf8')` per chunk instead of
streaming through a decoder -- was discarded for two reasons: it stops exercising
the decoder the production code uses, so it tests a different change, and
detecting it needs the split to reach that reader, which the parent side cannot
observe (see Limitations). The mandatory multibyte example guarantees such a
split is *written* on every run, but what the production reader makes of it stays
outside the fixture's view, so the coalescing fix stands on its own reasoning
rather than on a mutation: writes issued in one turn become one pipe read, and
the fixture now issues each chunk on its own turn.

## Measured validation cost

Six alternating runs of the whole property suite with and without this phase's
file and family, on the same checkout and machine (Apple M1 Pro / arm64, Node
22.22.2, pnpm 10.17.1, fast-check 4.9.0, Vitest 4.1.10), reading the paired
medians against issue #143's ≤10 s-per-phase gate. The set is six pairs rather
than three because both legs move by several seconds between captures on this
machine — the rounds recorded in [M9 governance](property-governance.md) read
from +3.62 s to +9.02 s on this same suite, and an earlier three-pair capture of
a previous revision of these files put its median at +10.43 s — so a three-sample
median resolves that movement into a verdict two more samples can reverse. All
six pairs are reported:

| Tree | Runs (seconds) | Median | Contents |
| --- | --- | --- | --- |
| Baseline | 45.50 / 48.10 / 48.80 / 48.05 / 47.42 / 48.22 | 48.08 s | 15 files / 80 tests |
| Candidate | 55.33 / 54.28 / 54.72 / 53.24 / 53.95 / 53.87 | 54.12 s | 16 files / 86 tests |

Median difference +6.04 s; the same-round pairs (candidate run *i* minus baseline
run *i*) are +9.83 / +6.18 / +5.92 / +5.19 / +6.53 / +5.65 s, median pair
+6.05 s. Every one of the six pairs is under the gate in this capture, which is
also why the whole set is reported rather than a passing subset: the earlier
round's pairs went over it, and which side a pair lands on is the machine's
movement rather than a cost only some runs pay.

This phase's own additions measure 6.69 s of test-body time inside that sweep:
the RPC file's five bodies sum to 6.47 s (1.12 s chunk assembly, 1.04 s
correlation, 1.04 s cancellation, 2.49 s failure modes, 0.78 s request bound,
each the median of its six candidate runs over that file), plus 220 ms for the
Handle family's 30 samples, seven of which are the mandatory examples. Those are
all in-body durations, so they add to each other. Measured the same way for a
file run on its own — whole-file, including that file's own Vitest startup and
import — the additions are 7.18 s of wall time and 6.94 s of bodies for the RPC
file, 0.98 s and 230 ms for the Handle family. The suite's own test-body total
rose by 5.80 s between the two medians, and the file that did not exist before
accounts for more than that: the fourteen unchanged files move +0.09 s in
aggregate, and the Handle family's file reads −0.73 s between the two medians
even though it gained the 220 ms family, because its own runs range over
11.73–14.40 s and that movement is larger than the addition. The attribution is
therefore the new file rather than a per-file growth this phase pays for
elsewhere.

The RPC family's normal tier was reduced from 10 to 8 samples (6 for the request
bound) after the first sweep showed real subprocess startup dominating: the
delivered tier runs its 42 samples in 6.94 s of bodies, about 165 ms each. The
failure-mode property carries most of that, because it pays a fresh subprocess
for each of its twelve samples including all eight mandatory modes. Run alone at
their declared exploration counts the same families take 43.41 s (RPC, 270
samples) and 1.63 s (Handle, 100 samples), whole-file. Both families also pass
the ordinary entry (`pnpm test`, four workers: `156 passed | 1 skipped` files,
`1940 passed | 1 skipped` tests, 69.00 s), which is the second delivery gate.

## Limitations

The Handle family's process double is in-process: it exercises the real Handle,
state adapter, projection and interaction logic, but no subprocess, OS signal,
escalation or native timing. That is the point — it makes 30/100 samples cheap —
and it is why the transport family exists beside it. The transport family runs a
real child process but a fixture one: record framing and correlation are real,
while Pi's actual RPC vocabulary is not. Pipe delivery and OS process teardown
are not under a deterministic scheduler; no claim is made about all microtask or
OS orderings, and the timeout property bounds a virtual clock rather than real
elapsed time. In particular, where one pipe read ends is not visible from the
parent without instrumenting the production reader, so the chunking property
asserts that the reassembled bytes are exact under every framing and leaves the
split itself to the fixture's per-chunk yield. Every delivered run does exercise
one — a mandatory example splits a three-character multi-byte value one byte at a
time — but the split that example produces is the one the *fixture* chose to
write, and the read-boundary measurement above is taken on a reader attached to
the fixture rather than on the production one, so no claim is made that a given
run observed `rpc.ts`'s own reader return mid-character. Cleanup is asserted where it is observable: the process double's
own exit marker, `expect(events).toEqual([])` after disposal, the byte-identical
terminal record on the Handle, and each sample's own `close()` — called from a
`finally`, with `afterEach` draining the one path where an interrupted sample
cannot reach it. What is
*not* asserted directly is the inside of
`rpc.ts`'s per-request `clean()`: a leaked per-request timer or abort listener
would be unobservable from outside, because a stale timeout lands on an entry
that is already failed and `fail` returns early once a failure exists. The
properties bound that path indirectly — the same failure path is what the
"dispose leaves pending work pending" fault trips — and the residual inference is
stated rather than asserted. Neither family covers Pi sessions, host tools,
steering, forks or permissions; those remain in
`packages/harness-pi/tests/pi-thread.test.ts` and
`packages/harness-pi/tests/pi-rpc.test.ts`, whose example regressions keep the
OS-level behavior (kill
escalation, startup bounds, version probing, missing executables) that
large-sample properties deliberately omit.
