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

Production Harness projectors, Agent/Report cards, relation projection, and responsive
layout render the snapshots. The Lab has no endpoint for reading local captures.
Actions only record requests and never invoke host commands or mutate the fixtures.
Reset remounts controls; related Report links navigate to the fake Agent in the same
snapshot and offer a return action.

Examples: `/?kind=agent&harness=claude&case=question` and
`/?kind=report&case=overflow`. Resize the window to exercise production layout,
and use the appearance control for light/dark.

Validation: `pnpm lab:thread:check`, `pnpm lab:thread:build`, and
`pnpm --dir apps/desktop exec vitest run tests/single-thread-lab.dom.test.tsx`.
The DOM regression renders all 31 scenes with network fetching forbidden.

The older `capture-scenarios.mjs` and `import-scenarios.mjs` utilities are separate
native diagnostic tools; their output is no longer consumed by this Lab.
The message/detail playground remains `pnpm playground:thread` (port 4176).

The Lab now renders the selected **production card**, without candidate portals or
style overrides. Running cards keep a static Harness logo; settled executions use
a ring with a check, pause, or cross. Waiting and unresolved failures remain explicit,
and active background work prevents an all-done mark.

Model settings occupy their own line. The next line shows `HH:MM:SS | 12.8K tokens`
without prefix icons or a directory. Numerals use SF Mono Regular at 11 px; the unit
uses Rockwell at 10 px. The clock rolls changed digits upward in 260 ms; its colons
pulse from the same elapsed second. Reduced motion disables rolling and blinking.

Authored Harness usage fields supply 11,000 input + 1,800 output tokens. No real
usage is fetched. Only the preview copy of execution timestamps is shifted to begin
at 37 seconds; terminal clocks stay at 37 seconds. Reset restarts the preview clock.
Dark appearance survives URL reloads via `theme=dark`.

On macOS the local Lab font endpoint reads the installed Terminal SF Mono Regular
font. It exposes one fixed font file only and does not copy an Apple font binary into
the repository or build. Electron uses its own application-only system-font protocol;
other environments retain a consistent monospace fallback.
