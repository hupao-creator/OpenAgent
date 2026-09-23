# Core command and completion schemas

This refactor implements [Issue #56](https://github.com/xinyuan0801/OpenAgent/issues/56).
Its acceptance contract is preservation of the existing public behavior while
consolidating structural definitions with the existing Zod version.

## Ownership

Public command structures belong to `@openagent/contracts`. Core owns internal
metadata completion structures. Main continues to own
filesystem authorization, attachment management, composition membership and
execution/interaction state checks. JSON payload validation does not authorize
Core to interpret Harness session state, native payloads or private settings.

GUI IPC and headless HTTP invoke the same command handlers. HTTP can represent
only JSON; explicit JavaScript `undefined`, sparse command arrays and ArrayBuffer attachment imports
remain transport-specific inputs, not values to silently coerce to JSON.

## Sources

- `packages/openagent-contracts/src/command-schemas.ts` owns command structures and reusable runtime primitives. Main maps parse failures to ordinary field errors; Zod issue arrays are not a transport protocol.
- `packages/openagent-contracts/src/public-response.ts` owns the representable interaction response shape and its stricter runtime validation.
- `apps/desktop/src/main/internal-run-schemas.ts` derives metadata model JSON Schema from shared representable structures.
- `apps/desktop/src/main/internal-runs.ts` applies product normalization and fallback. The service retains execution-time authorization.

Model conversion follows [Zod JSON Schema conversion](https://zod.dev/json-schema)
with unrepresentable constructs rejected. Model constraints are for generation;
the runtime parser does not parse against the model schema.

## Preserved units and stages

| Boundary | Existing rule |
| --- | --- |
| Command strings | JavaScript UTF-16 code units, NUL rejected by the ordinary command-string primitive; empty/whitespace handling remains field-specific. Settings routing guidance retains its separate rule, which allows embedded NUL. |
| JSON envelopes | UTF-8 bytes of serialized JSON, including JSON punctuation and escaping; limits remain field-specific. |
| Model JSON Schema strings | JSON Schema `minLength`/`maxLength` describe Unicode code points. |
| Metadata semantic strings | Title 60, tag name 32, tag description 120 Unicode code points after existing normalization. |
| Public response message | UTF-16 code units at runtime (including supplementary characters). |

Metadata runtime parsing requires the closed object, strings and closed tag
objects. It deliberately accepts structurally valid values outside the model's
requested lengths/counts. Product validation then falls back for invalid title
or emoji, filters/canonicalizes tags, and preserves current tags when none are
valid. Tightening runtime parsing to the model constraints would change this
partial recovery behavior.

Manual interaction responses retain structural validation and execution checks.
A parsed response still requires the currently pending interaction and valid
action at execution time. Automatic approval belongs to each Harness.

Model JSON Schema must be derived only from representable structures. Runtime
refinements and transforms must stay outside conversion, with their differences
documented explicitly; conversion must never opt into silently dropping them.

## Acceptance

- A1: Schema-owned command and completion structures infer shared types and remove fully replaced duplicate definitions.
- A2: Equivalent JSON requests have the same acceptance, rejection and service arguments through GUI handlers and headless HTTP.
- A3: Unknown fields, required/optional presence, null/undefined, empty strings, NUL, Unicode units and serialized-byte ceilings retain their behavior.
- A4: Model JSON Schema derives from representable shared shapes; runtime and semantic differences are explicit.
- A5: Metadata fallback/tag preservation and manual response validation and state checks remain unchanged.
- A6: Core validates public envelopes and JSON boundaries without interpreting Harness-owned data.
- A7: Public command and representative model behavior regressions, type checks and architecture checks pass.
