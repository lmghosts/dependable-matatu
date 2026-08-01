# L2-TRANSIT-003 v0.5
## Stage Hierarchy & Boarding-Point Resolution

**Status:** FROZEN — supersedes v0.4; §16.5 and DoD 21 amended 2026-08-01 (routing diagnosis corrected)
**Depends on:** L2-TRANSIT-002 v0.3 (schema)
**Affects:** structural layer, pipeline graph build, search index, routing, results UI
**Does not affect:** fare model, observation payload contract, design system
**Ships:** post-beta

All blocking investigations are closed. Two open items remain and neither blocks build: §0.2 (documentation correction) and the render threshold's provisional status pending Q9 (§7.2.6), which affects seven labels and no structure.

### Changes from v0.4
- **Render threshold made a hard edge constraint on the matching, not a post-hoc audit** (§7.2.2) — DA-7 produced assignments at 26 km and 31 km against R = 1,000 m; the union-scoped right-set plus a sum-minimising objective was the cause
- Diameter gate corrected from 400 m to 1,000 m; the tighter value would bind on good landmarks before binding on any corridor (§7.2.3)
- §7.2.4 decision rule restated in clusters, not groups — the two units were being compared against each other
- DA-8 results inlined; DA-7 superseded (§7.2.5)
- Render threshold recorded as provisional against Q9, not settled by residual count (§7.2.6)

### Amendment 2026-08-01 (routing diagnosis corrected)
§16.5 and DoD 21 amended. The original "silent no-route-found" diagnosis for route 70904004810 was incorrect: `add-reverse-trips.js` reverses stop sequences for all trips regardless of `direction_id`, so both physical directions were already routable before the fix. The applied change was a `direction_id` label correction (metadata only); timetable binary was unchanged. See §16.5 for the full correction.

---

## 0. Data provenance

### 0.1 — Resolved
Source is **GTFS-2019, 136 routes**. Publisher TRAINING/digitalmatatus.com, service dates 2012-03-02 to 2020-12-31. The "GTFS-2017, 132 routes" figure in project documentation is wrong and must be corrected at source; it propagates into strategy and operator-facing material.

### 0.2 — Open, same class
Construction yields **2,727 clusters** against documented "~2,100 canonical stages." Clusters cannot outnumber the stages they group. Correct in the same pass as §0.1. Not blocking.

---

## 1. Purpose

Define the stage hierarchy and resolution rules that let a rider name a *place* and receive a correct journey, without being asked which physical boarding point they mean.

## 2. Problem statement

The current model exposes individual stages as selectable origins and destinations. Where stages share a name and are co-located, the rider must guess, and a wrong guess produces "no route found" — indistinguishable from genuine absence of service.

### 2.1 Existing baseline
`groupStopsByName` in `plan.js`, 500 m threshold, client-side multi-combination routing loop. Produces correct results. **Must not regress** (DoD 6).

---

## 3. Governing principle

> **The rider selects a place. The system selects the boarding point.**

Direction is an **output** of routing, never an **input**.

**This binds the search layer as well as the routing layer.** Any field shown in the picker must describe *where a place is*, never *which way a vehicle goes* (§7.2.1).

**Corollary — a derived label must be true.** A disambiguator that is mechanically produced but factually wrong is worse than none, because the rider trusts it and is misled. Truthfulness is therefore enforced as a **constraint on derivation**, not as a filter applied afterwards (§7.2.2).

---

## 4. Hierarchy

### Level 1 — Route Pattern Stop
Ordered position of a stage within one route pattern and direction. Internal only.

### Level 2 — Stage (boarding point)
Physical location where a vehicle stops. **System of record** for route edges, frequency bands, fares. Direction-specific. GTFS ID retained as `external_ref`. Never selectable by the rider.

### Level 3 — Stage Cluster
Named place grouping co-located stages a rider treats as one location. **The only entity exposed in search.** May contain one stage. Membership versioned; IDs never recycled.

### Level 4 — Interchange (RESERVED)
Eleven candidate anchors exist in source data (§6.7) carrying no membership. Reserved so later CBD transfer modelling does not require re-cutting Level 3.

### Invariant
**Every stage resolves to exactly one cluster.**

---

## 5. Schema requirements

