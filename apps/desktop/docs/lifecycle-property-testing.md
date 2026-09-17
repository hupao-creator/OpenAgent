# Lifecycle properties (Issue #96 M2)

Current cross-family budgets, configurable command exploration, extension guidance and
parent acceptance: [M9 governance](property-governance.md).

This baseline tests the existing Promise implementation before any Effect refactor.
It extends [M1](property-testing.md) with a Core public-facts model and [three native
Harness drivers](harness-property-testing.md). [M4 paused Effect adoption](effect-directory-pilot.md);
no M3–M9 behavior is delivered here.

## Contracts and reference model

The authorities are `HarnessThreadHandle`, `HarnessExecutionClaims`,
`HarnessExecutionAdmission`, `HarnessSessionStateAdapter` in
`packages/openagent-contracts/src/harness-plugin.ts`, and the current
[architecture map](../../../.agents/architecture.md). The tests exercise
`HarnessThreadInstance` and the shared `ThreadLifecycleService` interrupt/respond
use cases with a test-owned Harness. Core never reads real Harness opaque state.
The test Harness alone uses the existing `testSessionState` adapter.

`tests/property/lifecycle.property.test.ts` stores only the expected public
observation, closed/open authority, the committed archive flag, issued execution IDs
and an interaction identity. It does not duplicate runtime queues, pending-send
internals, native session schemas or the production transition validator. The
generated sequence has 1–35 operations: send, explicit Stop, stale Stop, call-time
no-target Stop, service Stop, native wait, respond, stale respond, native
completion/failure, background change, unarchive, dispose and reopen. At each step
it checks the public observation and the committed archive flag; rejected commands
must also leave native call counters unchanged. Native waiting/terminal events are
legal only at their active frontier; invalid command attempts have separate
rejection branches. A send during running is a follow-up of the same Execution;
waiting requires respond. An explicit unknown/old Stop is harmless; explicit null
means no call-time target, not permission to stop whichever Execution is now
running. A published failed latest Execution archives the Thread in the same commit,
so the model refuses a send until the `unarchive` operation commits the Core archive
command; the driver reads the flag from the committed record rather than the runtime.

## Controlled schedules and boundaries

| Property selector | Controlled inputs and assertions |
| --- | --- |
| `lifecycle public model` | Generated operation sequence; fresh execution identities; follow-up/send rejection; service Stop/respond routing; terminal/background independence; archive on published failure and explicit unarchive; reopen from persisted public facts. |
| `lifecycle stale Stop` | Complete or stop A → enter B's Handle.send before running publication → 1–5 Stop(A) calls → release B. B must publish running and enter native I/O without a native interrupt. This preserves the historical unpublished-successor regression. |
| `lifecycle native admission` | Reject unclaimed, abandoned and unpublished claims; reject competing claim; publish running → hold Core authorization → hold `flushThread` durability → allow, deny, terminate or dispose → release. Native continuation requires both boundaries and current authority. 1–4 concurrent admissions share one authorization attempt; a denied current attempt can retry. |
| `lifecycle failed opening` | Claim and publish during open (awaited or fire-and-forget) → throw opening error → drain/converge interrupted → reopen and send successor → 1–4 rounds from each of the successfully disposed and failed-opening contexts reject both formerly valid snapshots and successor-identity publications. Background work survives convergence. This preserves the historical opening cleanup regression. |
| `lifecycle duplicate Stop` | 2–6 concurrent exact Stops share one failed native attempt; retry invokes native again; repeated successful Stop is idempotent. |
| `lifecycle no-target Stop` | Enter unpublished send → 1–5 explicit-null Stops → release send. Cancellation prevents native I/O and running publication; no native interrupt is needed after rejected Handle.send. |
| `lifecycle old interaction` | Answer old interaction → replace it within the same Execution or complete/send successor → reject 1–5 actual old-ID answers → accept the new answer. |

