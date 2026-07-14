# factoryplan-rust

Finite-capacity production planner. Given demand, factories (with bay counts), and
products (with per-quarter lead times), it **backward-schedules** every unit and
tells you:

- Which units ship on time, which ship **late**, and which are unshippable
- The scheduler walks quarters in order. Each quarter, **roll-offs carried over
  from the previous quarter get first pick of the bays** (forward-scheduled from
  the earliest free day), then that quarter's native demand is placed backward
  (its demanded window first, else any later start still inside the quarter). A
  unit only rolls forward when it can't start at all within the quarter — so a
  roll-off is the top priority of the *next* quarter and never languishes to the
  end of the schedule. Past the horizon (8 quarters after the last demand) it's
  unshippable. A per-quarter **backlog** table tracks every miss. (This
  `RollForwardPriority` strategy was picked from five algorithms compared by
  `benchmark_strategies` in `scheduling.rs`.)
- How to get everything shipping on time (clearing late + unshippable), via
  three side-by-side recommendations:
  - **Bays to add** (and where)
  - **Uniform % lead-time reduction** across all products
  - **Per-product lead-time targets**

The scheduling model and design decisions are documented in [`docs/PLAN.md`](docs/PLAN.md).

---

## Quick start (local dev)

You need `cargo` (Rust 1.80+), `npm` (Node 20+), and PostgreSQL. Create a
local database named `factoryplan` first; the backend runs migrations on startup.

```bash
# 1. Create the database once (adjust user/password if your Postgres differs)
createdb -U postgres -h localhost -p 5432 factoryplan

# 2. Start the backend (port 8080)
cd backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/factoryplan cargo run

# 3. In another terminal, start the frontend dev server (port 5173)
cd frontend
npm install        # first time only
npm run dev

# 4. Open http://localhost:5173 in a browser
```

The frontend dev server proxies `/api/*` to the backend automatically.

---

## What you can do in the UI

1. **Scenarios tab (top bar)** — create, rename, clone, or delete scenarios.
   Each scenario has its own factories / products / demand / runs.
2. **Factories** — name + bay count.
3. **Products** — name + a per-(year, quarter) lead-time matrix. By default a
   product's lead time is the same at every factory; tick **"Set factory-specific
   lead times"** to override the lead time for a particular factory in a
   particular (year, quarter). Blank override cells inherit the default.
4. **Demand** — rows specifying *product × period × quantity*. Period can be a
   quarter or a month. Units are exploded evenly (or to start/end) inside the
   period. Bulk-load demand via "Import Excel" (see
   [docs/EXCEL_IMPORT.md](docs/EXCEL_IMPORT.md) for the column layout).
   Optionally attach **serial numbers** per row: either a *leading serial* that
   auto-increments (e.g. `WID-0010` → `WID-0011`, preserving prefix + zero-pad),
   or *paste a list* (one serial per line — copy a column straight from Excel).
   Serials are assigned to the row's units in due-date order.
5. **Run** — preview scenario stats and run the scheduler. Pick a **bay
   assignment** mode first: *Balance load* (spread work across all factories and
   bays) or *Maximize utilization* (pack work into as few bays as possible,
   leaving unneeded bays empty — shown green in the Gantt). Results auto-open
   the Results tab.
6. **Results** — recommendation panel, **quarterly backlog** table (demand /
   on-time / rolled-out / rolled-in / unshippable per quarter), per-period
   shipment summary, per-factory Gantt chart (compare all factories at once,
   idle-gap shading + capacity utilization), unshippable list, CSV/XLSX download.
7. **Report** — a per-unit table (serial · product · factory · shipping quarter ·
   ship date · start date · status) covering every unit. Select it or hit
   "Copy for Excel" to paste straight into a spreadsheet (tab-separated).