### SC-1 — `stage_cluster`
- `id` — stable, never recycled
- `canonical_name`
- `name_normalized` — indexed
- `disambiguator` — NOT NULL where `canonical_name` is non-unique network-wide
- `disambiguator_source` — `matched` | `manual`
- `disambiguator_anchor_id` — FK, nullable
- `disambiguator_pinned` — boolean (§7.2.7)
- `centroid` — `geography(Point, 4326)`
- `hull` — `geography(Polygon, 4326)`, nullable
- `diameter_m` — integer
- `match_tier` — `exact` | `fuzzy`
- `is_anchor` — boolean, quality-gated (§7.2.3)
- `is_interchange` — boolean
- `review_state` — `auto` | `reviewed` | `disputed`
- `schema_version`

### SC-2 — New columns on `stage`
- `cluster_id` — FK, **NOT NULL**
- `direction_hint` — from `trip_headsign` (§9.1)
- ~~`boarding_label`~~ — **removed permanently.** `stop_desc` confirmed empty feed-wide with no alternative source. Column not created.

### SC-3 — `intra_cluster_transfer`
`from_stage_id`, `to_stage_id` (same cluster), `walk_seconds`, `crosses_road`. Symmetric pairs explicit.

### SC-4 — Indexes
B-tree on `stage.cluster_id`; GiST on `stage_cluster.centroid`; trigram on `name_normalized`; **unique on `(name_normalized, disambiguator)`**. No index supports stage-level name search.

### SC-5 — Migration
Reversible structural-layer version bump.

**Pre-flight validation must use a quoted-CSV-aware parser and check full-column type conformance.** Every anomaly in the §16 pass proved to be a column shift from a comma inside a quoted name field. Targeted patches against `awk`-derived findings would have corrupted correct data.

### SC-6 — Virtual cluster origin nodes (pipeline)
Each cluster gets a virtual node with footpath edges to every member, weighted by walk cost. Gives multi-source semantics through a single-source query API without patching the engine and without a client-side combination loop — and unlike the loop, models intra-cluster walk cost inside the graph.

**Verification required:** engine must relax footpaths from the source before round 1 (§15 Q6).

### SC-7 — Network coverage geometry
Union of 1 km buffers around route geometries. Convex hull rejected — the network is radial and a hull would claim coverage in the gaps between spokes. Consumed by PR-3.

---

## 6. Cluster construction

### 6.1 — Name normalization (CC-1)
Deterministic, idempotent. Case folding, whitespace collapse, punctuation stripping, abbreviation expansion (`Rd`/`Road`, `Stg`/`Stage`, `Rndbt`/`Roundabout`, `Jn`/`Junction`, `Est`/`Estate`), Swahili/English variants, ordinal normalization, alias table. Alias table is data, not code.

A **generic-term vocabulary** is maintained here and reused by §7.2.3. Five terms fire against the current pool: *super highway, soko, market, police station, church*.

### 6.2 — Two-tier spatial grouping (CC-2)
**Tier A — exact normalized name match.** Distance is a sanity cap: **500 m.**
**Tier B — fuzzy or alias-mediated match.** Distance primary: **75 m.**

Both transitive within a run, capped by `diameter_m` (§6.5).

### 6.3 — Threshold provenance — READ BEFORE CHANGING
The histogram (§16.6) **does not derive 500 m** and must not be cited as validating it.

What the data establishes: v0.1's 75 m floor was badly wrong — cutting there would have split ~65% of legitimate same-place duplicates. The distribution decays smoothly below 1 km with **no clean gap**, then shows a distinct mode beyond 2 km (40% of pairs) representing different places sharing generic names.

**500 m is inherited from the working baseline (§2.1) under the DoD 6 tiebreaker.** Bounded by evidence, not derived from it. The 260 pairs between 500 m and 2 km are unadjudicated and are the first thing to examine if this is revisited.

### 6.4 — Manual review (CC-4)
Clusters with ≥ 4 members, ≥ 8 routes, or `match_tier = fuzzy` require review before promotion to `reviewed`. Agip is the first case and the calibration reference.

### 6.5 — Diameter cap and its consequence
Dagoretti Market's members sit 130–200 m apart and are typical, not outliers. At 500 m, crossing a cluster is a 6–7 minute walk: material to journey quality.

`diameter_m` computed and stored for every cluster. Clusters exceeding the cap split for review. Access cost modelled in the graph (SC-6) and surfaced to the rider (PR-2).

