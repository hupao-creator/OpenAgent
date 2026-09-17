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
