# Pi Agent Harness

Pi Agent is a persistent OpenAgent Harness, a Bart Host and a Bart task target. Pi manages its
own upstream model providers, credentials and native session files. The plugin
uses `pi --mode rpc` in a separate process; no Pi SDK or credential material is
bundled into Renderer.

## Brand asset

The Renderer uses Pi's official adaptive logo, bundled from [`pi.dev/logo-auto.svg`](https://pi.dev/logo-auto.svg). The official [Pi repository README](https://github.com/earendil-works/pi/blob/main/README.md) identifies that asset as the Pi logo. OpenAgent keeps the SVG inline in `src/renderer/pi-logo.ts` so every host surface receives the same logo without a network dependency.

## Installation and configuration

The supported RPC series is **0.83.x**, tested with **0.83.0** on macOS. Startup
checks the CLI version and rejects older, unknown or newer minor versions with
an upgrade/configuration diagnostic, rather than waiting for completion events
that another protocol may never emit.

```sh
npm install -g @earendil-works/pi-coding-agent@0.83.0
pi --version
pi
# In Pi, use /login for your provider, or configure its documented credentials.
```

See Pi's [provider setup](https://pi.dev/docs/latest/providers) and
[RPC reference](https://pi.dev/docs/latest/rpc). Existing Pi configuration,
including custom providers/models, stays owned by Pi. OpenAgent does not copy
credentials into Thread settings. Standard installation detection checks PATH;
the host always auto-detects the executable and offers no setting for it.

Thread creation and settings updates accept only `provider`, `model` and
`thinkingLevel`, rejecting additional fields. The host resolves the Pi executable
and each Thread retains it; it is never accepted as a Thread option. `settings.describe` and every GUI/Bart creation resolve through
the same Main API. Model choices come from `get_available_models`; supported
thinking levels come from `get_available_thinking_levels` for the selected
model in that process. Model/thinking configuration uses session-local CLI flags;
the plugin never sends the RPC setters that rewrite Pi global defaults. Changing
settings restarts the idle connection against its existing native session. Only
the selected model carries thinking hints in presentation; the resolver queries
the actual requested model for every creation/update. Scoped schema examples are not a Core-maintained allowlist. Invalid
provider/model pairs and unsupported reasoning values fail before task input.
Resolved executable/model settings are pinned to each Thread. An executable
cannot change once history exists; model and thinking changes affect the next
Execution. Omitted options inherit configured defaults; `null` clears a selection
and restores its native default through the resolver. Changing provider or model
clears inherited thinking unless `thinkingLevel` is explicitly supplied.

A startup probe is independent of presentation and catalog discovery. It checks
startup and the configured model. Native catalog/auth presence is not proof that
a remote service will accept an expired token: actual model errors remain failed
Executions with diagnostics. An explicit Host `providerOverride` supplies an
isolated provider catalog, endpoint, key and model for discovery, Threads and
metadata requests. It writes only inside `harnessDataRoot` and uses per-process
settings; it does not require `/login` or change global Pi configuration.
Conflicting provider selections fail explicitly. Normal execution still uses
Pi's own configuration. The Desktop `test:harness-health` entry point uses a
local Mock LLM across every Harness, without a real API key.

## Execution and interaction semantics

- One open Thread has one Handle and at most one native process. Native startup
  is deferred until the first admitted send, using the current Core-prepared
  worktree directory when present. Reading committed history starts no process.
- `prompt` success means **accepted**, not completed. Only `agent_settled` ends a
  normal Execution; `agent_end` can still be followed by retries or queued work.
  Streaming assistant text, thinking and tool activity are committed through the
  owning state projection; streaming assistant text also updates the public Execution
  summary so cancellation observers can identify native output before settlement.
  Native errors/aborts select failed/interrupted outcomes.
- A send during an active Execution maps to Pi **steering**, delivered at its
  native steering boundary. It remains part of that Execution. There is no
  separate follow-up queue selector in this version; an idle send starts a new
  Execution. Caller cancellation governs request acceptance; after acknowledgement,
  interruption uses the Thread Handle or its lifetime signal, so Bart tool return
  cannot cancel an accepted target task.
- Interrupt terminates the owned native process and settles as interrupted. A
  later send reconnects the persisted session through the same Handle. POSIX
  process-group termination also covers tool subprocesses. All waits, pending RPC
  requests, listeners and UI timers are cleaned up on failure/disposal.
- RPC extension `confirm`, `select`, `input` and `editor` requests become ordinary
  waiting-for-user interactions. Responses are validated against current IDs,
  actions and options. A timed-out native dialog fails the Execution explicitly;
  rerun to request fresh input. Unknown methods fail rather than auto-confirming.
  Notification/status/widget/title/editor-text updates appear as native activity;
  arbitrary TUI layout and automatic composer editing are not supported.
- Pi has no built-in permission prompt for each ordinary tool. Extensions that
  implement RPC-compatible prompts are supported. Custom TUI-only interfaces are
  not. Slash commands are rejected with a clear message; they can bypass normal
  prompt execution/admission and are not a supported Thread input API. Autonomous
  extension work outside an admitted Execution is also unsupported.
- Text, local files/mentions/skills and local images are supported. Images use
  Pi's native base64 `ImageContent`. Remote image/audio input kinds fail explicitly.
  Native tool errors are shown as tool results; a model may recover and complete.

## Persistence, fork and views

OpenAgent persists the plugin's private state and pure public observation in one
commit. Transcript rows and historical Execution references stay stable across
reopen and application restart. A recovered in-flight run becomes interrupted;
streams and RPC callbacks are never pretended to survive process restart.

A completed native session is snapshotted in its original JSONL format. Fork is
a pure derivation of that immutable snapshot, with no latest Execution. On the
child's first send the plugin loads an isolated staging copy and invokes native
`clone` (current leaf, `position: "at"`), then resumes the independent session.
It never opens the source file for writing. The source can advance before the
child opens without changing the child's history. Empty/unpersisted sessions and
active runs cannot fork. Historical checkpoint selectors are not exposed.

The plugin projects native assistant messages into the Bart Dock with stable
message identities, including streamed updates and recovered history. It owns
Thread, overview and settings views and uses Plugin Kit reading,
Markdown, interaction, card and settings components. History supports explicit
Execution navigation. Model and last-call token/cache facts are shown only
when supplied by native messages; no usage or evaluation score is invented.

Metadata completion runs an isolated, nonpersistent Pi session with tools,
extensions, skills and prompt templates disabled. It supports text and JSON
outputs, native finish reasons, cancellation, errors and resource cleanup.

## Bart Host

Select **Pi Agent** as the Bart coordinating agent in Settings, using the same
Pi executable/provider/model/thinking settings resolution as ordinary Threads.
The supported Host runtime is **Pi 0.83.x**, tested with **0.83.0**. Install and
log in using the commands above. Host startup reuses Pi's installed runtime,
environment credentials and native authentication files; OpenAgent does not
copy keys or modify Pi's global model defaults. Provider extensions are disabled
for Host isolation: use a built-in provider or Pi's documented custom-model
configuration rather than an extension that registers a provider.

Host execution uses RPC plus a Harness-owned extension, with a private inherited
duplex pipe separate from native stdout and RPC stdin. The extension registers
only this Handle's injected tools. Calls carry both a connection-local identity
and the original Pi tool-call ID; Main invokes the existing Core tool binding
with that original ID, JSON arguments and a cancellation signal. JSON results
return to the awaiting native tool; thrown errors become native error tool
results. Unknown/replayed/unadmitted calls terminate the owned connection.

Exclusive mode is enforced by Pi's **native registry allowlist**:
`--no-tools --tools <injected names> --no-extensions -e <owned bridge>`.
An empty injected set uses `--no-tools` without an allowlist. Discovery of user
extensions, skills, prompt templates and context files is disabled. The startup
handshake checks the exact active tool set before any user prompt is admitted
to the native process. The allowlist applies to built-in and extension tools,
including registry reload and resumed sessions; persisted history never grants
tool permissions. Only `exclusive` is exposed. Ordinary Pi task Threads retain
their normal native tools/extensions and continue to use the existing RPC path.
Context-only injection without an exclusive tools request also preserves native
tools and adds its instructions to the native system prompt.

Instructions and Thread context form the bridge's immutable system prompt,
reapplied for every primary prompt and reinstalled on reopen/restart. A seed,
when provided, is explicitly labeled historical data. Per-send context is
included once in its native user input (including steering), so later sends do
not repeat earlier runtime context. Each connection receives its own injection;
no context or binding is read from another Thread or restored as authority from
native session data.

The existing Handle remains the single lifecycle owner. Interrupt, disposal,
startup failure and process/bridge disconnect abort pending bindings and discard
late results. A new send reopens the existing native session with a fresh pipe,
bridge and the current injected whitelist. Temporary extension source is written
with mode 0600 under the Harness data directory and removed after loading (also
on startup failure). It has only Node built-in imports and is generated by the
packaged Main code outside ASAR; Pi/SDK dependencies are not bundled into Electron
or Renderer. Missing/unloaded bridge or a mismatched tool set fails startup with
a reinstall/extension diagnostic instead of running without Host restrictions.

The alternative isolated-process [SDK](https://pi.dev/docs/latest/sdk) can supply
custom tools, a resource loader and native session manager too. The chosen
[RPC](https://pi.dev/docs/latest/rpc) plus
[extension](https://pi.dev/docs/latest/extensions) route reuses the established
process, event, session recovery, authentication and packaging path. In-process
SDK embedding would change fault isolation; a separate SDK worker would require
another protocol adapter and installed-module resolution. Revisit this route if
Pi removes the explicit-extension/registry-allowlist contract. A plain RPC client
without the bridge cannot satisfy Host tool-result injection.

## Verification

Behavior coverage lives in this package's `tests/pi-rpc`, `tests/pi-settings`,
`tests/pi-thread`, `tests/pi-prompt`, `tests/pi-host-bridge` and
`tests/pi-renderer.dom` tests. It covers protocol/version checks,
acceptance/completion, retry, steering, cancellation, dialog responses, abnormal
cleanup, preparation ordering, state projection, restart and independent clone.
Existing plugin isolation tests inspect Main/Renderer/shared dependencies and
generated registration. Full delivery additionally requires `pnpm verify` and
independent standards/specification reviews; focused tests do not replace them.

Real Pi 0.83.0 evidence for this delivery is linked from
[PR #95](https://github.com/xinyuan0801/OpenAgent/pull/95): native tool output,
multi-turn memory, reopen/clone, production GUI, RPC interactions and real Codex
Bart task orchestration. The first Bart run exposed caller-signal cancellation
after acknowledgement; the regression was fixed and the real flow rerun. Native
Windows/Linux application packaging and arbitrary third-party extensions have
not been validated in this delivery.

Opt-in native Host coverage uses the Desktop
`apps/desktop/tests/harness-injection-native.mjs --host pi`
and the Bart headless `host`, `lifecycle`, `reports`, and `resilience` suites.
`tests/pi-host-isolation-native.mjs` additionally proves trusted project extension
exclusion on first open/reopen and unchanged ordinary extension discovery. It
uses existing native credentials for model calls; startup-only trust probes use
an isolated settings directory without copying credentials. Configure its
`OA_PI_EXECUTABLE`, `OA_PI_PROVIDER`, `OA_PI_MODEL`, and `OA_PI_THINKING` environment
variables as needed. Real macOS production GUI close/reopen and cold-restart
evidence is recorded on [PR #117](https://github.com/xinyuan0801/OpenAgent/pull/117).