### 6.6 — Diagnostic use
Size and diameter distributions reported after every run.

### 6.7 — Level 4 scope guard
Eleven stops carry `location_type = 1`: Koja, Ngara, Odeon, Kencom/Ambassadeur, Bus Station, Commercial, Muthurwa, OTC, Tusker/Ronald Ngala, Allsops, Kariobangi Roundabout.

**Zero `stop_times` references, no `parent_station` children** — unboardable phantom nodes carrying no service and no membership data. Therefore:
- **NOT** construction seeds for §6
- A **curated review priority list**
- **Level 4 candidate anchors**, populated after §6
- **Eligible for the disambiguation anchor pool** (§7.2.3)

---

## 7. Search requirements

### 7.1 — Core
- **SR-1** — Search index built on `stage_cluster` only.
- **SR-2** — No API response populating a picker may contain a `stage.id` as a selectable value.
- **SR-4** — Where device position is available and permitted, results may rank by distance to centroid. Position never required.

### 7.2 — SR-3: Mandatory disambiguation
**162 normalized names resolve to 451 clusters — 16.5% of all 2,727.** Distribution: 112 names → 2 clusters, 26 → 3, 24 → 4–13. Pattern is generic infrastructure (`Car Wash` → 13, `Junction` → 9, `Garage` → 8, `Corner` → 7) and chains (`Tuskys` → 9, `Shell` → 8, `Equity` → 8, `Naivas` → 5, `Total` → 5).

A picker rendering thirteen identical "Car Wash" rows reproduces the original bug at the search layer. **`disambiguator` is mandatory and derived at construction time.**

#### 7.2.1 — Why not `trip_headsign`
**Principle.** A headsign is a *direction* label. Using it in the picker asks the rider to select an origin by which way vehicles travel — the collapse §3 forbids.

**Mechanics.** A cluster is served by many routes with many headsigns, so "first headsign from any serving trip" is non-deterministic. And it does not separate: thirteen "Car Wash" clusters will not yield thirteen distinct headsigns, since several share a corridor.

#### 7.2.2 — Assignment by constrained matching
Greedy per-cluster assignment is **withdrawn**. Measured against the real pool it separated only **65.9%** of ambiguous clusters, and greedy assignment was the cause: each cluster independently claiming its nearest anchor manufactures collisions that set-wise assignment avoids.

Disambiguation is a **per-group assignment problem**, solved once per ambiguity group:

- **Left set:** all clusters sharing a `name_normalized` (2–13 members)
- **Right set:** quality-gated anchors (§7.2.3) within R of any group member
- **Edge set:** all (member, anchor) pairs **where distance ≤ render threshold**
- **Solve:** maximum-cardinality matching first, minimum total distance second, among truthful assignments only

**The render threshold is a hard constraint on the edge set, applied before the solver runs.** Pairs beyond it have **no edge**.

This is not a refinement — it fixes a real defect. Under v0.4's formulation, the right-set was scoped to anchors near *any* group member, so a 3-member group could be assigned an anchor 26 km from the member that received it. Sum-minimisation then actively selected such edges, accepting one enormous distance to shave a few hundred metres across the rest. DA-7 produced assignments at 26,453 m and 31,404 m against R = 1,000 m. The objective was trading truthfulness for total distance, exactly inverting the §3 corollary.

**Implementation note — do not use a sentinel cost.** Representing excluded pairs as a large-but-finite "forbidden" value reintroduces the same failure: a finite cost is a number the sum can trade against, and a sentinel chosen carelessly relative to real distances admits illegal assignments silently. Excluded pairs must carry **no edge**, on a solver handling rectangular or incomplete graphs. Where a dense-matrix solver is unavoidable, a **post-solve assertion** that zero assignments exceed the threshold is mandatory (DoD 22).

Unmatched clusters are **infeasible** and escalate to manual (§7.2.4). This collapses v0.4's two residual categories into one honest bucket: *no feasible truthful assignment exists*.

Group sizes are 2–13 and candidate sets are small. Cost is negligible.

#### 7.2.3 — Anchor pool and quality gate
Uniqueness is not usefulness. DA-6 surfaced "super highway" as nearest anchor for five eastern-corridor clusters at 2.4–4.5 km — a unique name describing a 20 km corridor, useless as a landmark.

