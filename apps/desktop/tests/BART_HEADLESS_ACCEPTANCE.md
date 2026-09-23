# Bart headless native acceptance

This suite verifies the real control and observation chain:

`bart:submit` → Bart tool call → Harness Plugin → native interaction →
`thread_respond` → native completion.

Delegated task responses always use Bart's `thread_respond` tool.
When Bart itself enters native permission waiting, the driver uses the normal
GUI `thread:interaction-respond` command, after rechecking that the Thread id is
the current Bart host. The observed waiting state, selected public allow action,
and command response are retained in each case's `host.interactions` evidence.
Native host questions or unsupported controls fail explicitly. This flow keeps
normal native permission settings and does not approve delegated targets directly.
Each successful Bart directive requires its host Execution to finish `completed`,
even after all expected Core tool results have committed. An expected Core tool
rejection is checked separately and never excuses a failed or interrupted host.
The suite uses real Harnesses and native CLI transports. Only the external LLM HTTP endpoint is replaced by a local scripted server. Every case has to change an observable
native fact: an exact proof file that cannot exist before approval, a random
secret the model cannot know without a permitted read, an exact option label
that only a real answer can transport, or a file that exists only inside the
worktree the Thread was given.

The real CLIs must be installed. Every run uses fresh native profiles and a local Mock LLM; no real API key, login, or DeepSeek service is used. Protocol or model configuration failures
are test failures, not skips or mocked fallbacks. A case is omitted for one
Harness only when that Harness genuinely lacks the native capability the case is
about — for example, Codex has no native question tool.

Cancellation cases observe the public execution summary and durable terminal
state. Core transcript entries are an orchestration audit, not the provider's
assistant stream.

## Layout

| Path | Responsibility |
| --- | --- |
| `bart-headless-acceptance.mjs` | CLI entry point |
| `bart-headless/runner.mjs` | Worker pool, reporting, artifacts |
| `bart-headless/plan.mjs` | Argument parsing, matrix expansion, sharding |
| `bart-headless/headless.mjs` | Headless Electron process and observation client |
| `bart-headless/bart.mjs` | Directive → committed native tool operation |
| `bart-headless/scenario.mjs` | Per-case control surface |
| `bart-headless/providers.mjs` | Native capability and options registry |
| `bart-headless/host.mjs` | Isolated host selection and actual host evidence |
| `bart-headless/suites/*.mjs` | The cases themselves |
| `bart-headless-pbt.mjs` | Property-based entry point (run / explore / replay / list) |
| `bart-headless/pbt/runner.mjs` | PBT item runner, phase-split coverage, failure report |
| `bart-headless/pbt/properties.mjs` | The three properties, their checkpoints and coverage requirements |
| `bart-headless/pbt/commands.mjs` | Generated operations, the weighted kind pool, the independent model |
| `bart-headless/pbt/session.mjs` | One isolated headless process, Mock LLM, profile and proofs per sample |
| `bart-headless/pbt/budget.mjs` | Sample and time budgets, seeds, fast-check configuration |
| `bart-headless/pbt/report.mjs` | Counterexample descriptor and replay command |
| `harness-injection-native.mjs` | Ordinary `openThread` native injection, follow-up, dispose/resume proof |
| `harness-injection-native-executable.mjs` | Transparent recorder around the installed real CLI |

## Suites

| Suite | Tier | Covers |
| --- | --- | --- |
| `host` | core | instruction-only random nonce through a real Core tool; exclusive native file-write pressure |
| `lifecycle` | core | create, status/list projection, read, follow-up, live steer, interrupt, metadata |
| `permission` | core | approval, denial, and the follow-up guardrail while waiting |
| `question` | core | first option, a non-default option, multi-select, and cancellation |
| `background` | core | background work beside a completed Execution, and across a second one |
| `workspace` | extended | temporary workspaces, Git worktrees, and rejected workspace requests |
| `reports` | extended | Report list, create, read, update, archive, restore |
| `schedule` | extended | rejected timestamps, a due dispatch, and cancellation |
| `resilience` | extended | unknown ids, stale or consumed interactions, Bart cancel |
| `terminal-history` | complex | Codex provider facts, public observations, ordered Bart injection, exact recall |
| `combination` | complex | chained interaction kinds, interrupt-and-resume, concurrent Threads, Thread-to-Report journeys |

