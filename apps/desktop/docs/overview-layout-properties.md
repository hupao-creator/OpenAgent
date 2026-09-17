# Overview layout properties

Production Overview uses a pure layout solver over IDs, footprints and previous
integer positions. The solver has no DOM measurement, animation clocks, camera
or Harness payloads. `ConversationOverview` commits each result through its
existing motion FIFO; the camera handles viewport changes without repacking cards.

## Legal layouts and transitions

`layoutOverview(previous, next, geometry, options)` takes stable IDs, integer
footprints, previous integer positions and physical cell dimensions. Coordinates
use a fixed non-negative grid origin. Cards cannot rotate or change supplied
final footprints. Input snapshots are immutable. Physical geometry must have
representable positive pitches and aspect; aggregate grid spans/area and prior
coordinate extents must remain safe integers. Unrepresentable derived bounds
fail explicitly. Every outer origin-search iteration consumes budget as well.

Every returned final layout must satisfy all of these geometric constraints:

- Exact next-member identities and footprints, with no overlaps.
- No enclosed vacant grid cells. Every vacant cell must connect to the bounding
  box's exterior through four-neighbour vacant cells. Normal inter-card spacing
  is not a vacant grid cell. Incomplete edges are allowed; a missing member
  surrounded by other members is not. This applies to the final layout, not the
  transient vacancy while a removal is being filled.
- Compact bounds: discard a box when another hole-free packing has both physical
  dimensions no larger and at least one smaller. A larger or square-looking box
  cannot be manufactured by adding blank space.

Movement is also a hard constraint. Each surviving member may move **once along
a straight line to its final position**, in the returned `moveOrder`. Other
members remain still during that move. A member can move after another member
has completed its own final move; there is no temporary parking, detour,
teleport, fade or simultaneous crossing. Every point along the complete swept
rectangle must avoid the interiors of all other present rectangles. Edge contact
is allowed. Checking a few sampled animation frames is insufficient.

The pure transition has these phases: remove exiting members; shrink each
contracting axis at its old top-left; perform the ordered straight moves; grow
each expanding axis at its final top-left; insert new members. The moving
footprint is therefore the per-axis minimum of old and final spans. Shrink and
grow stay within already disjoint old/final footprints. An unchanged member may
still move to its final position to make the overall transition possible, but
cannot move twice or leave and return to the same anchor.

## Ordered objectives

Among legal candidates on the compact geometric frontier:

1. Minimize `max(width,height) / min(width,height)` in physical pixels. Bounds
   include inter-card gaps but exclude surrounding UI padding.
2. Minimize summed surviving members' straight-line Euclidean distance between
   old and final top-lefts in unscaled physical pixels:
   `hypot(deltaCol * (columnWidth + gap), deltaRow * (rowHeight + gap))`.
   New/removed members contribute zero. Resizing in place contributes zero.
   Members have equal weight; moved-member count does not rank candidates.

Width, height and column count have no fixed maximum. Equal-cost results have
stable tie breaking; identical inputs and reordered input arrays give the same
answer. Empty results have zero bounds, zero distance, no moves and `aspect: null`.
Repeating the solver on a returned layout leaves its coordinates unchanged.

The original endpoint-only distance optimum is no longer legal by definition.
For two adjacent horizontal unit cards, the old 433.6 px diagonal shortcut crosses
the stationary card. The legal result moves one down and then the other left,
592 px in total. Deleting card 10 from the 24-card 4×6 arrangement cannot retain
an internal hole: card 09 moves right 376 px, leaving the vacancy at the edge.

The distance-vs-count example uses four cards initially at (4,0), (5,1), (2,2),
(3,3). All four can move along safe straight paths with 1299.3 px total travel;
the best legal three-mover alternative needs 1380.7 px. This replaces the older
separated-horizontal-cluster example, whose two-mover alternatives cross cards.

## Solver, certificates and search budget

Geometry feasibility builds the complete hole-free compact frontier. Minimum
feasible height is monotone in width. A single horizontal row dominates every
box wider than the summed member widths; a vertical column similarly bounds
height. Both witnesses are hole-free. These are derived bounds, not product caps. Every equally optimal physical-aspect box enters movement search.

The movement checker intersects continuous overlap-time intervals. Crossing
another source creates a vacate-first dependency; crossing its final position
creates a settle-after dependency. A stationary blocker or dependency cycle
rejects the placement. An acyclic graph yields an executable order. This is pure
geometry data, not a second runtime animation scheduler.

Larger rectangles use placement backtracking. Unit members use minimum-cost
assignment with dummy rows for vacant cells. Assignments that leave a hole or
lack a valid move order are rejected; conflict branches change an implicated
member's destination or require a vacant hole cell to be filled. Hungarian costs
are floating-point estimates of lower bounds until those constraints pass.
Equal-distance assignment ties prefer a smaller sum of squared individual
costs, without an epsilon weight. Floating-point equality is not exact equality
between sums of real square roots.