`is_anchor = true` requires all of:
1. `canonical_name` unique network-wide
2. `diameter_m` ≤ **1,000 m**
3. `canonical_name` is not a bare generic term from the §6.1 vocabulary
4. Serves at least one route, **or** is one of the eleven `location_type = 1` nodes (§6.7)

**On condition 2's value.** The gate is **inert against current data** — the widest unambiguous cluster is Museum at 686 m — but it is correctly *shaped*. A 400 m gate would also be inert, and was rejected: it would exclude Museum, Roysambu, Donholm, and Westlands Terminal, which are wide because they are high-traffic multi-platform stops, before excluding a single corridor. The one corridor in the data is caught by condition 3 on its name. A gate that binds on good landmarks before binding on any bad one is wrongly shaped even when it never fires, because it will fire wrongly if the data shifts. Corridors and plazas differ in shape, not size, and raw diameter cannot separate them at 400 m.

**Resulting pool: 2,282** — 2,276 unambiguous clusters, minus 5 generic-term exclusions, plus the 11 `location_type = 1` nodes.

#### 7.2.4 — Manual escalation
An external admin-boundary dataset — government sub-locations, bounding boxes, or OSM — was considered and is **not adopted**. Introducing a licensed external spatial dataset creates a versioned, joined, maintained dependency, disproportionate to measured load.

**Decision rule, stated in clusters:**
- **Residual ≤ 50 clusters:** manual curation. `disambiguator_source = 'manual'`, reviewed once, pinned. No dataset.
- **Residual in the hundreds:** revisit with a real number attached.

*(v0.4 stated ~30 without a unit and was compared against a group count. Both figures are now in clusters.)*

**DA-8 at 800 m: 16 residual groups, 24 residual clusters.** Well inside the bound — manual curation, no dataset.

#### 7.2.5 — Determined parameters (DA-6, DA-8)

| Parameter | Value | Source |
|---|---|---|
| Anchor search radius R | 1,000 m | DA-6 |
| Diameter gate | 1,000 m | DA-8 |
| Generic-term exclusions | 5 | DA-8 |
| Anchor pool | 2,282 | DA-8 |
| Render threshold | 800 m *(provisional, §7.2.6)* | DA-8 |
| Groups matched | 146 / 162 (90.1%) | DA-8 |
| Residual | 16 groups, 24 clusters | DA-8 |

**R = 1,000 m.** Nearest-anchor distances across 451 ambiguous clusters: P50 109 m, P75 219 m, **P90 396 m**, P95 807 m, P99 2.47 km, max 4.57 km. 96.2% have an anchor within 1 km. Widening does not help outliers — they fail truthfulness anyway, so a wider radius buys false labels rather than good ones.

**Residual composition at 800 m:**
- **6 groups, 14 clusters — no anchor within threshold:** ngomongo (2), mitikenda (2), kwa roy (2), kamakis (2), onyatta (2), st. joseph (3)
- **10 groups, 10 clusters — insufficient distinct anchors, one member unmatched each:** quickmart (1 of 4), makutano (1 of 3), githogoro (1 of 2), corner (1 of 7), engen (2 of 3), kwa kanisa (1 of 2), twisters (1 of 2), kiambaa (1 of 3), kambembe (1 of 2), zambezi (1 of 2)

**On the reported improvement.** DA-8's 9.9% residual is not directly comparable to greedy's 34.1%: the greedy figure counted collisions only, while the matching figure bundles collisions with truthfulness failures — a criterion the greedy test never applied. Like for like, the **collision rate fell from 34.1% to roughly 3%.** The redesign performed substantially better than the headline suggests.

The constrained edge set also improved matching quality where alternatives existed: `corner` (7 clusters) and `quickmart` (4) each resolve with a single unmatched member, the remainder matched to nearby truthful anchors that sum-minimisation had been discarding.

#### 7.2.6 — Render threshold: the label must be true
*"Car Wash (near Allsops)"* is only correct if Allsops is near. At P90 = 396 m it is. At P95 = 807 m it is a stretch. A rider trusting a false label is actively misled — worse than showing no disambiguator (§3 corollary).

- Proximity phrasing permitted only below the render threshold, enforced as an edge constraint (§7.2.2)
- Beyond it, the cluster escalates to manual regardless of anchor availability
- Phrasings that soften distance are **not** a workaround; directional phrasing ("towards X") is prohibited outright (§7.2.1)