`--suite core` (the default), `extended`, `complex`, and `all` select whole
tiers. `node tests/bart-headless-acceptance.mjs --help` prints every case with
its description.

## Running

### Local Mock LLM health check

```sh
pnpm test:harness-health
# Full capability-eligible matrix across all hosts and targets.
pnpm test:harness-health -- --suite all --workers 3
# Inspect the plan; does not start a model endpoint or native CLI.
node apps/desktop/tests/harness-health.mjs --list
# Focus an individual failure.
pnpm test:bart-headless -- --host pi --case lifecycle:follow-up --keep
node apps/desktop/tests/harness-injection-native.mjs --host claude --keep
```

No API key or dotenv is needed. The health command builds the candidate and
runs two independently reported stages. Ordinary Thread acceptance exercises
injection, four native sends, dispose/reopen and historical receipts after a
changed tool schema on every registered Bart-capable Harness. Bart exercises
host instructions/tool isolation and start/follow-up/interrupt across all
host/target pairs (currently 3 ordinary cases and 33 Bart cases). `--suite all`
expands the Bart stage to the full matrix.

Each worker owns its local HTTP server and empty HOME/XDG/native profiles.
Codex uses Responses, Claude uses Messages, and Pi uses Chat Completions.
The host supplies the endpoint explicitly; native adapters own protocol paths
and session-local model configuration. `mock-model` is the only expected model.
Normal GUI startup remains unchanged. A manually launched test host requires
`OPENAGENT_BART_HEADLESS_PROVIDER=mock` and `OPENAGENT_MOCK_LLM_URL` pointing to
an HTTP `127.0.0.1` origin with an explicit port. Remote origins are rejected.

The Mock LLM interprets only the acceptance fixture grammar. It reads injected
receipts, current tools and previous tool results from actual HTTP requests.
It cannot read product state, proof files or the test's expected values. Native
CLIs execute every requested tool. Unknown requests, missing instructions,
missing tool definitions/results, CLI failures and cleanup failures fail the
run. There is no remote provider fallback or live recording step.

Health ignores implicit machine-local acceptance configuration and rejects
host/target/case narrowing. Individual runners accept explicit `--config`,
`--host`, `--harness` and `--case`; they still use the local model. `--provider
mock` is optional and is the only accepted provider selection.

Evidence is retained under `~/Developer/OpenAgentValidation` or
`--artifacts-dir`: aggregate and per-case `results.json`, committed state,
native protocol receipts, and each server's `llm-requests.json` / `.jsonl` with
HTTP requests, scripted replies and assertion failures. Credentials are not
inherited. Passing proves native execution/transport behavior, not a real
model's reasoning quality or an external provider's availability.

See [Mock LLM design and open-source evaluation](mock-llm/README.md) for the
fixture interface and dependency choice.

The default matrix:

```sh
pnpm test:bart-headless
```

The complete matrix, four workers:

```sh
pnpm test:bart-headless -- --suite all --workers 4
```

Focused runs while iterating:

```sh
pnpm test:bart-headless -- --harness codex --case permission --keep
pnpm test:bart-headless -- --case terminal-history --workers 1 --keep
pnpm test:bart-headless -- --case workspace:git-worktree
pnpm test:bart-headless -- --harness claude --suite question --workers 1
pnpm test:bart-headless -- --host claude --harness pi --case lifecycle:start-complete --workers 1
```

Print the planned matrix without running anything:

```sh
pnpm test:bart-headless -- --suite all --list
```

