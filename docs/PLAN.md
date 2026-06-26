# factoryplan-rust — Implementation Plan

A hybrid finite-capacity scheduling + Gantt visualization tool. Takes demand,
factories (with bay counts), and products (with per-quarter lead times) and
produces a backward-scheduled plan showing what ships on time and what
doesn't — plus recommendations on how to clear any shortfall.

Combines ideas from:
- **finiterust** — bay-grid scheduling primitive, Excel import, quarterly summary
- **gantt-rust** — modular backend structure, Actix-web stack, deployment configs, React/Plotly frontend pattern

---

## 1. Decision summary

| # | Decision |
|---|---|
| Demand granularity | Monthly or quarterly (selectable per row) |
| Demand explosion | Evenly spread across period (default); start/end selector |
| Lead time | Per **(product, quarter)** — factories are interchangeable |
| Gap between builds | None (v1) |
| Blocked days | None (v1) |
| Scheduling direction | **Backward** from due date |
| Placement order | Earliest required-start (`due_date − lead_time`) first |
| Factory allocation | Global greedy — all bays one pool |
| Past start dates | Allowed, not flagged |
| Recommendations | All three side-by-side: bays needed, uniform %-LT reduction, per-product LT targets |
| Outputs (v1) | Per-factory Gantt, shipment summary, recommendation panel, unshippable list, CSV/Excel export |
| Codebase | New project; cherry-pick from gantt-rust (structure, deploy) and finiterust (bay-grid primitive) |
| Persistence | SQLite |
| Scenarios | Named, switchable, cloneable (no compare view in v1) |

---

## 2. Tech stack

### Backend — Rust 2021
- Actix-web 4, Tokio, Actix-cors
- `sqlx` (compile-time checked SQL) with SQLite driver
- Chrono, Serde, UUID, thiserror, env_logger
- Calamine (Excel import)

### Frontend — React 19 + TypeScript
- Vite, Tailwind, Plotly.js (react-plotly.js), Lucide, xlsx, axios

### Deploy
- Docker (multi-stage), Fly.io (backend), Netlify (frontend)
- Configs lifted/adapted from gantt-rust

---

## 3. Data model (SQLite)

```sql
scenario(id, name, created_at, updated_at, is_active)

factory(id, scenario_id, name, bays)

product(id, scenario_id, name)

product_lead_time(id, product_id, year, quarter, lead_time_days)
  -- one row per (product, quarter); UNIQUE(product_id, year, quarter)

demand(id, scenario_id, product_id, period_type, year, period_index, quantity, spread_mode)
  -- period_type: 'month' | 'quarter'
  -- spread_mode: 'even' | 'start' | 'end'

-- Results (regenerated per run; not user-edited)
schedule_run(id, scenario_id, run_at, total_demand, shipped_on_time, unshippable)

scheduled_unit(id, run_id, demand_id, product_id, factory_id, bay_index,
               required_start, due_date, status)
  -- status: 'shipped' | 'unshippable'

recommendation(id, run_id, rec_type, payload_json)
  -- rec_type: 'bays_needed' | 'uniform_lt_pct' | 'per_product_lt'
```

---

## 4. Core algorithm

### Scheduling (backward, greedy)

```
plan(scenario) -> ScheduleRun:
  units = []
  for d in scenario.demand:
    n = d.quantity
    dates = explode(d.period, n, d.spread_mode)        # evenly-spaced due dates
    for due in dates:
      q = quarter_of(due)
      lt = product_lead_time(d.product, q)
      units.push(Unit{due, lt, product: d.product, req_start: due - lt})

  units.sort_by(req_start)                              # 8a heuristic

  # Bay pool: each bay = sorted list of reserved (start, end) intervals
  pool = init_bays(scenario.factories)

  for u in units:
    bay = pool.find_first_free_in([u.req_start, u.due])
    if bay:
      pool.reserve(bay, u.req_start, u.due, u)
      u.status = shipped
    else:
      u.status = unshippable

  return ScheduleRun(units, pool)
```

### Recommendation pass (only when shortfall > 0)

1. **Bays needed** — binary-search add-bay count (1, 2, …) and re-run; pick smallest count that clears shortfall. Suggest factory = the one whose bays were most utilized in the failed run.
2. **Uniform LT % reduction** — binary-search a multiplier `m ∈ (0, 1]` applied to all lead times; find smallest `1 − m` that clears shortfall. (~10 iterations for 1% precision.)
3. **Per-product LT targets** — for each product, find the minimum LT such that *its* units all fit, holding other products' LTs fixed. Binary search per product.

Each recommendation pass is O(re-run of plan). With thousands of units and dozens of bays this stays well under a second.

### Lead-time-by-quarter ambiguity rule

When a unit's build window crosses a quarter boundary, **use the lead time of the quarter the due date falls in.** Simple, deterministic.

---

## 5. REST API (Actix-web)

```
GET    /api/health

GET    /api/scenarios
POST   /api/scenarios                  (create / clone)
GET    /api/scenarios/{id}
PUT    /api/scenarios/{id}             (rename)
DELETE /api/scenarios/{id}
POST   /api/scenarios/{id}/activate

GET    /api/scenarios/{id}/factories
POST   /api/scenarios/{id}/factories
PUT    /api/factories/{id}
DELETE /api/factories/{id}

GET    /api/scenarios/{id}/products
POST   /api/scenarios/{id}/products    (with lead_time_by_quarter map)
PUT    /api/products/{id}
DELETE /api/products/{id}

GET    /api/scenarios/{id}/demand
POST   /api/scenarios/{id}/demand
POST   /api/scenarios/{id}/demand/import-excel
DELETE /api/demand/{id}

POST   /api/scenarios/{id}/run         (executes scheduler + recommendations)
GET    /api/runs/{id}                  (schedule + recs)
GET    /api/runs/{id}/export.csv
GET    /api/runs/{id}/export.xlsx
```