**800 m is PROVISIONAL, pending Q9.** Both measured outcomes are recorded:

| Threshold | Groups matched | Residual groups | Residual clusters |
|---|---|---|---|
| 800 m | 146 / 162 | 16 | 24 |
| 600 m | 140 / 162 | 22 | 31 |

**This parameter must not be set by residual count.** 800 m was initially preferred because 600 m "adds 6 residual groups for no benefit" — but those seven clusters *are* the benefit if 800 m is not genuinely near. The difference in workload is trivial curation; the difference in honesty is not. The parameter answers to how Nairobi riders actually locate places (Q9), and is settled only when that is answered.

#### 7.2.7 — Assignment stability
Matching is globally optimal **per group**, so adding one cluster can reshuffle every label in that group. Under RR-7 — rebuild on any cluster change — a rider would see a place rename itself between releases.

- Once a cluster reaches `review_state = 'reviewed'`, its assignment is **pinned**
- Rebuilds re-solve only unpinned clusters, treating pinned anchors as unavailable
- Unpinning is an explicit reviewed action, never an automatic consequence of a rebuild

#### 7.2.8 — Verification
`(name_normalized, disambiguator)` unique network-wide. Checked, not assumed. Enforced by unique index (SC-4) and DoD 18.

---

## 8. Routing requirements

- **RR-1 — Multi-source origin seeding.** Queries issue against the cluster's virtual origin node (SC-6); footpath relaxation reaches every member at true walk cost before round 1. Where device position is available, member access costs compute from the rider's actual position.
- **RR-2 — Multi-target arrival.** Minimum arrival across all members, per round, preserving the Pareto set. Egress walk cost included.
- **RR-3 — Intra-cluster transfers.** Footpath transfers between rounds, with additional penalty where `crosses_road`.
- **RR-4 — Round bound unchanged.** `k = 2`.
- **RR-5 — Boarding point selection.** Winning journey determines the boarding stage. Ties break on shorter access walk, then stable stage ID.
- **RR-6 — No directional input.**
- **RR-7 — Graph build boundary.** Membership baked in at pipeline build time. **Cluster changes require a full graph rebuild** — see §7.2.7.

---

## 9. Presentation requirements

### 9.1 — PR-1: Destination-facing direction
Direction expressed as terminus: *"towards Kasarani."* Compass directions prohibited.

**Source: `trip_headsign`.** Fully populated with clean destination labels ("Ruaka", "Ngara", "Koja", "Limuru", "Ruiru"). No derivation required. The last-stop-in-sequence fallback is **dead code and must not be implemented.**

Note the asymmetry with §7.2.1: headsign is correct in *results*, describing a journey already assigned, and wrong in *search*, where it would ask the rider to choose by direction.

### 9.2 — PR-2: Boarding instruction
*"Board at Dagoretti Market — towards Town."* Where access walk exceeds a configured threshold, the walk is shown explicitly. No physical cue is available (SC-2); PR-2 renders fully without one.

### 9.3 — PR-3: Failure copy
Against SC-7: `NO_SERVICE` (inside coverage, no journey) vs `OUT_OF_COVERAGE` (outside the geometry).

### 9.4 — PR-4: Design system
Inherits DESIGN.md. Tabular figures on times, fares, walk distances. Custom currentColor SVG. No emoji.

---

## 10. Explicit non-propagation

- **NP-1 — Fares stay at stage-pair and route level.** Not keyed to cluster, not aggregated to cluster. Every boarding is a separate payment; fares vary by direction and operator. Collapsing to cluster would flatten precisely the variation the condition-aware fare range exists to expose. **Cluster is a search and routing abstraction only.**
- **NP-2 — Route geometry unchanged.**
- **NP-3 — Observation contract unchanged.**

---

## 11. Correction loop

- **CL-1** — New observation type for same-place and split assertions.
- **CL-2** — Observations never mutate the structural layer directly.
- **CL-3** — Deferred until a live user base exists; type defined now so the schema is not re-cut later.

---

## 12. Kenya Data Protection Act — flag

- Correction observations store a coarsened position or none in Act 1
- No stable device identifier attached to a correction observation
- Rider position used for access-cost computation (RR-1) and search ranking (SR-4) is **ephemeral and query-scoped** — never persisted, never written to observations
- Full residency and processing review remains a formal checkpoint at the **Act 1 → Act 2 boundary**