For a complete matrix independent of a local `cases` filter, select a config
without `cases` (such as the example config). CLI case selectors and configured
case selectors are combined; `--suite all` does not clear configured selectors.

## Property-based state-machine regression (headless PBT)

`tests/bart-headless-pbt.mjs` (with `tests/bart-headless/pbt/`) is a second entry
point over the same chain and the same guarantees as the fixed matrix: real Bart,
real Core, real Harness plugins, real native CLIs, real permission interactions,
real file effects, and the local Mock LLM as the only test double. What differs
is where the operation sequence comes from. The fixed matrix names its cases; the
PBT generates sequences with fast-check and checks committed renderer state
against an independent model, then shrinks a failing sequence to a minimal one
and prints a command that reproduces it.

| Property | Requires | Generated operations |
| --- | --- | --- |
| `lifecycle` | — | create (plain or parked), follow-up, steer, release, interrupt, status and list projection over one Thread |
| `permission` | `permission` | create, approval, denial, unknown and already-consumed responses |
| `isolation` | `permission` | two Threads, a cross-Thread response, approval and denial across Threads, interrupting one Thread beside another |

A property is never silently skipped: it runs on every target that declares the
capability it needs, and the run fails when nothing can exercise it.
An explicit target selection that leaves any requested property without a capable
target fails, including `--harness pi` with the default all-property selection.
Select `--property lifecycle --harness pi` to run that supported subset.

### Entry points and budgets

| Mode | Generated samples per property/target | Command ceiling | Seed |
| --- | --- | --- | --- |
| `run` (default) | 6 | 6 | fixed `218006` |
| `explore` | complete batches of 40; at most 160 | 24 | fresh first seed; recorded successor seeds for added batches |
| `replay` | one recorded counterexample | recorded | recorded |

```sh
pnpm test:bart-headless:pbt
pnpm test:bart-headless:pbt:explore
node apps/desktop/tests/bart-headless-pbt.mjs list
# Select one supported host and one target, or omit --harness for all targets:
pnpm test:bart-headless:pbt:explore -- --host pi --harness claude
```

The host must declare the Bart host capabilities (currently Codex, Claude, and Pi).
An explicit `--host auto` delegates selection to the product in every isolated
session. Reports preserve both the requested preference and the selected concrete
host; a change of actual host within one run fails. Replay uses the concrete host.
Targets are selected independently: lifecycle runs on Codex/Claude/Pi;
permission and isolation run only on targets declaring native permission
support. Run explore once per supported host to explore every applicable pair.
No provider credentials or login are needed. This machine launches with
`PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"` so all three CLIs resolve.

`--samples`, `--max-commands`, `--seed`, `--workers`, and the `PBT_*` environment
variables override the defaults. The standalone runner configures fast-check to
use the declared command ceiling; without this, its default size caps generated
lengths at 10 even when `maxCommands` is larger. No numeric `size` or nonexistent
`minCommands` option is used. The fixed seed was selected using `fc.check`, the
same generation path used by acceptance, and verified through all seven real
property/target items.

### Coverage is required and reported separately for each phase

The mandatory checkpoint sequences and the generated samples have independent
counters. `sampleCoverage` is required from generated commands at every budget;
`exploreCoverage` additionally requires late responses after interruption
and successor creation, out-of-order completion, and interrupting one Thread
while its sibling waits. A checkpoint cannot satisfy these generated
requirements. Reports include executed kinds, reached states, and empty samples.
Shrinking and replay each have another independent counter. The initial failing
generated attempt counts as a sample; later shrink candidates cannot inflate
generated reach or alter that sample's empty/non-empty outcome.

Exploration runs at least one complete 40-sample batch. If its generated coverage
is incomplete, it adds a complete batch with the next recorded seed, up to four
batches total. An exhausted time or sample ceiling fails the run; incomplete
coverage never becomes a warning or a silent pass. This bounds native startup
and shrinking cost without pretending a finite random distribution guarantees
that every ordering appears. Results retain every batch's seed and sample count.

