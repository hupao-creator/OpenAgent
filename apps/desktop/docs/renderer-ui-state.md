# App UI state

Issue [#88](https://github.com/xinyuan0801/OpenAgent/issues/88) separates temporary
Core Renderer facts from Main's authoritative snapshots.

Each AppContent creates its own Bart composer and Overview orchestration Zustand
stores. They survive Dock/full-page switches but are discarded with that App.
Snapshot replacement never writes them, and Harness plugins do not import them.
Standalone generation/Lab callers create their own presentation store.

The composer owns text, its edit revision, attachments, import exclusion, and
submit/clear exclusion. Both Bart surfaces select their own fields. Async actions
capture a submission and read the current store on completion: only unchanged
text and submitted attachment objects are removed. An A → B → A edit counts as a
new edit. Pending imports block submission; failed submissions retain the draft.
Clear also preserves edits made while its request runs.

The orchestration store owns live layout context, ordered layout revisions, deleted placeholders,
queued generation work, released/hidden IDs and reveal requests. Every visual
before-commit observation appends its revision synchronously, so batched A → B → A
transitions remain distinct. Overview and the generation surface subscribe
directly. Generation projection selects the current column count even when a resize
does not rerender AppContent. Production generation callbacks update shared presentation facts without
a layout-effect round trip through AppContent.

Animation execution, AbortController use, DOM/WebGL motion and stage leases stay
with the existing App/Overview/generation executors. The store does not schedule
or acquire a stage. App scene changes and leaving Overview abort queued work and
reset facts; generation teardown also releases its work and presentation state.
Main state commits remain independent of visual callback failures.

## Navigation decision

Retain the existing App-owned navigation state and actions in this delivery.
Navigation changes intentionally compose the root surfaces, unlike high-frequency
composer edits. Current actions also coordinate IPC-backed selectedThreadId with
View Transition capture and preserve the Agent selection behind the Bart overlay.
A new Zustand navigation store would add no narrower subscriber. A reducer could
collect local setters but cannot replace the asynchronous IPC/DOM transaction;
the additional action/state model is not needed for this issue's subscription goal.

Keep the current transition rules: Overview closes Bart and follow-up controls and
clears Main selection through IPC; Agent opens establish a fresh reading request;
Report opens close Bart controls; Bart overlays retain the selected Agent;
follow-up entry rejects archived/deleted Threads. Filters and reading targets keep
their existing persistence across navigation. Existing App regressions exercise
these rules; no second selectedThreadId or Thread lifecycle authority is created.

## Measured subscription evidence

At baseline 7343cd68ca5a7e45ba1cac5b25b61498ce93c3eb, the App DOM regression
performs one text edit, a two-file paste, and import completion. Counting calls to
AppContent's presentation hook and the unrelated Overview gives **3 / 3** extra
executions. The same scenario after migration gives **0 / 0**. This is a targeted
render-count result in jsdom, not a measured claim about frame rate or user latency.
The regression asserts zero additional calls; temporary baseline logs are retained
with PR evidence. Composer action tests cover races, failure, limits and isolation.

Overview uses natural Harness footprints and the compact packing solver. Its store
retains one scene-keyed placement across leaving/re-entering the same scene; reset
clears transient work but preserves this geometry fact. Other scenes start fresh.
Only ConversationOverview computes and commits plans through the existing FIFO.
