# Thread document reading

Implements #63 for Codex and Claude Code in Agent and Bart. Report is unchanged. (OpenCode, originally covered here, was removed with its Harness.)

## Acceptance

- A1: Five turns become four historical document links and the latest full turn; empty, single and long histories retain timeline windowing.
- A2: Links have underlined prompt titles, one-line plain-text answer summaries, actual completion times, no emoji or card border, and a divider before the latest turn.
- A3: Subpages retain complete Markdown, attachments and plugin content; back restores scroll and opener focus, Escape returns.
- A4: One shared breadcrumb navigates to the existing Host destination or parent document; each segment is capped at 216px and shrinks on narrow screens.
- A5: Each entry animates 28px/360ms with cubic-bezier(.22,1,.36,1); animations play normally regardless of the system reduced-motion preference.
- A6: Streaming, new turns, waiting interactions and Thread switches retain Harness semantics; historical interactions cannot submit stale responses.
- A7: Local timestamps and documented token scope use monospace numerals; absent values are never fabricated.
- A8: All three Harnesses and Agent/Bart shells support light/dark and narrow layouts.
- A9: Reading state remains ephemeral and shared presentation accepts opaque nodes; no new execution or session owner.
- A10: Behavior, types, build, local review and isolated delivery verification pass on the final candidate.

## Ownership

Harness renderers choose historical rows and project prompts, summaries, finishedAt and usage. Plugin Kit owns reading navigation, windowing, presentation and focus. Host injects its existing back action through ThreadDetailFrame. No native state is interpreted by Host.

## Historical content visibility (#132)

Every historical subpage visit starts with user messages and work hidden, leaving assistant replies readable. Its two independent buttons use the existing localized Show/Hide user messages and Show/Hide work labels and expose their current state with `aria-pressed`. Showing one category does not reveal the other; complete Markdown, attachments and plugin content remain available when their category is shown.

Pi projects historical assistant thinking as a separate work row, so the hidden default also covers reasoning while retaining the assistant answer. Its current-turn presentation remains unchanged.

Plugin Kit owns these temporary Renderer choices per mounted history visit. Returning and reopening, selecting another historical row, switching Threads or receiving a new explicit navigation request resets both choices. Ordinary Session publications retain the current visit's choices. Parent document visibility (including running-turn work expansion) is independent and is preserved on return, along with existing scroll and focus restoration. Agent and Bart use the same Harness-projected rows and shared presentation; no visibility setting is persisted or sent to Core/Harness lifecycle owners.

## Usage provenance

Codex turn.usage is the latest thread/tokenUsage/updated `last` snapshot; input includes cached input and output includes reasoning. Display as last model call, never whole turn.

Claude turn.usage sums deduplicated generation events in mergeClaudeTurnUsage; summary events add only cost. Native inputTokens excludes cache reads/writes, which are separate input categories. Only display a total when all input categories and output are available. Reasoning is an output subset.


The one-line summary parser reads at most 1,024 source characters and keeps at most 256 cached prefixes. This bounds repeated historical parsing during streaming; the opaque full turn node retains the entire Markdown and all attachments. Scroll restoration clamps naturally if new layout shrinks the document below the old position.

Historical list titles and their tooltips are limited to a 240-character single-line preview. The separate document title retains the full prompt for the selected page heading and breadcrumb tooltip; no native prompt or answer is modified. This avoids materializing repeated multi-megabyte text nodes for a history window.

Harnesses pass memoized summary content nodes. Markdown conversion executes only when the timeline mounts the corresponding entry; unchanged mounted summaries skip recomputation during streaming, including histories larger than the bounded shared cache. Unloaded history is not parsed.

## Explicit report Execution navigation

Report links carry a public `readingTarget` (`executionId`, unique `requestId`, click-time `mode`, optional opaque `message`) into the existing Thread renderer. The owning Harness maps its Execution ID to its native document row; Core and Plugin Kit do not infer native row identities from public Execution IDs. Plugin Kit consumes each request once and keeps the selected page stable across subsequent Session publications. The Host compares the linked Execution against the public latest Execution at click time to choose current or historical reading. Harnesses validate existence for both modes and preserve that decision even if a newer Execution arrives before rendering. Missing historical rows display an unavailable page with a path back to the Thread and the original overview navigation; they never fall back silently to a different Execution.

A request that also carries `message` narrows the landing from the Execution to one row the Harness resolves privately: the Harness returns a Plugin-resolved `anchorId` alongside `rowId`, and Plugin Kit scrolls that row to the top of the reading area and hands focus to the reading area once per `requestId`. `anchorId` is a row identity from the Plugin's own document, never a Core selector, and a target that no longer resolves — stale, foreign or malformed — degrades to the Execution row without stealing focus. Streaming relayout, Session refreshes and repeated renders of the same `requestId` never move the reader a second time.

Main's existing Session adapter also exposes pure `resolveExecution(state, executionId)`. Only the owning Harness interprets durable history and returns the public execution facts used to validate report references; the Host never inspects native turns or introduces another history/lifecycle owner.