### Counterexample shrinking and replay

Generated failures use `fc.commands` and `fc.asyncModelRun`. The report records
seed, path, commands replayPath, generator budget, the effective minimal
sequence, shrink count, CLI/fast-check/Node versions, request-gate order, and the
exact failing sample's artifacts. Interrupted or infrastructure-only runs are
reported as failures without advertising a fabricated counterexample.
Assertions have semantic IDs that remain stable when source lines move. The first
failure's ID is frozen while shrinking: different assertions are rejected, and
infrastructure errors stop further attempts. If an earlier counterexample exists,
it remains available as a failing sequence with shrinking explicitly incomplete;
every rejected attempt retains its own error and artifact path.
If an oracle and cleanup fail in the same attempt, the oracle retains its replay
coordinates while cleanup stops further shrinking. The run still fails. A
checkpoint that cannot begin isolated shrinking retains its observed prefix and
checkpoint selector, explicitly marked as not isolated or shrunk. Native model
evidence is checked within each checkpoint so its failures remain locatable too.

A failure in a mandatory checkpoint also enters automatic shrinking: its known
sequence becomes an array arbitrary, removal candidates obey the same command
preconditions, and every attempt opens a fresh real session. Its replay includes
`--checkpoint` instead of a commands replayPath. A checkpoint that cannot fail
again with the same assertion signature in isolation remains a failed run and
is reported as unreproduced; a different failing assertion is not its shrink.

Copy the full `Replay:` command from a failure report. It selects exactly one
property/target/host and pins the generator inputs plus a failure signature.
Replay requires a concrete `--host`; omitted and `auto` hosts are rejected.
Replay only succeeds when the same property failure returns. Setup failures,
cleanup failures, unrelated assertions and exhausted exploration do not count
as reproduction. Once the defect is removed, replay reports `did NOT reproduce`
and exits 1.
Only the recorded candidate executes, including when its path contains shrink
coordinates. A passing recorded candidate never opens a later sibling session.

On 2026-09-13, temporarily omitting the committed Execution from the real
`bartThreadStatus` projection was detected and shrunk through both paths:
checkpoint `5` → `start-plain → status` (1 shrink), and generated commands →
`start-hold → status` (2 shrinks). Both recorded commands reproduced the defect.
After restoring product source and rebuilding, the generated replay below
reported `did NOT reproduce` (exit 1). No mutation remains in the candidate. Exact edits and replay coordinates are
kept in [the evidence record](../docs/bart-headless-pbt-evidence.json).

From the repository root, the verified generated replay is:

```sh
PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH" pnpm test:bart-headless:pbt:replay -- --property lifecycle --harness pi --host codex --samples 6 --max-commands 6 --seed 16751 --path '1:2:1' --failure-signature 2d99b534ae30cc67284def96 --replay-path 'ABABD:V'
```

这组坐标对应 2026-09-13 的生成器版本；删除工具后当前生成器已改用新 seed，
历史坐标不适用于当前代码。

Versions were Codex `0.153.4`, Pi `0.83.0`, and Claude `2.1.267` for the full
matrix. Local evidence directories: `openagent-bart-pbt-nwWqS6` (checkpoint
failure), `openagent-bart-pbt-GJ8ank` (checkpoint replay),
`openagent-bart-pbt-AD69jR` (generated failure), `openagent-bart-pbt-JcskVo`
(generated replay), and `openagent-bart-pbt-Zx795G` (clean replay).

### Environment, time and cleanup

- A POSIX shell and a built candidate are required. Headless loads
  `out/main/index.js`; product edits require `pnpm --dir apps/desktop build`.
  PBT runner edits do not require a product rebuild.
- Every required CLI must be on the launcher's PATH. Missing executables fail
  preflight with their version-probe error before an artifact directory is created.
- All model traffic uses the local Mock HTTP endpoint. Fixtures choose their
  replies from actual HTTP inputs, never from expected or observed product state.