### Candidate search followed by full search

After geometry selection, explicitly check whether all survivors can keep their
old anchors in one of the optimal shapes. This fast path also preserves the
positions of a previous budget-truncated result; it does not retain a suboptimal
legacy 3×8 shape merely because its members did not change.

Geometry feasibility rejects boxes that cannot hold even one equal-footprint
group. Homogeneous rectangles use direct row-major packing. Shared widths or
heights permit equal-span bands during geometry feasibility, avoiding impossible
odd-width/height searches. These restrictions do not apply to survivor movement.

Try a deterministic small set of centered/zero origins first. For non-unit cards,
candidate templates include frontier packings, reflections, and packings that
retain old anchors for singleton footprint classes. Rematch equal-footprint slots
by distance, also trying axis-aligned assignments. Every candidate must pass the
full hole and continuous movement checks. These seeds are not a proof that the
best reachable layout uses one of their templates.

Then try placements within one grid step per axis of each survivor's old anchor.
The entire candidate phase consumes at most 1,000,000
logical steps from the overall budget. Its quota and proposal order do not depend
on the caller's budget, so increasing that budget extends the same search prefix.
No member is permanently frozen and moved-member count remains outside scoring.

Then discard the candidate domain restrictions and search the full original
origin/placement domain. For a completely occupied unit box with no new IDs,
the total displacement vector gives an additional origin lower bound by the
triangle inequality. It is combined with the old point-to-box projection bound.
The aggregate bound is not applied to boxes with vacancies, new members or
larger footprints. Its floating evaluation is not a directed-rounding certificate.

Origin search expands beyond the old anchors when necessary. A feasible total
cost bounds origins farther right or down because every surviving member then
incurs a minimum axis displacement. Translating a result is not assumed to
preserve reachability. The full origin enumeration is still potentially costly
for large historical offsets; candidate search now runs before that enumeration.

The 24-card 3×8 → 4×6 example reaches a legal 6153.7594 px candidate within the
default budget, compared with the previous 7104 px. The independent review's
explicit placement and movement order are stored as a regression witness. This
is a known legal competitor, not an independent proof of its global optimum.

### Completion and numerical evidence

Default budget: 2,000,000 logical steps. Returned results pass the geometry and
continuous movement checks and belong to the best geometric aspect selected by
this solver. Geometry selection still ignores reachability until candidate
checking: no fallback to a worse aspect was added. Universal reachability of a
best-aspect shape has not been established; failure to find one is unknown,
not a proof of infeasibility.

`searchComplete: true` means full-domain search completed under the existing
floating-point cost comparisons and pruning. It does **not** prove the exact
real-valued Euclidean optimum. `distanceOptimal: true` is currently reserved
for unchanged survivor anchors (including empty/all-new layouts), where zero
travel meets the unconditional nonnegative distance lower bound. Nonzero travel
remains unproved even after complete floating-point search. Certified nonzero
distance intervals and exact root-sum comparison are not implemented.

If budget expires after a legal candidate is found, return that candidate with
`searchComplete: false`. Otherwise throw `LayoutSearchLimitError` (budget reached
without a candidate). `requireSearchComplete: true` also throws on incomplete
full search, even when a feasible candidate exists. This replaces the previous
`requireDistanceOptimal` option whose name overstated the numerical guarantee.
Invalid/unrepresentable input raises a descriptive input/geometry error instead.
Overview retains its prior successful frame on failure and offers a visible retry; that frame is not
claimed to satisfy the failed next-member snapshot.

`work` records total logical steps, candidate-phase steps, the first verified
candidate's step and the latest improvement's step. There is no cross-call cache
that changes this accounting or search order. The Overview motion playground
exposes this split — zero-distance proof, completed floating search and a
budget-truncated legal candidate — plus total/candidate work counts, through
`onLayoutPlanningState`. The app does not render planning evidence; it only
receives the failure callback to show its retry. Wall-clock duration is measured
externally.

## Independent PBT and replay

Run the algorithm family without a browser or animation clocks:

```sh
pnpm test:layout
FC_EXPLORE=1 FC_RUNS=1000 FC_MAX_COMMANDS=30 pnpm test:layout
```

The normal test/property commands also discover it. Shared `FC_RUNS`,
`FC_MAX_COMMANDS`, `FC_SEED`, `FC_PATH` and `FC_EXPLORE` control runs and emit
exact failure replay commands. A property timeout is a failure.

Coverage is deliberately explicit:

