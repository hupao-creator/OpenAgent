# Application appearance

Issue #60 adds the Core-owned `appearance` preference: `system` (default),
`light`, or `dark`. It uses the existing settings validation, durable commit,
and publication path. A settings draft does not change the effective theme;
only a committed settings mutation does. View-only saves bypass Harness availability
probes and Bart context/lifecycle reconfiguration. The current strict persistence schema
policy applies; this feature does not migrate historical settings.

Main owns Electron `nativeTheme.themeSource`, sets it from committed settings
before creating the first window, and keeps native window colors synchronized.
Electron propagates this effective appearance to Chromium, including its
`prefers-color-scheme` and `light-dark()` resolution. Renderer and Harness views
inherit `color-scheme: light dark`; they own no separate preference and never
decide the scheme. Changing appearance does not remount views or touch Thread
lifecycle, execution, inputs, attachment ownership or selection.

A committed appearance change is animated: the renderer captures the outgoing
frame, waits for the propagated scheme to follow the mutation, and dissolves the
swap. That observation is transient and holds no state — Main still decides the
outcome, and a change that leaves the resolved scheme alone is not animated.

Report cards and host controls use application colors. Isolated report HTML
retains its own CSS and receives no additional host capability.

## Acceptance and evidence

- A1: Chinese/English appearance choices; successful save, failed save,
  automatic application, retained failed input and persisted restart behavior.
  See [Settings automatic save](settings-autosave.md) for submission timing.
- A2: All three preferences against both system appearances; live system
  changes affect only system preference and all surfaces resolve consistently.
- A3: Shell, boot, overview/filter, Bart, Thread/composer/attachments, settings,
  overlays/dialogs and Report host controls have readable light/dark surfaces.
- A4: Codex and Claude settings/transcripts, Markdown, code, tables,
  tools, errors and waiting states inherit application appearance.
- A5: Text, links, icons, borders, focus and interactive/status colors remain
  distinguishable, including brand marks.
- A6: Native startup/reopen/window chrome and the opaque window background agree
  with the committed theme without a visible full-window wrong-theme flash.
- A7: Switching preserves running execution, draft, attachments, selection and
  reading position.
- A8: Behavior regressions, light/dark screenshots and real Electron evidence
  record the actual platform and remaining coverage limitations.

The native appearance regression also runs in the full verifier’s lifecycle step.
Verification results are recorded in the implementation PR; this document does
not imply that pending checks have passed.