Flag, not a resolution.

---

## 13. Out of scope

- `boarding_label` and physical-cue curation — **permanently**
- External admin-boundary dataset — **rejected on measured load** (§7.2.4)
- Level 4 interchanges and CBD walk-transfer modelling
- OSM street-network walking layer
- Multi-transfer routing (k > 2)
- Rider-facing cluster editing UI
- **Dependency, not out of scope:** routing engine footpath-relaxation behaviour (§15 Q6)

---

## 14. Definition of done

1. `SELECT count(*) FROM stage WHERE cluster_id IS NULL;` returns **0**
2. No stage in more than one cluster
3. `normalize(normalize(x)) = normalize(x)` across the full name set
4. Same-name distance histogram archived — **satisfied** (§16.6)
5. Size and diameter distributions reported and archived
6. **No-regression:** every stop set grouped by the 500 m baseline stays within one cluster. Any split requires individual justification.
7. Dagoretti Market: `0700AMD`, `0703DGT`, `0713DMM` in one cluster; Route 1 journey succeeds from it
8. Clusters with ≥ 4 members, ≥ 8 routes, or `match_tier = fuzzy` have `review_state != 'auto'`
9. Agip reviewed and signed off
10. Grep: no rider-facing search or picker endpoint returns `stage.id` as selectable
11. Grep: no rider-facing string contains a compass direction token
12. Bidirectional regression across a known opposite-side pair
13. Singleton clusters route identically to pre-change
14. Fare outputs byte-identical to pre-change for a fixed journey sample (NP-1)
15. Routing seed logic contains no conditional on null cluster membership
16. Clusters above the diameter disclosure threshold surface walk distance in results
17. Both `NO_SERVICE` and `OUT_OF_COVERAGE` reachable and correctly distinguished
18. `(name_normalized, disambiguator)` unique network-wide; zero null disambiguators where the name is non-unique
19. Grep: `trip_headsign` does not appear in any search or picker code path (§7.2.1)
20. Migration pre-flight uses a quoted-CSV-aware parser and passes full-column type conformance
21. Route `70904004810` `direction_id` corrected before bidirectional expansion: trip 70048111 relabelled `direction_id` 0→1. Provenance: `pipeline/gtfs-patches.json` patch p001, applied automatically by `add-reverse-trips.js`. **The "silent no-route-found" diagnosis in §16.5 did not apply** — routing was already correct after expansion; the label was wrong, not the graph. Timetable hash unchanged: 6fc1d352. (§16.5)
22. **Zero anchor-derived disambiguators exceed the render threshold.** Asserted post-solve, not assumed from the edge filter (§7.2.2)
23. **Grep: no sentinel or "forbidden" cost constant appears in the matching implementation** (§7.2.2)
24. Matching is deterministic — two runs over identical input produce identical assignments
25. Pinned assignments survive a rebuild unchanged (§7.2.7)
26. Anchor gate applied — no `is_anchor = true` cluster fails any §7.2.3 condition
27. All 24 residual clusters carry `disambiguator_source = 'manual'` and a reviewed label

---

## 15. Open questions

1. **How often is a Nairobi stage genuinely two-sided?** Evidence favours GPS scatter as dominant. If wrong, `crosses_road` calibration matters more than currently weighted.
2. ~~Where does the same-name histogram break?~~ **Answered** — no clean gap below 1 km.
3. **Do riders treat any CBD termini as one place** — and which? Determines whether Level 4 is genuinely deferrable.
4. **What is the natural direction cue per corridor** — terminus, tout call, or route number? Headsigns supply a clean default; whether they match spoken usage is a PSV-knowledge question. A technically correct but unrecognisable label fails PR-1's purpose. **Does not block build.**
5. **Do any boarding points move by time of day?** If so, cluster membership needs a condition dimension, changing §5.
6. **Does the routing engine relax footpaths from the source before round 1?** Blocking for SC-6. If no: patch for multi-source seeding, or retain the client loop as recorded technical debt — noting the loop cannot model intra-cluster walk penalties and cannot satisfy RR-3.
7. **What is the acceptable graph rebuild cadence?**
8. ~~DA-6: nearest-anchor distances~~ **Answered** — R = 1,000 m.
9. **Does *"X (near Y)"* read naturally to a Nairobi rider, and at what distance?** Sets the render threshold between 600 m and 800 m — a seven-cluster difference in labels, no structural consequence. The construction is borrowed from UK convention; if people locate generic stages by estate, road, or spoken terminus instead, §7.2.6's phrasing changes while the matching mechanism does not. **Does not block build.**