8. **Agent** — a chat-based scheduling expert powered by the `devin` CLI. Ask
   questions in plain English ("why are Q3 units unshippable?", "what if I add 2
   bays to Factory B?"). The agent reads the scenario, can call the API to run
   the scheduler, and can run what-if experiments by cloning scenarios. Requires
   the `devin` CLI installed and on PATH (see Configuration).

---

## API surface

```
GET    /api/health

GET    /api/scenarios
POST   /api/scenarios                       (create / clone via { clone_from })
GET    /api/scenarios/{id}
PUT    /api/scenarios/{id}                  (rename)
DELETE /api/scenarios/{id}
POST   /api/scenarios/{id}/activate

GET    /api/scenarios/{id}/factories
POST   /api/scenarios/{id}/factories
PUT    /api/factories/{id}
DELETE /api/factories/{id}

GET    /api/scenarios/{id}/products
POST   /api/scenarios/{id}/products         (with per-quarter lead_times)
PUT    /api/products/{id}
DELETE /api/products/{id}

GET    /api/scenarios/{id}/demand
POST   /api/scenarios/{id}/demand
POST   /api/scenarios/{id}/demand/import-excel  (multipart file upload)
PUT    /api/demand/{id}
DELETE /api/demand/{id}

POST   /api/scenarios/{id}/run              (executes scheduler + recommendations)
GET    /api/runs/{id}                       (re-fetch persisted run)
GET    /api/runs/{id}/export.csv
GET    /api/runs/{id}/export.xlsx

POST   /api/agent/chat                       (SSE stream; spawns devin, persists turn)
GET    /api/agent/conversations?scenario_id=…
GET    /api/agent/conversations/{id}/messages
DELETE /api/agent/conversations/{id}
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Rust 2021, Actix-web 4, Tokio, sqlx (PostgreSQL) |
| Backend storage | PostgreSQL (`factoryplan` database by default) |
| Excel parsing | calamine |
| XLSX writing | rust_xlsxwriter |
| AI agent | `devin` CLI (spawned per turn), streamed over SSE |
| Frontend | React 19, Vite 5, TypeScript |
| Frontend styling | Tailwind v4 |
| Frontend charts | Plotly.js (react-plotly.js), lazy-loaded |
| Frontend markdown | react-markdown (agent chat, lazy-loaded) |

### Why PostgreSQL

The app now uses PostgreSQL so scenarios, products, demand, runs, and agent
conversation history persist in a production-style relational database. Local
handoff can use a fresh empty database, a `pg_dump` restore, or the Docker Compose
workflow in `DOCKER_SETUP.md`.

### Why Actix-web

Mature, fast, well-supported. The handlers are small enough that swapping
frameworks later would be a few hours of work if needed.

---

## Configuration

The backend reads these environment variables:

| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `8080` | Bind port |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/factoryplan` | PostgreSQL connection URL |
| `RUST_LOG` | `info` | Standard `env_logger` filter |
| `DEVIN_CMD` | `devin` | Path to the `devin` CLI used by the Agent tab. Override if not on PATH. |
| `APP_PASSWORD` | unset | Optional shared password that enables the login gate. |
| `APP_SESSION_TTL_HOURS` | `12` | Lifetime of the opaque in-memory login session. Backend restarts invalidate active sessions. |

The Agent tab requires the [`devin` CLI](https://cli.devin.ai/docs) installed,
authenticated (`devin auth login`), and on PATH. The backend spawns it
non-interactively (`devin -p --prompt-file … --permission-mode dangerous`) and
streams its response back over SSE. If `devin` is missing, the chat returns a
clear error and the rest of the app is unaffected.

The frontend reads no env vars in dev — Vite proxies `/api/*` to
`http://127.0.0.1:8080`. For a production build served from a different origin
than the backend (for example Vercel frontend + separately hosted API), set
`VITE_API_BASE_URL` to the backend origin, such as `https://api.example.com`.

---

## Tests

```bash
cd backend
cargo test
```

23 unit tests cover:

- Period/quarter math (`quarter_of`, `period_start`, `period_end`)
- Demand explosion (even / start / end spread modes)
- Cross-quarter lead-time selection ("due date's quarter wins")
- Greedy bay placement (empty / fits / capacity-bound / multi-bay)
- Roll-forward to later quarters + per-quarter miss tracking (late shipments)
- Serial generation (sequence auto-increment + positional list)
- All three recommendation algorithms (bays-needed, uniform %, per-product)
- Capacity-bound case (verifies we *don't* recommend a useless LT cut)

A `benchmark_strategies` test compares four scheduling algorithms across
representative scenarios — run it with
`cargo test benchmark_strategies -- --nocapture`.

---

## Project layout

```
factoryplan-rust/
├── README.md                  ← you are here
├── docs/
│   ├── PLAN.md                ← full design + Q&A trail
│   └── EXCEL_IMPORT.md        ← demand import template
├── backend/
│   ├── Cargo.toml
│   ├── migrations/
│   │   ├── 0001_initial.sql
│   │   ├── 0002_factory_bay_count.sql
│   │   ├── 0003_agent.sql       ← agent conversation + message tables
│   │   ├── 0004_serials.sql     ← per-unit serial numbers
│   │   └── 0005_rollforward.sql ← late shipments + per-quarter backlog
│   └── src/
│       ├── main.rs            ← Actix server + module wiring
│       ├── db.rs              ← sqlx pool + helpers
│       ├── error.rs           ← AppError + ResponseError
│       ├── models.rs          ← DB row + request/response types
│       ├── scheduling.rs      ← backward scheduler + tests
│       ├── recommendations.rs ← three rec algorithms + tests
│       └── handlers/
│           ├── mod.rs
│           ├── scenarios.rs
│           ├── factories.rs
│           ├── products.rs
│           ├── demand.rs
│           ├── runs.rs
│           ├── import_export.rs
│           └── agent.rs         ← devin spawn + SSE stream + conversations
└── frontend/
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── main.tsx
        ├── App.tsx            ← tabs + lifted result state
        ├── api/index.ts
        ├── types/index.ts
        └── components/
            ├── ScenarioSwitcher.tsx
            ├── FactoryEditor.tsx
            ├── ProductEditor.tsx
            ├── DemandEditor.tsx
            ├── RunView.tsx
            ├── GanttView.tsx       (lazy-loaded, ~5MB Plotly)
            ├── ShipmentSummary.tsx
            ├── RecommendationPanel.tsx
            ├── UnshippableList.tsx
            ├── BacklogView.tsx      (per-quarter roll-forward backlog table)
            ├── ReportView.tsx       (per-unit serial report + copy-for-Excel)
            ├── AgentChat.tsx        (lazy-loaded; SSE chat + react-markdown)
            └── ErrorBoundary.tsx
```

---

## Deferred to v1.1+ (explicitly out of scope)

- Gap / changeover time between bay reservations
- Per-factory blocked-day windows (maintenance, holidays)
- Authentication / multi-user
- Side-by-side scenario comparison view
- Critical-path / dependency constraints between units
- Persistent run history beyond "latest per scenario"

If any of these become relevant, the scheduler in `scheduling.rs` is the right
extension point — the `BayPool` and `LtIndex` abstractions were designed with
this in mind.

---

## License

Internal / not yet licensed.