- Tiny exhaustive absolute-placement oracle: up to two old unit members,
  deletion/resizing to spans 1–2, and up to one addition. It compares compact
  physical aspect and minimum distance within its enumerated reachable domain,
  while checking conservation, immutability, deterministic ordering and idempotence.
  Its coordinate cap remains a bounded oracle domain, not a proved bound for all
  reachable layouts. Numerical comparisons use tolerance, not exact root arithmetic.
- The independent movement oracle uses separating-axis tests of swept convex
  polygons and enumerates executable move permutations. It does not reuse the
  production interval calculation or dependency graph. Returned plans are also
  simulated in their supplied order. The independent hole oracle uses union-find
  connectivity to an outside sentinel, not the production flood fill.
- Generated add/remove/resize/no-op histories (up to six live members, default
  15 commands) check geometry, complete moves, determinism, idempotence and safe
  equal-size identity-swap competitors. These histories do not independently
  prove global aspect/distance optimality for every larger mixed packing.
- 24–80 initial unit members compare with the complete independent unit-box
  frontier. 24–60 old members in three columns check optimal aspect and a legal,
  hole-free, executable result within a specified computational budget. The
  latter domain does not claim an independent global distance oracle.
- Four-member translated examples enumerate all 4! assignments in each relevant
  2×2 position and all executable move orders. Moving four must beat the best
  legal three-mover result on total distance.
- Generated interior deletions from 4×6 must fill their enclosed vacancy.
  Translated adjacent-card cases must reject the blocked diagonal shortcut.
  Focused regressions cover historical offsets, growth/shrink, empty layouts,
  no manufactured spacing and explicit budget failure.
- The search family independently enumerates all unit assignments in small boxes
  to check origin lower bounds and repair-branch coverage for stationary blockers
  and dependency cycles. A mixed fixed-rectangle fixture checks hole repair.
  Entrants and vacancies explicitly test the aggregate-bound preconditions.
- Budget properties compare deterministic prefixes, legality of partial results
  and their zero-distance replay. A focused check crosses the fixed local quota;
  separated-card properties require the full search to leave the one-step domain.
  These checks strengthen coverage without making floating bounds certified.

## Renderer integration

`ConversationOverview` uses the compact planner by default. Harnesses receive
natural composition space; viewport width does not alter footprints or bound
packing. The existing stage FIFO resolves each snapshot against the last presented
placement, removes exits, shrinks each contracting axis, moves survivors once in
the supplied order, grows increasing axes, then introduces entrants. Mixed-axis
resizing uses the per-axis minimum footprint during movement. Scene cuts cancel
old plans. A failed search keeps the last successful geometry, shows a retry action,
and releases its stage so later revisions can proceed.

The per-App orchestration store retains one last scene-keyed placement as UI facts
across leaving and re-entering Overview. A different scene starts from empty history.
It acquires no leases and schedules no motion. The grid origin stays fixed; the
existing camera owns fitting and manual control, with the application 60% zoom
floor. Overview always uses this Canvas. Automatic framing uses a screen-space region with
24 px side/bottom margins (16 px at the narrow breakpoint) and the toolbar's actual
bottom plus that margin. Grid bounds exclude UI padding; Dock is allowed to overlap.
Manual panning is unrestricted, including for a single card. Scene changes reset to
automatic framing. App-owned camera bookmarks survive Overview unmounts: manual
views stay restored, while automatic views hold their restored first visible frame
for 600 ms before following current bounds through the existing stage FIFO. Gestures
or navigation cancel pending return motion; hidden transition preparation does not
consume the hold. Viewport changes update the camera without repacking.

The [renderer regressions](../tests/overview-planned-motion.dom.test.tsx) cover
production default placement, scene restoration, retry after failure, per-axis
shrink/move/grow keyframes, camera retargeting, free panning, and return-view timing.

Fault evidence uses isolated test-time module copies. Disabling swept-path
collisions or enclosed-hole rejection must fail the corresponding generated
property and replay at its emitted seed/path. No live source changes are needed.
The candidate-search increment also rejects injected overestimates of origin
bounds, missing cycle repairs and a one-step restriction leaked into full search.
Each fault is detected and replayed through the shared wrapper; shrinking is
recorded, including zero shrinks for an already minimal separated-card case.

## Playground

`pnpm playground:overview` runs real-card motion scenes with the production default
planner. `?scene=packing` starts 24 real Harness cards; `?scene=layout` shows the
pure geometry, physical distance, straight-move order, search work and completion
status at a fixed schematic scale. It supports presets, manual changes, seeded
histories and full case JSON import/export. Generated examples are exploratory
inputs, not property-test passes. The preview alone permits a 5% camera floor.
See the [playground guide](../playgrounds/overview-motion/README.md) for scenarios,
controls and native-bridge isolation.