- Native waits and gate arrival have explicit deadlines (default 180s). The
  runner's allowance for the mandatory checkpoint phase and for each generated
  batch is at least five minutes, otherwise sample count times
  `PBT_SAMPLE_BUDGET_MS` (default 60s). A deadline cancels active execution and
  waits for its cleanup before reporting; shutdown retains its own bounds.
  Shrink attempts share their batch deadline. The runner does not use fast-check's
  promise-racing time limit, which can return while native work is still alive.
- Every sample/shrink attempt has its own Electron process, native profile,
  Mock listener and proof paths. A sample tag inherited by real native processes
  lets the runner independently inspect detached CLI processes after shutdown.
  `resources.json` records only owned PIDs/groups/start times and remaining
  processes. Detected leaks are cleaned up and still fail the sample. Both the
  headless and Mock ports must be released. Cleanup terminates the consumers
  before releasing leftover Mock gates, so teardown cannot launch a new native
  follow-up and then truncate its request. HTTP errors still fail the run.
- SIGINT and SIGTERM cancel startup, HTTP waits and gate waits, then await sample
  cleanup before exiting with 130 or 143. Cancellation does not start another
  sample, enter shrinking, or claim a timeout or reproducible counterexample.
  A closed output pipe follows the same cleanup path and exits quietly with 0.
  Evidence-file write failures do not prevent cleanup of reidentified owned PIDs.
- Passing artifacts are removed unless `--keep` is used. Failure and replay
  artifacts are preserved, including HTTP/native logs, proofs, gate order and
  aggregate `results.json`, under `~/Developer/OpenAgentValidation` or the
  selected `--artifacts-dir`. Tests disable worktree creation and keep mutable
  native state under the sample directory.

### Measured cost

Native-run wall-clock times exclude the separate build step. The fixed seed's
short regression passed 7/7 items on each of the three supported hosts (21/21)
after the PR review fixes. Startup, checkpoint execution and generated execution
also passed SIGINT/SIGTERM cleanup probes (6/6), with no owned process or listener
remaining. An injected generated-session startup failure was attributed to its
own artifact directory and was not advertised as a minimized counterexample.
Runner-owned 3.5s deadlines also cancelled real checkpoint/replay work and awaited
resource release before exit (about 4.8s including preflight and cleanup). Oracle
plus cleanup fault probes retained generated and checkpoint replay coordinates;
a native-evidence checkpoint fault followed the same path. Every retained sequence
replayed after removing only the cleanup fault. Replay with both faults still failed.

| Host | Short (6 × 6) | Default exploration | Generated exploration samples | Default result |
| --- | --- | --- | --- | --- |
| Codex | 1.8 min | 18.3 min | 360 | 7/7 |
| Claude | 1.6 min | 18.3 min | 480 | 6/7; coverage supplement below |
| Pi | 1.8 min | 18.6 min | 360 | 7/7 |

Claude-host/Codex-target lifecycle exhausted four 40-sample batches without
reaching `late-result-after-successor`. All 160 samples passed their command
assertions, but the missing generated coverage correctly failed the item.
Keeping its original first seed (`616582726`), a separate run raised only
`--max-commands` from 24 to 32. It passed every generated coverage requirement in
40 samples and 3.7 minutes. All 21 applicable combinations therefore have
passing exploration evidence; this is not a claim that the default exploration
passed 21/21. Across the original runs and the supplement, 1240 generated
samples ran. Both the coverage failure and the supplement are preserved in the
[evidence record](../docs/bart-headless-pbt-evidence.json).

```sh
pnpm test:bart-headless:pbt:explore -- --host claude --harness codex --property lifecycle --samples 40 --max-commands 32 --seed 616582726 --keep
```

The issue's existing complete-matrix baseline is approximately 13 minutes.
The handoff's narrower 114-case matrix took 7.0 minutes (113 passed; its metadata
failure passed a later isolated retry). The final complete matrix passed
217/217 in 6.1 minutes across Codex, Claude, and Pi hosts, including the
previously failing Codex-host/Pi-target metadata case.

