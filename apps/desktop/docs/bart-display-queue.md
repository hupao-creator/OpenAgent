# BART display queue

`BartDisplayQueue` is a transient presentation module. It has no React, DOM,
IPC or storage dependency. The state rules define release timing; the queue
preserves semantic order and enforces execution and visibility boundaries.

## Integration API

- `receive(input)` supplies the **authoritative current scope and lifecycle**,
  ordered items and a recovery snapshot. A new scope clears the previous queue.
  `reset: true` hydrates only the latest snapshot. Callers must filter incoming
  events against the current thread, Harness and execution before delivery.
- `setTiming(timing)` configures `minimumDisplayMs` separately for `running`,
  `reasoning` and `tool`. Values must be finite and non-negative. The defaults
  live in `state-rules.ts`: 2000ms for each state while the session is busy,
  and 800ms for each state once the real `sessionIdle` signal is true.
  The Dock selects these defaults through the timing API; the queue does not
  infer session idleness from execution completion or from its own backlog.
  Explicit timing overrides (including Lab controls) take precedence.
  Changing timing preserves the item's original presentation start: at idle,
  an item shown for 500ms waits another 300ms; one shown for 1000ms may release
  its successor immediately. Switching back to busy likewise uses the original
  start against the 2000ms interval.
- `subscribe(listener)` and `getSnapshot()` expose the current item and its
  presentation token. Receiving updates does not acknowledge presentation.
- `presented(token)` starts the item's minimum interval **after it is rendered**.
  A stale token is ignored. Updating the same item's text does not restart time.
- `setPresenting(false)` cancels pacing and drops replay obligations. Setting it
  back to true synchronizes to the latest state with a new presentation token.
- `synchronize(item?)` explicitly discards backlog and takes the latest item.
- `dispose()` removes timers/listeners and rejects further work.

The initial generic waiting pose is a fallback, not a queued semantic event:
the first real activity replaces it immediately. Assistant-text events are
ordinary `running` items and receive the configured running interval.

## Event path

The optional `HarnessThreadOpenContext.bartDisplay` capability publishes
normalized semantic activities before a persisted foreground can replace them.
Core binds the capability only for the BART host, validates the owning running
execution, and isolates observer errors from execution and state commits.

The existing renderer mutation transport carries ordered `bartActivities` as
transient delivery metadata. Main may combine adjacent updates of the same
item but retains every semantic boundary. Mutation merging concatenates the
events. They are never fields of a Thread, persisted session, or loaded snapshot.

The renderer's synchronous store observer forwards accepted events to the
queue before React can batch renders. It rejects foreign execution input and
uses snapshots only for initial state/recovery and same-item updates. A snapshot
with older reasoning source cannot truncate a newer live item. The React hook
only forwards visibility/timing and acknowledges committed presentation.

## Reset and completion rules

While visible, backlog size never triggers acceleration. Session idleness alone
selects the shorter default interval. Reasoning may yield at its
minimum interval without finishing its source or its text animation. A natural
completion drains the visible queue and then rests; true execution status and
reply data advance independently.

Failure, cancellation and user-response requests clear pending presentation
immediately. A new execution clears old work. Window/spatial hiding, camera or
history coverage, input composers and dedicated animation ownership all discard
replay obligations; returning presents the latest state. A visible unfocused
window keeps its normal cadence. Reload/remount never replays history.

Dedicated choreography remains outside this queue. A dedicated semantic call
also marks a catch-up boundary when its brief ownership was batched away before
the renderer could observe the intermediate snapshot.

The real-Dock cadence tests cover visible timing and takeover. The native Codex
pipeline test crosses Harness delta batching, Main publication, mutation merging,
store delivery and React rendering; provider tests cover Claude and Pi native
acceptance. Queue API tests cover presentation acknowledgement and stale leases.
