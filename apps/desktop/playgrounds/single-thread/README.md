# Single Thread Lab

Run `pnpm lab:thread` and open http://127.0.0.1:4178/.
No account, native CLI, capture manifest, or local snapshot directory is needed.
The same fake snapshots are bundled into `pnpm lab:thread:build` output.

The Lab contains 31 deterministic, explicitly labelled **模拟快照** scenes:
13 Agent states for each of Codex and Claude Code, plus five Report cases.
They are authored in `src/fake-snapshots.ts` against the current Harness structures,
validated by each Harness's state decoder and the Renderer snapshot schema, and
frozen before hydration. They contain invented identifiers, text, and paths only.
They demonstrate UI states, not claims about a native runtime's capabilities.
Claude scenes show the model display sample `deepseek-v4-pro · max`, observed in
local Claude Code execution metadata on 2026-09-20. Only those two display values
are copied; the scenario content remains authored and the Lab does not read logs.

Production Harness projectors, Agent/Report cards, relation projection, and responsive
layout render the snapshots. The Lab has no endpoint for reading local captures.
Actions only record requests and never invoke host commands or mutate the fixtures.
Reset remounts controls; related Report links navigate to the fake Agent in the same
snapshot and offer a return action.

Overview cards omit archive/restore buttons and the old Bart footer entry.
The shared production identity uses five raw text lines in a normal (1×1) card
and eight in a tall (1×2) card, inside the fixed grid height.

Agent card excerpts render literal strings directly, with no Markdown parser or
worker. Markdown markers, code fences, links, and HTML-like text stay visible as
text; inner whitespace and newlines are preserved. The Harness still chooses the
current message and bounds its excerpt, while CSS handles wrapping and line limits.

Examples: `/?kind=agent&harness=claude&case=question` and
`/?kind=report&case=overflow`. Resize the window to exercise production layout,
and use the appearance control for light/dark.

Validation: `pnpm lab:thread:check`, `pnpm lab:thread:build`, and
`pnpm --dir apps/desktop exec vitest run tests/single-thread-lab.dom.test.tsx`.
The DOM regression renders all 31 scenes with network fetching forbidden.

The older `capture-scenarios.mjs` and `import-scenarios.mjs` utilities are separate
native diagnostic tools; their output is no longer consumed by this Lab.
The message/detail playground remains `pnpm playground:thread` (port 4176).

The Lab renders the selected **production card** using its fixed grid occupancy.
Keep card heights tied to their grid footprint rather than content height so content
updates do not trigger Overview relayout. Spacing refinements stay inside that footprint.

Running cards keep a static Harness logo; settled executions use
a ring with a check, pause, or cross. Unresolved failures remain explicit;
questions and approvals rely on their interaction panels without duplicate badges. Active background
work prevents an all-done mark. All statuses retain accessible logo labels.

Model settings occupy their own line at the selected 12 px size.
The next line shows `HH:MM:SS`, a divider, and a 12 px Lucide `Combine` icon before
the token count. The clock has no prefix icon; no directory is shown.
Numerals use SF Mono Regular at 11 px. Changed clock digits crossfade in 180 ms; its colons
pulse from the same elapsed second. Usage digits retain their 260 ms upward roll.
Reduced motion disables both transitions and blinking.

The icon is a fixed prefix, followed by left-aligned numerals at their natural
width. Digit-count and K/M/B changes grow to the right without a reserved leading gap
or moving the prefix. Usage transitions use the
selected upward roll (260 ms); the candidate controls have been removed.
The accessible usage label still includes the full count and the `tokens` unit.

The selected Combine icon suggests weighted aggregation in the
[Transformer architecture](https://arxiv.org/html/1706.03762v7#S3); this is a design
metaphor, not standard notation. The shared card and Lab use this icon directly;
the candidate selector and `tokenIcon` URL parameter have been removed.
Abbreviated token counts always retain one decimal place, including trailing zeros
(`13.0K`, `100.0K`, `1.0M`, `1.0B`). Counts below 1,000 remain integers.

Authored Harness usage fields supply 11,000 input + 1,800 output tokens. No real
usage is fetched. **播放用量变化** adds 100 output tokens every 1.6 seconds to a preview
copy, through the existing Harness formatter and card. Pause, single-step, and reset
controls let you inspect carry transitions such as `12.9K → 13.0K → 13.1K` without
remounting the card or altering its footprint. Switching scenes resets the demo.
**进位／换单位** steps through decimal, digit-count, and K-to-M boundaries, up to 1.1M,
then returns to 12.8K, so the unit position can be compared at each boundary.
Only the preview copy of execution timestamps is shifted to begin
at 37 seconds; terminal clocks stay at 37 seconds. Reset restarts the preview clock.
Dark appearance survives URL reloads via `theme=dark`.

Normal (1×1) Agent cards also expose a **正文 Buffer** demo. An authored producer
sends 120 characters immediately, then 240 every 240 ms, through native Harness
message state. Shared production components display at most 600 Unicode code
points per batch, then wait at least 800 ms after reveal settles before advancing.
The final batch stays visible. **新 message 插队** replaces the previous queue.

The console pauses only simulated input; production buffering continues. Restore,
scene changes, and reset cancel the demo. Source snapshots remain immutable.
Initial production snapshots retain their bounded excerpt without replaying old
backlog. Subsequent updates use full current-message text and native message IDs;
authoritative rewrites reset the cursor. Scheduling stays inside the excerpt leaf.

Normal Agent cards prioritize **发送消息** in the Harness logo position on hover or
keyboard focus, even before buffer playback starts. The 16 px Lucide glyph
has no background or border, with the existing 32 px hit area. The card's pause
button is removed; the console retains playback controls.

The send entry is locked to the **纸飞机** (`Send`) icon at 16 px with 1.5 px strokes.
The candidate selector and `sendIcon` URL setting are removed; the existing Dock
follow-up handler remains connected.

The new entry calls the same `openThreadFollowUp` handler passed to the Harness
card's `onFollowUpOpen`, opening the existing production `BartDock` direct follow-up
UI. There is no new inline editor, input state, or change to message playback.
The Dock retains its existing draft, submit, and close interactions. In this Lab,
its submit callback only records the follow-up request: no host command runs and
no source snapshot changes. Archived/attention cards remain ineligible. Scene
changes/reset close the Dock. The old pause icon candidates and `pauseIcon` URL
setting are removed.

The existing fixed card footprint and excerpt clipping remain in effect: a batch
is not a promise that all 600 characters fit on the card. The Lab shows received character counts and an optional full-message disclosure.

**正文动效** is locked to the supplied Transitions.dev **Texts reveal** CSS:
each visible line enters over 500 ms from 12 px below with a 3 px blur, staggered
by 40 ms. All exiting lines fade in place over 200 ms with no stagger, movement,
or blur. Copies clipped to the existing line boxes provide separate animated
lines without changing the raw text or its layout. The outgoing text is captured
before React's next synchronous text commit. The real body is
revealed and all copies removed after the last line settles; only then does the
800 ms hold begin. New messages interrupt the in-flight entrance immediately.

The other candidates, selector, and `messageTransition` URL parameter have been
removed. Buffer playback, pause, replay, and message interruption controls remain.
Only message/batch boundaries animate, not each appended stream fragment. The
temporary, inaccessible line copies never change card layout. Reduced-motion
preferences disable the animations, and the 800 ms dwell begins after settling.

On macOS the local Lab font endpoint reads the installed Terminal SF Mono Regular
font. It exposes one fixed font file only and does not copy an Apple font binary into
the repository or build. Electron uses its own application-only system-font protocol;
other environments retain a consistent monospace fallback.
