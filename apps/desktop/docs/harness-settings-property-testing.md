# Harness settings and public command input properties (Issue #143 phase 1)

Current cross-family budgets, configurable exploration and parent acceptance:
[M9 governance](property-governance.md). Fault evidence:
[harness-settings-property-evidence.json](harness-settings-property-evidence.json).

These properties protect two existing boundaries without changing production code:
the Harness public settings contracts (Codex, Claude, Pi) and the
public command input boundary shared by GUI IPC and the loopback headless
transport. They call the real public settings API of each owning package and the
real `createChannelHandlers` router; every native boundary behind them is a
test-owned mock. Nothing here is a second lifecycle owner or a provider registry.

## What each Harness property asserts

| Harness | Public seam | Invariants |
| --- | --- | --- |
| [Codex](../../../packages/harness-codex/src/main/settings.ts) | `resolveThreadSettings` and `applyThreadSettingsUpdate` with a mocked `CodexCatalogSource` | creation accepts only `model`/`effort`/`serviceTier`/`permissionMode` and an accepted request resolves with no populated field outside those options and the preset-derived native group; a request naming a model never inherits an unrequested effort or service tier; a Thread update is the same rule applied to the stored profile, and a model switch there re-determines every sibling the update does not name; each permission preset maps to exactly one native sandbox/approval/reviewer triple and `approve-for-me` rejects, never degrades, without confirmed `autoReview` |
| [Claude](../../../packages/harness-claude/src/main/settings.ts) | `resolveThreadSettings` and `applyThreadSettingsUpdate` with a mocked `ClaudeCatalogSource` | a creation request never widens into internal fields, resolves with no populated field outside the options it named and the host executable path, and never keeps a default effort it did not name; a model switch drops an unrequested effort; a Thread with native content keeps its own goal mode and tool filters when a Host-default request carries filters of its own — the refresh's pair is fixed, and a generated session profile can equal it, so that field's comparison is vacuous for those samples and decisive wherever the two differ; a tool-list update on such a Thread is refused |
| [Pi](../../../packages/harness-pi/src/main/settings.ts) | `resolveThreadSettings`/`applyThreadSettingsUpdate` with a module-mocked `startPiRpc` | only `provider`/`model`/`thinkingLevel` are accepted; every acquired RPC is released by `dispose` once; a provider or model switch re-determines an unrequested thinking level. The forged unknown-field key is a weighted mix: one branch enumerates realistic wrong keys — the internal option `executablePath` among them — and a second, three-times-heavier branch generates a short lowercase string, so a detected failure minimizes to a smaller key instead of stopping at an enumerated constant |

The expected values are oracles held outside the code under test rather than
restatements of the implementation: native permission triples come from the
public preset table, the Claude effort expectation is derived from the request
itself, and the Pi selection is recomputed from the catalog the fixture
advertises. The remaining settings oracles are derived from data the fixture
publishes or from the public preset table, not from the owning package's own
matching code.

## Public command input

[`command-input.property.test.ts`](../tests/property/command-input.property.test.ts)
drives `createChannelHandlers` with a service whose every method, the attachment
staging store and `openExternal` are spies. Four properties generate Bart submit
requests, attachment import lists, external links and an unsupported field for
each structured channel; a separate coverage test asserts that every channel in
`COMMAND_CHANNELS` is either one of those structured channels or one of the
explicitly listed argument-less/scalar ones, so a newly added object-payload
channel cannot escape the forged-field property unnoticed. The invariant is explicit and negative: a refused
command must reject **and** leave every service, staging and `openExternal` spy
uncalled. "Any exception" is not acceptance — a request is only accepted when the
generated case says it must be, and then the handler result is compared with the
expected normalized value (trimmed directory tag, `附件` fallback display name,
`new URL(...).toString()` link, or the named service call).

Domain notes: a non-text part satisfies the non-empty rule, so an image- or
mention-only submission is legal; a local file part is legal only when its path is
both absolute and managed by the staging store; attachment imports are capped at
20 and byte imports at 20 MB; only `http:`/`https:` links are forwarded. Each
bound is exercised on both sides rather than only above it: 128 parts are
submitted and 129 refuse, 20 imports are staged and 21 refuse, and a 20 MB byte
source is staged while 20 MB + 1 refuses.

Two generated cases exist so that a guard is decided by the rule it states rather
than by an overlap with another one. The staging stub answers `true` for one
relative path (`relative.png`) that the repository's `relative()`-based
`isManagedPath` would reject, so a `local-file` part with that path is refused by
the router's own absolute-path check and by nothing else — without it, every
rejected path was already unmanaged, and dropping the absolute check would have
left the property green. The directory-tag generator emits `' Workspace '` and
`'\tWorkspace\n'`, which are legal only because the contract trims them, so a
removed trim changes the value the service receives.

## Budgets, isolation and commands

From the repository root:

```sh
pnpm test:properties -- -t 'Codex public creation'
pnpm test:properties -- -t 'structured command'
FC_SEED=143 FC_RUNS=1000 pnpm test:properties:explore -- -t 'Pi provider and model switches'
FC_RUNS=100 FC_SEED=143 FC_PATH='30' pnpm test:properties:replay -- -t 'Pi provider and model switches re-determine an unrequested thinking level'
```

Both files use 100 normal / 1000 exploration samples per property (the
command-input file adds one non-generated channel-coverage test) and the shared
30 s / 120 s property guard; the Vitest ceiling is 35 s / 130 s. Every native
boundary is a mock in the same process, so a sample allocates no subprocess,
socket or file, and no cleanup beyond the mock reset in `finally` is required.
Spies are created per sample, so a leaked call cannot be masked by an earlier
sample.