---

## 16. Pre-build check — EXECUTED

### 16.1 — `stops.parent_station`
**Not populated.** Zero stops. The earlier 30-row figure was a quoted-comma artifact. §6 is a full construction pass.

### 16.2 — `stops.location_type`
**Eleven stops carry `location_type = 1`** (§6.7). No unexpected values under a correct parser.

The reported `location_type = 36.72053576` on `0800ACB` ("ACK, Bidii Premier School") was a **false positive** — the comma in the name shifted columns under `awk`, surfacing the stop's longitude. **There is no data error to fix.**

### 16.3 — `stops.stop_desc`
**Confirmed permanently empty.** `boarding_label` removed.

### 16.4 — `trips.direction_id` and `trip_headsign`
**Both fully populated.** All 272 base trips carry `direction_id` (137 × 0, 135 × 1); headsigns carry clean terminus labels throughout.

### 16.5 — Direction label defect (amended 2026-08-01)
**Route `70904004810` had two `direction_id = 0` trips and zero `direction_id = 1`** — sole offender across 136 routes before the patch.

**Original diagnosis (incorrect):** "A unidirectional route is a silent no-route-found on the return leg." This was wrong for this specific route. `add-reverse-trips.js` reverses stop sequences for **all** trips regardless of `direction_id`. Route 70904004810 has two base trips with completely different stop sequences and opposite geographic shapes — both physical directions. After bidirectional expansion the graph therefore already contained valid stop_times for both directions. No routing gap existed before the patch; neither did one exist after.

**Actual defect:** Both base trips were mislabelled `direction_id = 0`. Trip 70048111 (headsign "Westlands", Yaya→Westlands direction) was incorrectly marked as `direction_id = 0` instead of `1`. This violated the feed convention (direction_id=0 = toward first segment of `route_long_name`; "Yaya-Kasuku-Westlands" → first segment = "Yaya" → direction_id=0 applies to the Westlands→Yaya trip 70048110).

**Fix applied:** `direction_id` of trip 70048111 changed 0→1 (metadata only). Script: `pipeline/patch-70048111-direction.mjs`. Provenance: `pipeline/gtfs-patches.json` patch p001. The patch is now applied automatically at the start of `npm run pipeline:bidir` via the manifest apply step in `add-reverse-trips.js`.

**Confirmed routing impact: none.** Timetable hash `6fc1d352` was unchanged before and after the patch. `direction_id` is not part of the RAPTOR binary.

**Evidence:** Zero shared stop IDs between the two trips (step 2 gate correctly fired during inspection). Shape analysis: trip 70048110 runs SW→NE (-1.266, 36.801)→(-1.292, 36.787); trip 70048111 runs NE→SW (-1.292, 36.787)→(-1.266, 36.801). These are genuine opposite-direction trips, not a missing-reverse case.

(DoD 21.)

### 16.6 — Same-name pairwise distance histogram
5,031 pairs across 949 names with ≥ 2 members. ~55% within 500 m; a thin 500 m – 2 km stretch (260 pairs); 2,018 pairs (40%) beyond 2 km. P50 242 m, P75 7.75 km, P90 17.7 km, max 58 km. The > 2 km mode is generic names on distinct places — the finding that produced §7.2. Reading and limits: §6.3.

### 16.7 — DA-6 and DA-8
Recorded at §7.2.5. DA-7 is superseded and its assignment figures must not be cited: they were produced under the unconstrained edge set (§7.2.2).

---

## 17. Sequencing relative to beta

The existing client-side implementation (§2.1) is reliable enough for beta. This document ships as **post-beta structural formalisation** and is **frozen at v0.5**.

Outstanding, none blocking:
- **§0.2** — documentation correction, parallel
- **Q9** — sets the render threshold at 600 m or 800 m. Seven clusters, no structure. Answerable from the field after freeze.
- **Q4** — phrasing of `direction_hint` against spoken usage
- **Q6** — engine footpath behaviour. Verify at the start of implementation, not before.

No further revisions before beta ships.

---

*End of L2-TRANSIT-003 v0.5 — FROZEN (amended 2026-08-01)*