## Parallelism

Each worker owns one headless Electron process, one isolated Electron user data
directory, and therefore one Bart conversation on one selected host. Scenarios inside a worker stay
strictly serial, because a single Bart cannot be given two directives at once;
parallelism is only ever added by adding workers. `--workers auto` (the default)
uses up to four; `--workers 1` restores fully serial behaviour.

Sharding interleaves Harnesses before distributing scenarios, so one slow
provider does not serialise the whole run. Cases marked `once` are planned once
per host, with the first selected target. Cases marked `host` are planned once
per host with `targetHarnessId: null` in the results. A host-only proof never
counts as a delegated-target proof. Selecting several hosts creates separate
isolated processes; `--workers 1` still runs them serially. The Codex-specific
terminal-history case requires a Codex host as well as a Codex target.

## Configuration

Machine-specific models and options can be saved once in
`apps/desktop/tests/bart-headless.local.json`; that file is gitignored. Start
from `bart-headless-acceptance.config.example.json`, or pass another file with
`--config`. Each `providers.<id>` is the generic GUI profile
`{ "useDefaultThreadSettings": false, "threadSettings": { ... } }`. The
`useDefaultThreadSettings` opt-out is what makes a profile's values stick: while
a Harness is on its Agent defaults the product discards stored Thread settings,
and the profile helper sets the flag automatically whenever the profile or a
model override carries values. No profile can select the CLI. The host always
auto-detects the binary and only a created Thread pins one, so a Harness-level
`threadSettings.executablePath` is rejected by every Harness; a run that needs a
specific CLI must make it the one host discovery resolves instead, such as by
putting it first on the host's `PATH`. The old acceptance `options` profile
field is rejected with a migration error; the product's
`thread_create.options` remains a flat native settings request.
`hostProfiles.<id>` optionally selects a different generic profile for the host;
otherwise it uses `providers.<id>`.

Relative `--config` paths resolve from the command's working directory.
`pnpm --dir apps/desktop test:bart-headless` runs in `apps/desktop`, so its
example path is `tests/bart-headless-acceptance.config.example.json`. Direct
`node apps/desktop/tests/...` commands from the repository root need
`apps/desktop/tests/bart-headless-acceptance.config.example.json`. An absolute
path works from either directory. A missing explicit config fails before any
native process starts; only an absent optional default local config uses `{}`.

`--harness` selects delegated task targets. `--host` independently selects Bart
hosts and can be repeated. Config `hosts` supplies the default selection; with neither, all registered host-capable Harnesses are covered. Explicit `auto` uses the product selection and records the actual host. Explicit host selection fails if the product chooses a different
host. The host is configured through `app:update-settings` in the worker's
isolated user-data directory.

The test model identity is fixed to `mock-model`. Profiles may select native
permission/settings behavior; an incompatible model selection fails locally.

Configured options are merged over the least-privilege profile a case selects.
Cases that need the native agent to write without a permission interaction ask
for the Harness' permissive profile instead, and that profile always wins over
the configured permission settings.

## Artifacts

Each run uses an isolated temporary root holding one `user-data` directory, one
`openagent-home` directory, and one `headless.log` per worker, plus a shared
`proofs` directory and any temporary Git repositories a case created. The
worker-local OpenAgent home contains Bart workspaces, staged attachments, and
temporary Harness workspaces, so acceptance never scans or mutates the GUI's
`~/.OpenAgent`. It is deleted after a fully successful run and preserved with
its logs when any case fails or when `--keep` is specified.