Event order per sample: the public call is awaited, and the spies are inspected
after it and created fresh per sample. Four properties make more than one public
call in a sample, and each says why in its own `eventOrder` string: the
structured-command property submits the same payload without the forged sibling
on one boundary before submitting the forged request on a second, so the refusal
is attributable to the unsupported field alone; the Claude native-content
property refuses a tool-list update, refuses a Host-default refresh, then
resolves the refresh the native Thread accepts. Every other property awaits
exactly one public call. The
Pi RPC property is one of them: it drives several mocked RPC queries inside that
single call, running each to completion or cancellation, before `dispose` is
asserted.

One production allocation does happen and is intentional: the Pi settings API
composes a 30 s `AbortSignal.timeout()` deadline with the caller's signal on every
call (`packages/harness-pi/src/main/settings.ts:20`). Node's timeout timer is
unref'ed, so it never holds the process open, and the properties finish in
milliseconds, so it cannot fire.

An aborted signal, an unknown selection and a genuine catalog rejection are
generated outcomes rather than implicit success: the Pi property asserts that
success, catalog refusal and cancellation all release the same RPC, and the
Codex property asserts that a refused request performs no native catalog load at
all.

## Fault detection, shrinking and replay

Ten temporary production mutations — at least one per remaining Harness, both
Codex settings paths included, and three at the command boundary — were
applied separately, detected with seed 143, replayed to the identical
counterexample, then restored. Every mutation ran 100 samples except the router's
absolute-path guard, which needs 1000 to reach its rare generated case; the
evidence JSON records the sample count with each entry. They are sensitivity
demonstrations, not newly discovered production bugs.

| Temporary mutation | Counterexample (minimized) | Path / shrink steps |
| --- | --- | --- |
| Codex request drops `assertOnlyKeys` | `{model: 'alpha', forged: 'executablePath'}` | `0:0:0:0:1:0` / 5 |
| Codex accepted resolution populates `executablePath` | `{model: 'alpha'}` | `6:0:0:0:0:0` / 5 |
| Codex update drops the model-switch sibling reset | `{currentModel: 'beta', currentEffort: 'low', updateModel: 'alpha'}` | `6:2:3` / 2 |
| Claude removes the effort reset | `{mergedModel: 'opus', requestedModel: 'opus'}` | `13:0:1` / 2 |
| Claude drops the retained tool filters | `{field: 'allowedTools', tools: ['Bash'], goalMode: false}` | `0:0:0:0` / 3 |
| Pi request drops the public option keys guard | `['a']` | `0:0:0` / 2 |
| Pi removes the thinking-level reset | `{current: 'anthropic/reasoner', requested: 'openai/fast', carriedLevel: 'low'}` | `30` / 0 |
| Router drops the settings shell guard | `app:update-settings` with `__forged` | `12:1:1` / 2 |
| Contract stops trimming the Bart directory tag | 128 text parts carrying `directoryTag: '\tWorkspace\n'` | `1` / 0 |
| Router drops the absolute-path guard for file parts | one `local-file` part with path `relative.png` | `691:1:2` / 2 |

Shrinking is fast-check's, not ours: eight of the ten counterexamples were
minimized further on the way to their smallest failing input, and each recorded
detection was then replayed through `FC_SEED`/`FC_PATH`, reproducing the same
counterexample at 0 shrink steps — what a replay of a minimized input should do.
The evidence JSON records the shrink outcome for every mutation, including the
two that report no steps, so a zero is a stated result rather than a missing one.

The two zero-step records are a property of their generators, not evidence that
the recorded input is minimal. Both the Pi thinking-level property and the
Bart-tag submission draw their inputs from enumerated constants — `fc.constantFrom`
over the fixture catalog's providers, models and levels, and `fc.constant` for the
accepted-maximum part array — and fast-check does not shrink across such a branch:
it reports the first failing sample unchanged. A smaller failing input can exist
for the same mutation; a one-element part array carrying the same `'\tWorkspace\n'`
tag also violates the untrimmed contract. A shrinkable generator does produce
steps, which is why the Pi forged-key case records two: its key is drawn mostly
from a generated lowercase alphabet, and the recorded detection minimized to `["a"]`. The
zero therefore states what fast-check could reduce with the generator at hand,
not that nothing smaller fails.

The exact edit, expected effect, raw log hash and environment for each mutation
are in the evidence JSON; raw local logs are under `.agents/local/143-faults`.
A healthy-code replay passes; reproducing a failure requires its recorded
temporary edit.

## Limitations

No real Harness CLI, model request, subprocess, socket or OS schedule is
exercised, and the runtimes' own provider semantics beyond the documented public
options and preset triples are out of scope. Generated catalogs are small and
deliberately enumerated; the properties claim contract agreement over the
documented public domain, not exhaustive coverage of every native capability or
of the IPC/headless transport framing (those keep their existing regressions).

## Measured validation cost

On 2026-09-10, macOS arm64 / Node 22.22.2 / pnpm 10.17.1 / Vitest 4.1.10, three
alternating runs of the whole property suite reported 40.59 / 42.76 / 43.05 s
without the two new files (10 files / 32 tests) and 44.71 / 41.41 / 44.74 s with
them (12 files / 51 tests) — medians 42.76 s and 44.71 s. Median difference:
+1.95 s, inside the ≤10 s phase gate. The two files alone take 1.81 s of Vitest
wall time normally and 4.01 s at 1000 samples per property, of which 0.33 s and
2.56 s fall inside the test bodies. These are Vitest's own suite durations: they
include startup/transform, exclude package rebuild or install and do not control
other desktop activity. The evidence JSON records the same runs.
