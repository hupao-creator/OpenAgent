# Local debug log

The desktop main process writes local diagnostic records as newline-delimited
JSON (NDJSON). The log is intended for local development and incident
investigation; there is no in-app viewer or log service. Values are kept as
provided, without redaction, for text and protocol fields. Binary or base64
attachment bodies may be represented by a binary marker instead of being
stored. The logger also applies the hard per-event byte limit described below.

## Location and mode

The log directory is `<Electron userData>/debug-logs`. A file is created early
in main-process startup, after the effective Electron `userData` path has been
selected. Each file name contains a timestamp, process ID, random boot ID, and
part number:

```text
openagent-<timestamp>-pid<pid>-boot<bootId>-part<part>.jsonl
```

The directory is created with mode `0700`; files are created with mode `0600`.
The random boot ID and part number keep concurrent processes and rotations in
separate files. A disposable development profile reset preserves this
directory so previous runs remain available to retention cleanup.

The effective mode is selected from `OPENAGENT_DEBUG_LOG` when it is one of
`off`, `summary`, or `detail`. When the variable is absent or invalid, the
default is `detail` for development and `off` for a packaged runtime. The
packaged decision uses `isPackagedRuntime`, including the existing fixed
development-app exception. An explicit environment value is an opt-in
override, including for a packaged process.

Modes behave as follows:

| Mode | `debugLog` | `debugError` | `debugDetail` |
| --- | --- | --- | --- |
| `off` | disabled | disabled | disabled |
| `summary` | enabled except `level: "debug"` records | enabled | disabled |
| `detail` | enabled | enabled | enabled |

`getDebugLogMode()` returns the effective mode. `debugLog` defaults the module
to the prefix before the first dot in the event name (`service.shutdown` is
`service`); callers can provide `module` explicitly. The default level is
`info`; accepted levels are `debug`, `info`, `warn`, `error`, and `fatal`.

## Record schema

Every complete line has `schemaVersion: 1` and these envelope fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Integer schema version, currently `1`. |
| `ts` | Wall-clock UTC timestamp in ISO-8601 format. |
| `seq` | Monotonically increasing sequence number within this process boot. |
| `pid` | OS process ID that emitted the record. |
| `bootId` | Random ID shared by files from one process boot. |
| `level` | `debug`, `info`, `warn`, `error`, or `fatal`. |
| `module` | Explicit module or event-name prefix. |
| `evt` | Stable event name. |

The following optional correlation fields are copied to the envelope when
present: `traceId`, `spanId`, `parentSpanId`, `threadId`, `executionId`,
`nativeSessionId`, and `harnessId`. Other payload fields remain top-level JSON
fields so existing `debugLog(evt, fields)` calls remain easy to inspect.

`createDebugTrace()` creates a new trace ID. `withDebugContext()` merges a
context into Node's async-local context, and subsequent records inherit it.
`startDebugSpan('work')` emits `work.started`, then exactly one of
`work.completed` or `work.failed`; completion is idempotent. Completed and
failed records contain `durationMs`, measured from a monotonic clock and never
from wall-clock timestamps. A started record includes `durationMs: 0`.

`debugError()` stores an `error` object with the error name, message, stack,
enumerable properties, `cause`, and `AggregateError.errors` when available.
Circular values, getters that throw, functions, symbols, and BigInts are
converted to JSON-safe diagnostic values. This conversion is a serialization
guard and does not intentionally redact application values.

## Size, queue, and failure behavior

The writer is asynchronous. It batches up to 64 records or 512 KiB per write
and keeps at most 8 MiB of queued and in-flight encoded records. A 512 KiB
portion is reserved for summary/error records. Detail records are discarded
first when the bound is reached; a later `debug-log.dropped` record reports the
number discarded. If the process exits before a marker can be queued, that
last marker is necessarily unavailable.

The encoded JSON object plus its NDJSON newline is at most 256 KiB. When an
event exceeds the limit, the record contains `truncated: true` and
`originalBytes`, the UTF-8 byte count of the complete encoded record before
truncation. String values retain a prefix where space permits; large
structured values receive a bounded truncation marker. The envelope remains
valid JSON even when a caller supplies an unusually large event or context
identifier.

The active file rotates before a write would exceed 20 MiB. The threshold can
be changed with `OPENAGENT_DEBUG_LOG_ROTATION_BYTES` (the compatibility alias
`OPENAGENT_DEBUG_LOG_MAX_FILE_BYTES` is also accepted). Rotation and retention
are best effort and never block business operations.

Retention runs at startup and after rotation. It removes log files older than
7 days and then removes the oldest eligible files needed to keep total log
bytes at or below 1 GiB. Configure these values with:

```text
OPENAGENT_DEBUG_LOG_RETENTION_DAYS=<non-negative number>
OPENAGENT_DEBUG_LOG_RETENTION_BYTES=<non-negative byte count>
```