These are explicit Promise barriers, not wall-clock sleeps or a duplicate lifecycle
scheduler. Array/case shrinking retains event order. `replayPath` is null because
these tests use `fc.asyncProperty` with arrays and bounded scenario parameters,
not fast-check commands or its scheduler. Historical race scenarios are mandatory
skeletons, so shrinking cannot remove the authority transfer being tested.

The service fixture supplies only its declared runtime/repository collaborators;
its operation runner is serial within each generated sequence. It does not claim
coverage of OpenAgentService's full application queue, GUI/IPC transport, workspace
policy or application shutdown. Existing integration and native verification remain
required. OS process scheduling, real CLI/network delivery, SQLite worker crashes,
filesystem failures and every possible microtask interleaving are not controlled
here. Native-driver-specific external limits are listed separately. No native Turn
is assumed to map identically to a public Execution across providers.

## Budgets, isolation and replay

Each Core async property runs 30 samples by default, with the existing 10-second
fast-check interruption budget (interruption fails) and a 130-second Vitest ceiling
to permit expanded runs. Each sample owns a temporary directory, real
`ThreadStateStore`/SQLite workers, AbortSignals, test Handle and barriers. `finally`
releases every held barrier, settles pending operations, disposes the Handle, closes
the store and removes the directory. No timer or ongoing exploration is installed.

From the repository root:

```sh
pnpm test:properties -- -t lifecycle
FC_RUNS=100 FC_SEED=96 pnpm test:properties:explore -- -t lifecycle
FC_RUNS=30 FC_SEED=96 FC_PATH='0:0:0' pnpm test:properties:replay -- -t 'lifecycle stale Stop'
FC_RUNS=30 FC_SEED=96 FC_PATH='0:0' pnpm test:properties:replay -- -t 'lifecycle failed opening'
FC_RUNS=30 FC_SEED=96 FC_PATH='0:1' pnpm test:properties:replay -- -t 'lifecycle native admission'
```

The replay commands pass on restored code. To reproduce a demonstrated failure,
apply exactly the corresponding temporary edit recorded in
[lifecycle-property-evidence.json](lifecycle-property-evidence.json), run the command,
then restore that edit. Preserve the generator/lockfile, seed, path and sample budget.
All four faults were actually detected, shrunk and replayed with an identical
counterexample; the production edits were restored. The faults respectively remove
stale-Stop identity fencing, skip failed-opening convergence, and omit awaiting the
native durability barrier; the fourth leaves a normally disposed Handle accepting publications and undisposed. The failed-opening replay command also replays that fourth fault. They are detection demonstrations, not newly found defects.

The shared failure reporter records dependency/runtime versions, bounded inputs,
seed/path, shrink count and event order. Full logs and their hashes are retained with
the PR evidence. Normal `pnpm test` and full verification discover these properties.
The existing exploration command defaults to 1000 samples; use the explicit bounded
100-sample command above for this resource-bearing family. Larger exploration can
hit the 120-second per-property guard and fails rather than reporting partial success.

Measured on macOS 26.5.1 arm64, Node 22.22.2, pnpm 10.17.1 with seeds 96/97/98,
the four adjacent lifecycle suites took 5.465 / 4.734 / 5.326 seconds; adding both
M2 property files took 24.293 / 23.732 / 35.240 seconds (76 tests passed each run).
Median added wall time was 18.967 seconds. These sequential one-worker commands
include Vitest startup, real SQLite workers and fixture subprocesses, exclude
package rebuild/install, and are not a whole-verifier benchmark. Measurements precede the F1 additional late-context assertions; final full-verifier
timing is separately reported in the PR. Concurrent machine load was not isolated; the slower third run illustrates variance. Exact commands
and environment are in the evidence JSON. Core exploration at seed 96 passed all
seven properties with 100 samples each in 60.12 seconds Vitest wall time.
This is test cost, not an Effect runtime benchmark; no Effect before/after comparison
is applicable to M2.
