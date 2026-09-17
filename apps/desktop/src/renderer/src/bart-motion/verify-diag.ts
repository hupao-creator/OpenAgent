// Scratch tracing for the generation pipeline: the test installs
// `window.__diag` before driving the lab, and these calls record how far the
// layout-revision pipeline got. Deleted with the probe branch.
export function diag(event: string, detail?: unknown): void {
  const sink = (globalThis as { __diag?: unknown[] }).__diag
  if (!Array.isArray(sink) || sink.length > 400) return
  sink.push(`${event}${detail === undefined ? '' : ':' + JSON.stringify(detail)}`)
}
