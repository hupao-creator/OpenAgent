# Claude module ownership

`main/index.ts` assembles capabilities. `main/thread/controller.ts` owns one
Thread's native transport, execution claims, read cancellation, commit queue
and shutdown. The ordinary `openThread` accepts generic instruction/context/seed
injection and `extend` or `exclusive` tool bindings; its Handle owns the MCP bridge
and releases it with the transport. Injection is installed before initialization
admits the first model request. Exclusive tools do not change native permissions,
questions or `respond`. Its input, timeline, state, interaction and observation modules
operate on explicit values; they never receive the controller or own a second
Thread lifecycle. The pure session-state adapter derives public observation from
that persisted state, while `settle` changes only the named execution. Native
background tasks remain Session work after foreground completion.
`main/prompt.ts`, `settings.ts` and `telemetry.ts` own their
separate capabilities, including disposal of temporary native usage transports.
`shared/settings.ts` defines the full generic Thread request/default profile and
creation options schema. Creation accepts only optional `model`, `effort` and
`permissionMode`; executable, goal mode and tool filters remain internal/default
settings and are inherited when creating a Thread. `settings.describe` and GUI presentation read the same
catalog; settings resolution enforces native combinations. `main/evaluation.ts`
contributes final advisory text through Plugin Kit, without filtering native
configuration choices. The Main Plugin retains and disposes its evaluation lease.

`renderer/index.tsx` assembles the public renderer plugin. `ThreadView` owns the
Thread surface; `thread/TurnView`, `Notifications`, `InteractionPanel` and
`Activities` own their respective view state and controls. `OverviewCard` and
`Settings` are independent entry components. State decoding, labels and small
presentation primitives are shared within the renderer and do not import Main.

The public package entries, native transport protocol, state format and
interaction identities remain defined by the existing module contracts. Moving
a capability must not create another owner for its execution or resource scope.
