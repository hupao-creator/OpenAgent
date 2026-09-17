# SQLite application-state results (issue #57)

Measured on macOS arm64 / Node 22.22.2. The [same concurrent public-store workload](SQLITE_BASELINE.md) was repeated three times for v5 and for the SQLite implementation. It uses 12 concurrent streaming Threads (19 MiB Session content), 16 near-limit emoji Reports (~64 MB aggregate HTML), native-admission flushes, terminal commits, a global barrier and reopen. The workload and recovery assertions were preserved; SQLite adds transaction-duration, live DB/WAL size and close-duration observations.

## Initial accepted comparison

Values below are medians of each run's metric, not pooled percentile samples. Limits were fixed before the production switch. Latencies are milliseconds; memory/disk are converted to MiB.

| Metric | v5 | SQLite | Limit | Result |
| --- | ---: | ---: | ---: | --- |
| eventLoopMs.p95 (ms) | 145.62 | 8.88 | 182.03 | Pass |
| eventLoopMs.p99 (ms) | 873.99 | 120.78 | 1092.49 | Pass |
| eventLoopMs.max (ms) | 1514.14 | 292.81 | 1892.68 | Pass |
| streamingMs.p95 (ms) | 1059.59 | 234.32 | 1324.48 | Pass |
| streamingMs.max (ms) | 1095.18 | 265.57 | 1368.98 | Pass |
| admissionMs.p95 (ms) | 1038.89 | 357.62 | 1298.62 | Pass |
| startupMs (ms) | 1095.36 | 484.33 | 1369.21 | Pass |
| memory.peakRss (MiB) | 1185.55 | 1185.83 | 1481.93 | Pass |
| diskBytes (MiB) | 80.04 | 88.21 | 100.06 | Pass |
| terminalMs.p95 (ms) | — | 118.52 | 150.00 | Pass |
| flushMs (ms) | — | 0.16 | 250.00 | Pass |
| transactionMs.max (ms) | — | 214.24 | 250.00 | Pass |
| peakDiskBytes (MiB) | — | 149.82 | 240.13 | Pass |

The per-run largest SQLite transactions were 260.88, 214.24 and 196.52 ms. The first run exceeded 250 ms; the median (214.24 ms) passes the preselected three-run aggregation rule. This is not an every-run latency guarantee, and the outlier remains in the retained raw evidence. The single writer still queues durable admissions; memory-only streaming publication is independent of DB execution. Event-loop metrics include Core validation and IPC/worker copying, not just SQL. RSS is the entire test process including workers, sampled every 5 ms; it is not heap usage. Disk is measured after close/checkpoint, with live DB+WAL volume sampled separately. The same-host runs are reproducible observations, not a promise for other hardware.

The table records the first accepted implementation before later review fixes and page-size tuning. Exact final-head performance, verification and native manifests are published with [PR #62](https://github.com/xinyuan0801/OpenAgent/pull/62); historical passing measurements do not substitute for that candidate's gates.

## Failed candidate and correction

An intermediate implementation failed the fixed peak-RSS budget: 1,633,337,344 bytes median against a 1,553,920,000-byte limit. Its results remain retained as `sqlite-final-{1,2,3}.json`; they are not relabeled as passes. Large Report state validation used `Array.from(html).length`, creating a million-element transient array per near-limit Report. The implementation now reuses the existing allocation-free `exceedsUnicodeLength` helper for that same public limit. This preserves code-point counting (including emoji), with a boundary regression accepting exactly 1,000,000 emoji characters and rejecting one more. It also caches SQLite write statements rather than allocating a new native statement for each entity. The initial accepted three runs are `sqlite-accepted-{1,2,3}.json`; full raw metrics and threshold checks are attached to PR evidence.

These improvements include content-validation allocation changes prompted by the storage benchmark; they should not be attributed solely to choosing SQLite. No global content budget, relaxed Unicode limit, reduced workload or weakened concurrency assertion was used.

## Failure, ownership and native evidence

Behavior tests retain coalescing/max-wait, completed/failed/interrupted terminal pairing, revision guards, atomic fork/reset/full replacement, per-Thread admission, and the deterministic held-Report-preparation ordering. New SQLite tests fail a real statement inside a transaction, terminate its worker immediately before and after COMMIT, reopen, and verify the complete old/new snapshot. A late A → slow B → new A capture is fenced; failed transactions do not publish in-memory success. Read-only loads leave v5 byte-for-byte unchanged. Close waits admitted work and rejects later mutations.

The native acceptance runs the production Main bundle through real Electron and the full `electron-builder` macOS arm64 application. It uses isolated HOME/userData and public `app:update-settings` / `state:load` commands, with a test-only transport wrapper to reach the existing worker fault seam. It first verifies an actual Electron process exiting before the first schema COMMIT, the resulting empty version-zero database, and production initialization/save/normal close/reopen. New databases use 8 KiB pages while that existing interrupted WAL fixture retains 4 KiB pages. It also verifies a real preparation-worker exit, subsequent writes rejected by the failed owner, unchanged durable state and recovery after reopen; statement rollback plus retry, before-COMMIT worker exit (91) and old-state recovery, after-COMMIT exit (92) with rejected unknown outcome and complete new-state recovery, and an uninstrumented packaged save-ack/SIGKILL/reopen/rewrite cycle. Every case then exits normally with all observed native children gone; instrumented cases observe zero live workers at will-quit. An independent SQLite reader checks `integrity_check=ok`, `user_version=6`, WAL and entity-order integrity.

Reproduction:

```sh
pnpm --dir apps/desktop run pack:local:mac
OPENAGENT_SQLITE_EVIDENCE_ROOT=/absolute/new/local/run node apps/desktop/tests/sqlite-state-runtime.electron.mjs
```

The output manifest binds Main, ASAR, executable and test-driver hashes to each case's retained process logs and observed public outcomes. Run directories cannot be silently reused. The existing application lifecycle suite is also run by full isolated verification; its startup-load gate now targets the SQLite read worker rather than a retired v5 file read.

Native evidence is unsigned macOS arm64, Electron 43.3.0 / Node 24.18.1 / SQLite 3.53.1. Built-in SQLite needs no addon rebuild or ASAR unpack rule. Windows/Linux package targets remain declared, but were not executed on this host; run equivalent native recovery smoke on those platforms before claiming validation there. Node 22 SQLite remains experimental, while the Electron-bundled Node 24 API is release-candidate. Driver/Electron upgrades require repeating the compatibility and lifecycle checks.