Compatibility aliases `OPENAGENT_DEBUG_LOG_MAX_AGE_DAYS` and
`OPENAGENT_DEBUG_LOG_MAX_TOTAL_BYTES` are accepted. The current file is always
preserved. For another live process, retention preserves the highest part
number for each `(pid, bootId)` group, which is the active part; older rotated
parts can still be removed. Stale files from exited processes are eligible by
age and total-size policy. A process or filesystem race can leave extra files
temporarily, because retention never removes a file after a live-active check
passes for the current scan.

If directory creation, file creation, rotation, or a stream write fails, the
logger disables itself and writes one short diagnostic to stderr. Public
logging functions and `flushDebugLog()` resolve without throwing into
application code. `flushDebugLog(timeoutMs)` waits for queued writes up to the
given bound (default one second). The quit coordinator calls it with a one
second bound after service shutdown. The final synchronous Electron lifecycle
events (`app.quit` and the last phase transition) are therefore best effort;
they can be lost if Electron exits before the stream callback completes.

## Main-process lifecycle records

The entrypoint initializes logging before service startup and records
`app.bootstrap` with the working directory, app/runtime versions, runtime kind,
headless state, and user-data path. It also records service startup and the
existing quit/window lifecycle events. `uncaughtExceptionMonitor` and process
warnings are observed as `process.uncaught-exception` and `process.warning`
records. The monitor hook does not become an exception handler, so the normal
fatal-exception behavior remains in place.

## Diagnosing Bart latency

Start with `app.bootstrap`. Its `userDataPath` field is the authoritative
profile location; the log directory is `<userDataPath>/debug-logs`. This avoids
assuming a platform-specific path when several profiles or Electron instances
are running:

```sh
rg -n '"evt":"app\.bootstrap"' /path/to/debug-logs
```

For a Bart request, inspect the span pairs in this order. A span base name
emits `.started`, `.completed`, or `.failed` records:

| Stage | Event names to inspect |
| --- | --- |
| Submit and queue | `bart.submit`, `bart.send`, `bart.admission.queued`, `bart.admission.released` |
| Context | `bart.context.refresh`, `bart.context.collect`, `bart.context.rule`, `bart.context.refresh.snapshot`, `bart.context.assembled` |
| Targets | `bart.targets.catalog.prepare`, `bart.targets.catalog.describe`, `bart.targets.discovery`, `bart.targets.assembled`, `bart.targets.options.parsed`, `bart.targets.availability`, `bart.targets.result` |
| Harness boundary | `harness.thread.send`, `harness.provider.send`, `harness.execution.admission`, `harness.execution.terminal`, `harness.availability`, `harness.bart.settings.*`, `harness.bart.target.*` |
| CLI and provider preparation | `claude.detect-installation`, `claude.resolve-environment`, `claude.catalog.probe`, `claude.catalog.result`; `codex.detect-installation`, `codex.resolve-environment`, `codex.cli-version.probe`, `codex.catalog.probe`, `codex.catalog.models`, `codex.catalog.result` |

The terminal summaries are `claude.execution.summary` and
`codex.execution.summary`. Both use the `*DurationMs` fields:
`durationMs`, `messageSentDurationMs`, `firstReasoningDurationMs`, and
`firstTextDurationMs`. These
are offsets from the execution start, so they are not independent durations
to add together. Child spans also overlap their parent and often overlap one
another; do not sum `bart.submit`, harness, provider, and renderer spans.
Compare the relevant start/end pair, or subtract two offsets when you need an
interval between milestones.

The renderer reports `renderer.first-reasoning-commit` and
`renderer.first-text-commit` with `threadId`, `executionId`, and `durationMs`.
Join these records to main/provider records using those IDs. Do not infer a
trace ID from timestamps or event order. Renderer `durationMs` is an
effect-to-next-frame measurement only; it does not include cross-process send
latency. The next `requestAnimationFrame` is an observation checkpoint, not
proof that the frame has physically reached the display.

Changes to startup logging or instrumentation are loaded when Electron starts.
Stop and restart the development process from the worktree containing the
changes, for example:

```sh
cd /path/to/OpenAgent
pnpm --dir apps/desktop dev
```

Then use the new `app.bootstrap` record to confirm the profile and log path.

## Useful `rg` recipes

Set the directory for the current profile first:

```sh
LOG_DIR="$HOME/Library/Application Support/Agent Workspace/debug-logs"
```

Find startup and quit transitions:

```sh
rg -n '"evt":"(app\.bootstrap|app\.started|app\.before-quit|app\.quit-phase|app\.will-quit|app\.quit)"' "$LOG_DIR"
```

Find all errors and failed spans:

```sh
rg -n '"level":"(error|fatal)"|"evt":"[^"]+\.failed"' "$LOG_DIR"
```

Follow one trace or execution across files:

```sh
rg -n '"traceId":"TRACE_ID"|"executionId":"EXECUTION_ID"' "$LOG_DIR"
```

Inspect records for one thread or native session:

```sh
rg -n '"threadId":"THREAD_ID"|"nativeSessionId":"SESSION_ID"' "$LOG_DIR"
```

Find truncation and queue pressure:

```sh
rg -n '"truncated":true|"evt":"debug-log\.dropped"' "$LOG_DIR"
```