---

## 6. Frontend structure

```
src/
  api/index.ts
  types/index.ts
  state/scenario.ts             # active scenario + run results (Zustand or Context)
  components/
    ScenarioSwitcher.tsx        # named-scenario dropdown + clone/rename/delete
    FactoryEditor.tsx           # name + bays
    ProductEditor.tsx           # name + LT-per-quarter matrix
    DemandEditor.tsx            # rows: product / period / qty / spread
    DemandImporter.tsx          # Excel upload
    RunButton.tsx
    GanttView.tsx               # per-factory Gantt (Plotly), tabs per factory
    ShipmentSummary.tsx         # demand vs shipped vs unshippable, per period
    RecommendationPanel.tsx     # 3 cards side-by-side
    UnshippableList.tsx         # table of units that didn't fit
    ExportMenu.tsx              # CSV / XLSX
    ErrorBoundary.tsx
  App.tsx                       # tab layout: Setup | Run | Results
```

---

## 7. Implementation phases

### Phase 0 — Scaffolding (½ day)
- Create `factoryplan-rust/` with backend (Actix + sqlx) and frontend (Vite + React 19 + TS + Tailwind + Plotly)
- Copy Dockerfile, fly.toml, netlify.toml from gantt-rust; adapt names/ports
- Migrations infra (`sqlx migrate`)
- Health endpoint + frontend health check
- Commit checkpoint

### Phase 1 — Data model + CRUD (1–1.5 days)
- SQLite schema migrations
- Scenario / factory / product / demand CRUD endpoints
- Frontend: scenario switcher, factory editor, product editor (with LT-per-quarter matrix), demand editor
- No scheduling yet — just data in/out
- Unit tests on each repository module
- Commit checkpoint

### Phase 2 — Scheduling core (1.5–2 days)
- `scheduling.rs` module:
  - `explode_demand()` (with spread modes)
  - `Bay` and `BayPool` with `find_first_free_in(window)` + `reserve()` using interval lists
  - `run_schedule()` end-to-end
- `POST /run` endpoint persists `schedule_run` + `scheduled_unit`
- Backend tests: empty plan, single product fits, capacity-limited shortfall, LT-too-long shortfall
- Commit checkpoint

### Phase 3 — Recommendations (1 day)
- Three recommendation algorithms (bays / uniform % / per-product)
- Persist to `recommendation` table
- Tests for each scenario type
- Commit checkpoint

### Phase 4 — Frontend results views (1.5–2 days)
- Per-factory Gantt (Plotly timeline, one row per bay, colored by product)
- Shipment summary table (per period: demand / shipped / unshippable / fill %)
- Recommendation panel (3 cards)
- Unshippable list
- Commit checkpoint

### Phase 5 — Excel import + CSV/XLSX export (½ day)
- Demand Excel import endpoint (Calamine)
- Run export endpoints (CSV + XLSX)
- Frontend hooks
- Commit checkpoint

### Phase 6 — Polish + deploy (½–1 day)
- Loading states, error boundaries
- README with quick-start
- Dockerfile build verified
- Fly.io / Netlify deploy dry-run docs
- Commit checkpoint

**Rough total: ~6–8 focused days of work.**

---

## 8. Non-goals for v1 (explicitly deferred)

- Gap / changeover time between builds
- Blocked days / maintenance windows
- Multi-user auth
- Scenario comparison view (planned for v1.1)
- Critical path / dependencies between units
- Real-time collaboration

---

## 9. Open risks

- **Recommendation runtime** if demand is huge (10k+ units × 4 binary-search iterations × N products). Should still be sub-second on SQLite, but worth measuring in Phase 3.
- **Excel import format** — need a canonical column layout (Product, PeriodType, Year, PeriodIndex, Quantity, SpreadMode). Will be documented in Phase 5.
- **Lead-time-by-quarter boundary** — resolved by the "due-date's quarter wins" rule (see §4).

---

## 10. Q&A trail (decisions, for traceability)

| Q | Topic | Choice |
|---|---|---|
| 1 | Demand granularity | Monthly **and** quarterly |
| 2 | Demand explosion | Evenly spaced (default), start/end selectable |
| 3 | Lead time location | Per product (factories interchangeable) |
| 3b | Lead time temporal | Per quarter (per-product-per-quarter) |
| 4 | Gap between builds | None for v1 |
| 5 | Blocked days | None for v1 |
| 6 | Recommendation shape | All three: bays / uniform % / per-product |
| 7 | Factory allocation | Global greedy |
| 8 | Time horizon | Auto-derived (backward scheduling) |
| 8a | Placement order | Earliest required-start first |
| 8b | Recommendations | All three shown side-by-side |
| 8c | Past start dates | Allowed, not flagged |
| 9 | Outputs | Gantt + summary + recs + unshippable + export |
| 10 | Codebase | New project (this one) |
| 11 | Persistence | SQLite |
| 12 | Scenarios | Named, switchable, cloneable |