Use `--artifacts-dir <path>` to put isolated runs and their disposable Git
repositories under a chosen local directory. The default is
`~/Developer/OpenAgentValidation`.
Each completed run writes `results.json` with per-case outcomes, timings, native
proof identifiers, requested and actual host, separately identified targets,
effective settings, Git candidate/dirty status, command, and failure details.
The worker also retains the complete committed state for each case, including
Plugin-owned native facts. Mock model facts are extracted when that Plugin
publishes them; an empty native-model list is not proof of the requested model.
The standalone ordinary-Thread run below also records native usage model facts
and CLI protocol traffic. Process-tree release failures fail the run. Add
`--keep` to retain successful evidence.

## Issue #54 focused native acceptance

Run from the repository root after building the candidate. The example config
has no `cases` filter. Explicit profiles may vary native permission settings; no GUI authentication or configuration is reused.

```sh
# Actual Bart hosts, independent of all delegated targets: six host-only cases.
pnpm --dir apps/desktop test:bart-headless -- \
  --config tests/bart-headless-acceptance.config.example.json \
  --host codex --host claude --host pi --suite host \
  --workers 1 --keep --artifacts-dir ~/Developer/OpenAgentValidation

# Core target lifecycle/interaction matrix; all task targets, explicit Codex host.
pnpm --dir apps/desktop test:bart-headless -- \
  --config tests/bart-headless-acceptance.config.example.json \
  --host codex --suite core \
  --workers 1 --keep --artifacts-dir ~/Developer/OpenAgentValidation

# Generic injection without Bart composition: three hosts, four sends each.
node apps/desktop/tests/harness-injection-native.mjs \
  --config apps/desktop/tests/bart-headless-acceptance.config.example.json \
  --host codex --host claude --host pi --timeout-ms 600000 \
  --keep --artifacts-dir ~/Developer/OpenAgentValidation
```

Both entry points support `--list` to inspect the plan without starting a native
request. Use the existing lifecycle, permission, question, resilience and
combination case selectors to narrow the Bart matrix while iterating.

The ordinary-Thread command opens the real Plugin through its public Main
module and its ordinary `openThread`, `send`, `respond`, and `dispose` methods.
It supplies only an opaque session publication store, execution admission
guards, and a telemetry ledger recorder; it does not install a fake Harness or
native CLI transport. Its LLM is local and scripted. A transparent executable wrapper forwards the real CLI unchanged
and retains native protocol evidence. All OpenAgent-owned data and proof files
remain below the run directory; native profiles are empty and isolated.

| Proof | Actual observed fact | Scope/limit |
| --- | --- | --- |
| Bart instructions before execution | Random receipt absent from the directive appears in a committed native Core tool call | Actual selected Bart host, no target Thread |
| Bart exclusive tools | Supplied Core tool commits; requested direct native filesystem write remains absent | Behavioral negative probe; native launch/schema exclusion also needs adapter regressions |
| Generic injection | Independent instructions, Thread, seed, telemetry, evaluation and current-send receipts exactly match native callback arguments | Ordinary Thread on each actual selected host |
| Per-send context and native result | Follow-up uses a fresh send receipt; native completion returns a newly random tool result | Receipts cannot be guessed from the user input |
| Native settings without evaluation gate | Normal settings resolution followed by successful execution and actual native model frames; concrete requested models must match | The exact Mock model identity is recorded; no evaluation contributor is requested before model selection |
| Respond | Any native custom-tool permission is answered through ordinary Handle `respond` and recorded | If no native permission occurs, do not count that host as native permission coverage |
| Resume and release | Dispose/reopen preserves primary native session, then another fresh receipt succeeds; recorded CLI process ids exit | Bart/target interrupts and questions remain separate headless cases |
| Tool schema change | Added required argument recalls the first random tool result from native history | Codex rotates its native session for changed dynamic tools; the OpenAgent Thread remains the same |

Preserve `results.json`, per-host `facts.json`, `tool-receipts.jsonl`, and
`native-protocol.jsonl`, `native-debug` logs, and the headless logs/state evidence. Keep host
and task-target matrices separate in the PR evidence. Record service/model
failures as failures or blockers and unexecuted cells as unexecuted; local unit
tests of the driver are not native acceptance passes.
