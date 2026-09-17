# Overview Motion Playground

Run `pnpm playground:overview` from the repository root and open
[localhost:4179](http://127.0.0.1:4179/). No native CLI, account or captured session is needed.
Package source changes rebuild through the existing workspace watcher; Renderer changes use Vite HMR.

The playground mounts the production `ConversationOverview`, Harness projectors, cards,
layout motion FIFO and camera cockpit. Its inputs reuse the Single Thread Lab's frozen,
validated fake snapshots. It uses the production default layout planner and owns
scenario inputs and trigger timers. Card actions
record preview intent; they never call the Desktop bridge, fetch captures or execute a Report.

Seven repeatable scenes cover 24-card compact packing, entry/exit and reordering,
question growth/shrink, a four-revision burst, Canvas framing, Report
consolidation, and scene-cut cancellation. Link directly with
`/?scene=packing|lifecycle|resize|queue|camera|report|cut` (choose one value).
Use the next-step button or automatic playback; the interval changes **input timing**, not
production animation duration. Pausing stops future inputs and lets queued motion settle.
Reset or selecting another scene remounts Overview to clean up pending work and manual camera
state. The explicit cut action keeps Overview mounted and changes its production scene key.
The free controls can interrupt a running demonstration and queue more input during motion.

The planner uses real Harness footprints (running fixtures are 2×1) with no
viewport column cap. Grid starts come from its placements. The existing FIFO
plays exit → per-axis shrink → ordered straight moves → grow → entry, including
every intermediate revision. Reordering input changes reading order while keeping
identity positions when zero travel remains legal. The layout readout reports
bounds, aspect, unscaled survivor distance and search-completion status. A failed
search reports its error and retains the prior geometry; it does not silently use
CSS placement. The application and this scene use the same production packing policy.

The camera scene begins with one card and expands to 18 cards. All content sizes use the
same Canvas. Automatic framing leaves 24 screen pixels (16 in narrow layouts) and
clears the measured toolbar. Dock can overlap cards. Small layouts can pan freely.
Use “离开 Overview” and “返回 Overview” to exercise the production camera bookmark:
manual views restore unchanged; automatic views restore first, hold for 600ms from
the first visible frame, and then follow the latest layout. Inputs can change while away.

The camera scene expands to 18 cards. Scroll over the Canvas to zoom, drag its background
to pan, then use the production “回到自动视图” button in the preview's top-right corner.
Manual control remains active when inputs change; scene cuts reset to automatic framing, as in the app. Viewport presets cap the
preview width at the selected size; the available window can make it narrower. Light and
dark appearances use the same production styles. The readout shows actual camera state,
live scale and whether the shared stage is busy. The preview allows zoom down to
5% (the application keeps its 60% floor); it does not infer queue completion from
the script's step counter. Bart's streamed task-generation demo remains in `pnpm lab:bart`.

Check with `pnpm playground:overview:check` and `pnpm playground:overview:build`.
Behavior regressions are in `tests/overview-motion-playground.dom.test.tsx`; the existing
`overview-motion.test.tsx` and `conversation-overview.dom.test.tsx` cover the motion owners.
The normal root typecheck and test commands include this playground.

## Independent Layout scene

Open [Layout](http://127.0.0.1:4179/?scene=layout) or use its header link.
Seven presets include the 24-card 4×6 baseline, growth, historical offsets,
aspect-first reflow, four shorter moves versus three longer moves, removal of a
middle card without a hole, and a blocked diagonal that requires two straight moves.

The hard constraints include hole-free final geometry and collision-free straight
moves, one move per survivor in an executable order. Among legal compact layouts,
physical aspect is first and total unscaled Euclidean travel is second. Moved
member count is only an observation. A slider shows the ordered movement process.
A bounded one-step candidate search precedes unrestricted search. Search work and
completion are visible: zero travel is certified; completed floating search and
budget-limited feasible results do not claim an exact nonzero distance optimum.

Step backward/forward, edit a member, generate a repeatable sequence from a seed,
or export/import its complete JSON counterexample. The geometry uses a fixed
schematic plane and native scrolling, without the camera or motion FIFO. The
schematic scene stays separate from the real-card motion integration above.
Run `pnpm test:layout` for the independent algorithm family; see the
[contract, certificates, search limits and oracle coverage](../../docs/overview-layout-properties.md).
