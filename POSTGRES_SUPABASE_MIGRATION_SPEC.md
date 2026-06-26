# factoryplan Postgres/Supabase migration specification

This document is the working plan for migrating the copied project in this folder from SQLite to Postgres, then to Supabase Postgres.

Source project copied from:

```text
C:\Users\pdangol\CascadeProjects\factoryplan-rust
```

New migration workspace:

```text
C:\Users\pdangol\CascadeProjects\facotryplan-postg
```

Note: the folder name intentionally matches the requested name, including the spelling `facotryplan-postg`.

---

## 1. Goal

Move the backend database layer from SQLite to Postgres while keeping the existing product behavior intact.

Target architecture after migration:

```text
Vercel frontend
      |
      v
Render/Fly/Railway Rust backend
      |
      v
Supabase Postgres
```

Near-term local migration architecture:

```text
Local Vite frontend
      |
      v
Local Rust backend
      |
      v
Local Postgres database
```

The migration should preserve:

- scenario CRUD,
- factory CRUD,
- per-quarter factory bay counts,
- factory changeover days,
- product CRUD,
- product lead times,
- product/factory lead-time overrides,
- product/factory allocation rules,
- demand CRUD,
- serial number fields,
- scheduler runs,
- scheduled units,
- recommendations,
- quarter backlog/miss data,
- Excel import,
- CSV/XLSX export,
- frontend API behavior,
- deployment compatibility with Vercel + hosted backend.

The migration does **not** need to make the Agent tab production-ready. The Agent tab depends on the `devin` CLI being installed/authenticated on the backend host and should be treated as a separate deployment concern.

---

## 2. Non-goals

Do not do these during the initial Postgres migration:

- Do not redesign the scheduling algorithm.
- Do not rewrite the backend in TypeScript/Node.
- Do not move CRUD directly into Supabase client calls from the frontend.
- Do not add authentication yet.
- Do not migrate existing local SQLite data until the Postgres schema and app behavior are verified.
- Do not introduce Kubernetes or Docker as a prerequisite for this migration.
- Do not change the frontend UI unless required by backend API behavior.

---

## 3. Recommended migration sequence

Use this sequence:

```text
1. Keep current deployed SQLite app working.
2. Work only inside C:\Users\pdangol\CascadeProjects\facotryplan-postg.
3. Create local Postgres database.
4. Convert backend from SQLite SQLx to Postgres SQLx.
5. Convert migrations to Postgres-compatible SQL.
6. Convert SQL placeholders and any SQLite-specific query behavior.
7. Run backend tests against local Postgres.
8. Run frontend locally against local Postgres-backed backend.
9. Create Supabase project.
10. Point local backend at Supabase temporarily and verify.
11. Point Render backend at Supabase `DATABASE_URL`.
12. Redeploy backend.
13. Verify Vercel frontend still works.
14. Optionally migrate old SQLite data.
```

---

## 4. Why local Postgres first

Migrating directly from SQLite to Supabase is risky because Supabase is production-like infrastructure. Most changes are code/schema compatibility issues that are safer to discover locally.

Local Postgres lets us quickly fix:

- SQL placeholder syntax,
- SQLx pool type changes,
- migration syntax,
- boolean mapping,
- date/timestamp mapping,
- transaction behavior,
- foreign key behavior,
- SQLx row decoding errors,
- test failures.

Once local Postgres works, Supabase is mostly a `DATABASE_URL` change.

---

## 5. Current backend summary

Backend path:

```text
backend/
```

Current backend stack:

| Area | Current choice |
|---|---|
| Web framework | Actix-web |
| Runtime | Tokio |
| Database access | SQLx |
| Current DB | SQLite |
| Migrations | `backend/migrations/*.sql` embedded by `sqlx::migrate!` |
| Default DB URL | `sqlite://factoryplan.db` |
| Deployment backend host | Render |
| Frontend host | Vercel |

Current database initialization file:

```text
backend/src/db.rs
```

Current key behavior:

- Uses `SqlitePool`.
- Uses `SqliteConnectOptions`.
- Creates the SQLite file if missing.
- Enables SQLite foreign keys.
- Enables WAL mode.
- Runs migrations from `./migrations` at startup.

Current SQLx dependency:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "chrono", "uuid", "macros", "migrate"] }
```

---

## 6. Current schema inventory

Current migrations:

```text
backend/migrations/0001_initial.sql
backend/migrations/0002_factory_bay_count.sql
backend/migrations/0003_agent.sql
backend/migrations/0004_serials.sql
backend/migrations/0005_rollforward.sql
backend/migrations/0006_product_factory_lead_time.sql
backend/migrations/0007_product_factory_allocation.sql
backend/migrations/0008_factory_changeover_days.sql
```

Current tables:

| Table | Purpose |
|---|---|
| `scenario` | Planning scenarios and active scenario flag. |
| `factory` | Factories, bay baseline, changeover days. |
| `factory_bay_count` | Per-quarter factory bay overrides. |
| `product` | Products scoped to scenarios. |
| `product_lead_time` | Product lead time by year/quarter. |
| `product_factory_lead_time` | Product/factory lead time overrides by year/quarter. |
| `product_factory_allocation` | Product-to-factory allocation percentages. |
| `demand` | Demand rows by product and period. |
| `schedule_run` | Scheduler run summary. |
| `scheduled_unit` | Per-unit scheduled result rows. |
| `recommendation` | Recommendation payloads as JSON text. |
| `quarter_miss` | Per-quarter backlog/miss counts. |
| `agent_conversation` | Agent chat conversations. |
| `agent_message` | Agent chat message history. |

---

## 7. Postgres schema design decisions

For the first migration, prefer minimal behavior change over idealized redesign.

### 7.1 ID strategy

Current IDs are generated in Rust as UUID strings:

```rust
uuid::Uuid::new_v4().to_string()
```

Recommended first migration decision:

```text
Keep IDs as TEXT for the initial Postgres migration.
```

Why:

- Minimizes Rust model changes.
- Avoids changing frontend/API types.
- Avoids immediately converting all IDs to `uuid::Uuid` in Rust models.
- Existing string IDs remain valid.

Possible later improvement:

```text
Convert ID columns from TEXT to UUID after the app is stable on Postgres.
```

Do not combine that improvement with the first database migration.

### 7.2 Date/time strategy

Current date/time fields are strings:

- `created_at`
- `updated_at`
- `run_at`
- `required_start`
- `due_date`
- `orig_due_date`
- `agent_message.created_at`

Recommended first migration decision:

```text
Keep date/time fields as TEXT initially.
```

Why:

- Backend models likely decode these as strings.
- Scheduler uses `chrono` internally, but persisted API fields are currently string-compatible.
- Reduces migration risk.

Possible later improvement:

```text
Convert date-only fields to DATE and timestamps to TIMESTAMPTZ.
```

Do not combine that improvement with the first migration unless the team explicitly wants stronger DB-level typing now.

### 7.3 Boolean strategy

Current SQLite boolean-like columns:

| Column | Current type | Meaning |
|---|---|---|
| `scenario.is_active` | `INTEGER` | 0/1 boolean |
| `scheduled_unit.is_late` | `INTEGER` | 0/1 boolean |

Recommended Postgres decision:

```text
Use BOOLEAN for boolean columns.
```

Expected schema:

```sql
is_active BOOLEAN NOT NULL DEFAULT false
is_late BOOLEAN NOT NULL DEFAULT false
```

Code impact:

- Rust structs should use `bool` if they do not already.
- SQL inserts/updates should bind `false`/`true` instead of `0`/`1`.
- Queries should not assume integer booleans.

If existing Rust structs currently use `i64`/`i32` for these fields, update them to `bool` and adjust API serialization as needed.

### 7.4 JSON payload strategy

Current recommendation payloads are stored as text:

```sql
payload_json TEXT NOT NULL
```

Recommended first migration decision:

```text
Keep `payload_json` as TEXT initially.
```

Why:

- Existing code likely serializes/deserializes JSON strings.
- Minimal change.

Possible later improvement:

```text
Change `payload_json` to JSONB.
```

If converting to JSONB later, update Rust binding/decoding and queries accordingly.

---

## 8. Postgres migration SQL requirements

### 8.1 Remove SQLite pragmas

Remove all SQLite-specific statements:

```sql
PRAGMA foreign_keys = ON;
```

Postgres enforces foreign keys by default.

### 8.2 Convert integer booleans

Change:

```sql
is_active INTEGER NOT NULL DEFAULT 0
is_late INTEGER NOT NULL DEFAULT 0
```

to:

```sql
is_active BOOLEAN NOT NULL DEFAULT false
is_late BOOLEAN NOT NULL DEFAULT false
```

### 8.3 Keep check constraints

Most existing `CHECK` constraints are valid Postgres syntax, for example:

```sql
CHECK (quarter BETWEEN 1 AND 4)
CHECK (bays >= 0)
CHECK (period_type IN ('month', 'quarter'))
```

Keep these.

### 8.4 Preserve foreign key cascades

Keep:

```sql
REFERENCES table_name(id) ON DELETE CASCADE
```

### 8.5 Keep unique constraints and indexes

Keep:

```sql
UNIQUE (...)
CREATE INDEX ...
```

### 8.6 Decide whether to squash migrations

Two acceptable approaches:

#### Option A: Convert all existing migrations in place

Pros:

- Preserves migration history.
- Easier to map old changes to new changes.

Cons:

- Some `ALTER TABLE ADD COLUMN` migrations rely on earlier SQLite details.

#### Option B: Create a new Postgres baseline migration

Pros:

- Cleaner for a new Postgres database.
- Easier to verify final schema.
- Avoids carrying SQLite-specific migration history.

Cons:

- Loses direct migration-by-migration history for Postgres.

Recommended for this project:

```text
Use Option B: create a clean Postgres baseline migration.
```

Because this is a new copied workspace and existing hosted data does not need to be preserved immediately, a clean baseline is safer and easier.

Suggested folder approach:

```text
backend/migrations_sqlite/      # optional archival copy of old migrations
backend/migrations/             # new Postgres migrations used by sqlx::migrate!
```

Or, if keeping Git history is enough, replace `backend/migrations/*.sql` with:

```text
backend/migrations/0001_postgres_initial.sql
```

Do this only in the copied project, not the original `factoryplan-rust` folder.

---

## 9. Proposed Postgres baseline schema

Use this as the starting point for `backend/migrations/0001_postgres_initial.sql`.

```sql
CREATE TABLE scenario (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE factory (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    bays            INTEGER NOT NULL CHECK (bays >= 0),
    changeover_days INTEGER NOT NULL DEFAULT 0 CHECK (changeover_days >= 0)
);
CREATE INDEX idx_factory_scenario ON factory(scenario_id);

CREATE TABLE factory_bay_count (
    id          TEXT PRIMARY KEY,
    factory_id  TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year        INTEGER NOT NULL,
    quarter     INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    bays        INTEGER NOT NULL CHECK (bays >= 0),
    UNIQUE (factory_id, year, quarter)
);
CREATE INDEX idx_factory_bay_count_factory ON factory_bay_count(factory_id);

CREATE TABLE product (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    name        TEXT NOT NULL
);
CREATE INDEX idx_product_scenario ON product(scenario_id);

CREATE TABLE product_lead_time (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL,
    quarter         INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    lead_time_days  INTEGER NOT NULL CHECK (lead_time_days > 0),
    UNIQUE (product_id, year, quarter)
);
CREATE INDEX idx_lead_time_product ON product_lead_time(product_id);

CREATE TABLE product_factory_lead_time (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    factory_id      TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL,
    quarter         INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    lead_time_days  INTEGER NOT NULL CHECK (lead_time_days > 0),
    UNIQUE (product_id, factory_id, year, quarter)
);
CREATE INDEX idx_pflt_product ON product_factory_lead_time(product_id);
CREATE INDEX idx_pflt_factory ON product_factory_lead_time(factory_id);

CREATE TABLE product_factory_allocation (
    id              TEXT PRIMARY KEY,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    factory_id      TEXT NOT NULL REFERENCES factory(id) ON DELETE CASCADE,
    year            INTEGER NOT NULL,
    quarter         INTEGER NOT NULL CHECK (quarter BETWEEN 0 AND 4),
    allocation_pct  INTEGER NOT NULL CHECK (allocation_pct BETWEEN 0 AND 100),
    CHECK ((year = 0 AND quarter = 0) OR (year > 0 AND quarter BETWEEN 1 AND 4)),
    UNIQUE (product_id, year, quarter)
);
CREATE INDEX idx_pfa_product ON product_factory_allocation(product_id);
CREATE INDEX idx_pfa_factory ON product_factory_allocation(factory_id);

CREATE TABLE demand (
    id              TEXT PRIMARY KEY,
    scenario_id     TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    period_type     TEXT NOT NULL CHECK (period_type IN ('month', 'quarter')),
    year            INTEGER NOT NULL,
    period_index    INTEGER NOT NULL,
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    spread_mode     TEXT NOT NULL DEFAULT 'even' CHECK (spread_mode IN ('even', 'start', 'end')),
    serial_mode     TEXT NOT NULL DEFAULT 'none' CHECK (serial_mode IN ('none', 'sequence', 'list')),
    serial_start    TEXT,
    serial_list     TEXT
);
CREATE INDEX idx_demand_scenario ON demand(scenario_id);
CREATE INDEX idx_demand_product ON demand(product_id);

CREATE TABLE schedule_run (
    id                  TEXT PRIMARY KEY,
    scenario_id         TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    run_at              TEXT NOT NULL,
    total_demand        INTEGER NOT NULL,
    shipped_on_time     INTEGER NOT NULL,
    shipped_late        INTEGER NOT NULL DEFAULT 0,
    unshippable         INTEGER NOT NULL
);
CREATE INDEX idx_run_scenario ON schedule_run(scenario_id);

CREATE TABLE scheduled_unit (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    demand_id       TEXT NOT NULL,
    product_id      TEXT NOT NULL,
    factory_id      TEXT,
    bay_index       INTEGER,
    required_start  TEXT NOT NULL,
    due_date        TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('shipped', 'unshippable')),
    serial          TEXT,
    orig_due_date   TEXT,
    is_late         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_unit_run ON scheduled_unit(run_id);

CREATE TABLE recommendation (
    id              TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    rec_type        TEXT NOT NULL CHECK (rec_type IN ('bays_needed', 'uniform_lt_pct', 'per_product_lt')),
    payload_json    TEXT NOT NULL
);
CREATE INDEX idx_rec_run ON recommendation(run_id);

CREATE TABLE quarter_miss (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES schedule_run(id) ON DELETE CASCADE,
    year         INTEGER NOT NULL,
    quarter      INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    missed_count INTEGER NOT NULL CHECK (missed_count >= 0)
);
CREATE INDEX idx_quarter_miss_run ON quarter_miss(run_id);

CREATE TABLE agent_conversation (
    id          TEXT PRIMARY KEY,
    scenario_id TEXT NOT NULL REFERENCES scenario(id) ON DELETE CASCADE,
    title       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX idx_agent_conv_scenario ON agent_conversation(scenario_id);

CREATE TABLE agent_message (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES agent_conversation(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX idx_agent_msg_conv ON agent_message(conversation_id);
```

---

## 10. Rust dependency changes

Update `backend/Cargo.toml`.

Current:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "chrono", "uuid", "macros", "migrate"] }
```

Target:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres", "chrono", "uuid", "macros", "migrate"] }
```

Optional transitional target if temporarily supporting both SQLite and Postgres:

```toml
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "sqlite", "postgres", "chrono", "uuid", "macros", "migrate"] }
```

Recommended:

```text
Use Postgres only in the copied migration workspace.
```

After editing, run:

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
cargo check
```

Expect compilation failures until `db.rs` and SQL calls are converted.

---

## 11. Rust database layer changes

Update:

```text
backend/src/db.rs
```

Current SQLite pattern:

```rust
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions, SqliteConnectOptions};
use std::str::FromStr;

pub type Pool = SqlitePool;

pub async fn init_pool(database_url: &str) -> Result<Pool, sqlx::Error> {
    let opts = SqliteConnectOptions::from_str(database_url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

Target Postgres pattern:

```rust
use sqlx::postgres::{PgPool, PgPoolOptions};

pub type Pool = PgPool;

pub async fn init_pool(database_url: &str) -> Result<Pool, sqlx::Error> {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(database_url)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

Important differences:

- No `create_if_missing` for Postgres.
- The database must already exist locally or in Supabase.
- No SQLite WAL mode.
- No SQLite foreign key pragma.

Update default `DATABASE_URL` in `backend/src/main.rs`.

Current:

```rust
std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite://factoryplan.db".to_string())
```

Target local default option:

```rust
std::env::var("DATABASE_URL").unwrap_or_else(|_| "postgresql://postgres:postgres@localhost:5432/factoryplan".to_string())
```

Alternative recommendation:

```text
Remove the production-like default and require DATABASE_URL to be set.
```

Safer production-oriented code:

```rust
let database_url = std::env::var("DATABASE_URL")
    .expect("DATABASE_URL must be set, e.g. postgresql://user:password@localhost:5432/factoryplan");
```

For local developer friendliness, keeping a documented local default is acceptable.

---

## 12. SQL query conversion

The backend uses many raw SQL strings through SQLx. The main conversion is placeholder syntax.

SQLite placeholder:

```sql
WHERE id = ?
VALUES (?, ?, ?)
```

Postgres placeholder:

```sql
WHERE id = $1
VALUES ($1, $2, $3)
```

Every SQL query must be audited.

Known query-heavy files:

```text
backend/src/handlers/agent.rs
backend/src/handlers/demand.rs
backend/src/handlers/factories.rs
backend/src/handlers/import_export.rs
backend/src/handlers/products.rs
backend/src/handlers/runs.rs
backend/src/handlers/scenarios.rs
```

Likely lower/no database files:

```text
backend/src/scheduling.rs
backend/src/recommendations.rs
backend/src/models.rs
backend/src/main.rs
backend/src/error.rs
```

### 12.1 Conversion rule

For each query, number placeholders in bind order.

Example:

```rust
sqlx::query("INSERT INTO scenario (id, name, created_at, updated_at, is_active) VALUES (?, ?, ?, ?, 0)")
    .bind(&id)
    .bind(&name)
    .bind(&now)
    .bind(&now)
```

Postgres:

```rust
sqlx::query("INSERT INTO scenario (id, name, created_at, updated_at, is_active) VALUES ($1, $2, $3, $4, false)")
    .bind(&id)
    .bind(&name)
    .bind(&now)
    .bind(&now)
```

Example with update:

```rust
sqlx::query("UPDATE scenario SET name = ?, updated_at = ? WHERE id = ?")
```

Postgres:

```rust
sqlx::query("UPDATE scenario SET name = $1, updated_at = $2 WHERE id = $3")
```

### 12.2 Boolean query changes

SQLite style:

```sql
UPDATE scenario SET is_active = 0
UPDATE scenario SET is_active = 1
```

Postgres style:

```sql
UPDATE scenario SET is_active = false
UPDATE scenario SET is_active = true
```

SQLite late flag:

```sql
is_late = 0 / 1
```

Postgres style:

```sql
is_late = false / true
```

Rust binding should use `bool`.

### 12.3 Aggregate type checks

Postgres may return different numeric types for aggregates such as:

```sql
COUNT(*)
SUM(quantity)
SUM(bays)
```

Audit Rust decode targets.

Common SQLx/Postgres expectations:

- `COUNT(*)` decodes to `i64`.
- `SUM(integer)` may decode to `Option<i64>` or `Option<i64>` depending expression/type.

If current code expects `i32`, adjust to `i64` or cast in SQL:

```sql
SELECT COUNT(*)::BIGINT FROM ...
SELECT COALESCE(SUM(quantity), 0)::BIGINT FROM ...
```

### 12.4 Ordering and null behavior

Postgres and SQLite can differ slightly in null ordering. Audit any query where UI ordering matters and add explicit clauses if needed:

```sql
ORDER BY due_date ASC NULLS LAST
```

Most current rows use non-null ordering fields, so this is likely low risk.

---

## 13. Model/type audit

Review:

```text
backend/src/models.rs
```

Look specifically for fields corresponding to DB boolean columns:

- `Scenario.is_active`
- `ScheduledUnit.is_late`

Target Rust types:

```rust
pub is_active: bool
pub is_late: bool
```

If the frontend currently expects booleans, this is ideal. If the frontend expects `0`/`1`, update frontend types and usage to booleans.

Also audit numeric columns:

- `bays`
- `year`
- `quarter`
- `quantity`
- `period_index`
- `lead_time_days`
- `allocation_pct`
- `changeover_days`
- `bay_index`
- aggregate counts

Postgres `INTEGER` maps cleanly to `i32` in SQLx. Counts/aggregates often map to `i64`.

---

## 14. Local Postgres setup

Since Postgres is already installed on the computer, create a local database.

### 14.1 Verify Postgres tools

In PowerShell:

```powershell
psql --version
```

If `psql` is not found, add the Postgres `bin` directory to PATH or use pgAdmin to create the database.

### 14.2 Create database

Option A, using `psql` as postgres user:

```powershell
psql -U postgres
```

Inside `psql`:

```sql
CREATE DATABASE factoryplan;
\q
```

Option B, one command:

```powershell
createdb -U postgres factoryplan
```

### 14.3 Local DATABASE_URL

Use the real local password:

```powershell
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/factoryplan"
```

If password contains special characters, URL-encode it or use a simpler local dev password.

### 14.4 Reset local database during development

When iterating on migrations, it is often easiest to drop and recreate the local database.

Destructive command; only run when intentionally resetting local dev data:

```sql
DROP DATABASE factoryplan;
CREATE DATABASE factoryplan;
```

Do not run this against Supabase production data.

---

## 15. Supabase setup

After local Postgres works:

1. Create a Supabase project.
2. Save the database password securely.
3. Go to Supabase project settings.
4. Find database connection strings.
5. Use a Postgres connection string as `DATABASE_URL`.

Typical Supabase direct connection pattern:

```text
postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

Potential pooler connection pattern:

```text
postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

For the Rust backend with SQLx:

- Start with the direct connection if possible.
- Use the pooler if direct connections are restricted or if connection limits become an issue.
- Keep `PgPoolOptions::max_connections(8)` initially; lower it if Supabase connection limits require it.

Render environment variable target:

```text
DATABASE_URL=postgresql://...
```

Remove SQLite-specific Render settings. No Render disk is needed when using Supabase.

---

## 16. Render deployment changes after Supabase

Current Render free SQLite setup used for testing:

```text
HOST=0.0.0.0
DATABASE_URL=sqlite://factoryplan.db
RUST_LOG=info
```

Supabase Postgres setup:

```text
HOST=0.0.0.0
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
RUST_LOG=info
```

Build command remains:

```text
cargo build --release
```

Start command remains:

```text
./target/release/factoryplan-backend
```

Vercel frontend environment remains:

```text
VITE_API_BASE_URL=https://factoryplan-backend.onrender.com
```

The frontend should not need to change when the backend moves from SQLite to Postgres.

---

## 17. Verification checklist

### 17.1 Backend compile and tests

From:

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
```

Run:

```powershell
cargo check
cargo test
```

If tests require a database, ensure:

```powershell
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/factoryplan"
```

### 17.2 Backend local run

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "8080"
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/factoryplan"
cargo run
```

Verify:

```text
http://127.0.0.1:8080/api/health
```

Expected:

```json
{"status":"ok","service":"factoryplan-backend","version":"0.1.0"}
```

### 17.3 Frontend local run

In another terminal:

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\frontend
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Test manually:

- load app,
- create scenario,
- rename scenario,
- clone scenario,
- delete scenario,
- activate scenario,
- create factory,
- edit factory,
- set bay overrides,
- create product,
- edit product lead times,
- set factory-specific lead times,
- set factory allocations,
- create demand,
- import Excel demand,
- run scheduler,
- inspect recommendations,
- inspect Gantt,
- inspect shipment summary,
- inspect report,
- export CSV,
- export XLSX.

### 17.4 Supabase smoke test

Point local backend to Supabase:

```powershell
$env:DATABASE_URL = "postgresql://postgres:SUPABASE_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
cargo run
```

Then repeat a smaller manual test:

- `/api/health`,
- create scenario,
- create factory,
- create product,
- create demand,
- run scheduler.

### 17.5 Render smoke test

After Render redeploy:

```text
https://factoryplan-backend.onrender.com/api/health
```

Then open Vercel frontend and test app behavior.

---

## 18. Existing SQLite data migration

Do this only after the app works cleanly on Postgres.

### 18.1 Decide whether data migration is needed

If the hosted app is still test-only, easiest path:

```text
Do not migrate old SQLite data. Start fresh in Supabase.
```

If existing scenarios are valuable, write a one-time migration script.

### 18.2 Recommended data migration approach

Create a temporary Rust or Python script that:

1. Opens SQLite database file.
2. Opens Postgres database connection.
3. Reads tables in dependency order.
4. Inserts rows into Postgres preserving IDs.
5. Verifies row counts.

Dependency order:

```text
scenario
factory
factory_bay_count
product
product_lead_time
product_factory_lead_time
product_factory_allocation
demand
schedule_run
scheduled_unit
recommendation
quarter_miss
agent_conversation
agent_message
```

### 18.3 Boolean conversion during data migration

Convert SQLite integer booleans:

```text
0 -> false
1 -> true
```

Columns:

```text
scenario.is_active
scheduled_unit.is_late
```

### 18.4 Data migration verification

For each table:

```sql
SELECT COUNT(*) FROM table_name;
```

Compare SQLite and Postgres counts.

Then run the frontend against Postgres and verify old scenarios appear.

---

## 19. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Missed `?` placeholder | High | Backend query failure | Grep all SQL strings and run end-to-end tests. |
| Boolean decode mismatch | Medium | Runtime decode error or wrong API values | Convert schema and Rust types consistently. |
| Aggregate type mismatch | Medium | Runtime decode error | Use `i64` or SQL casts for counts/sums. |
| Migration syntax error | Medium | Backend startup failure | Test against local Postgres repeatedly. |
| Supabase connection string/SSL issue | Medium | Render cannot connect | Use Supabase-provided URI; verify from local first. |
| Connection limit exceeded | Low-medium | Intermittent DB failures | Lower `max_connections`; use Supabase pooler if needed. |
| Data loss during migration | Medium | Loss of old scenarios | Do not migrate production data until migration script is tested on copies. |
| Agent tab fails in hosted env | High | Agent feature unavailable | Treat Agent as separate deployment project. |
| Frontend API regression | Low-medium | UI errors | Keep API response shapes unchanged. |

---

## 20. Suggested implementation milestones

### Milestone A: workspace preparation

- [ ] Confirm this copied folder builds before migration if dependencies are installed.
- [ ] Create a new Git repository or branch for the copied project if desired.
- [ ] Confirm local Postgres connection string.

### Milestone B: schema baseline

- [ ] Archive old SQLite migrations or replace them in the copied project.
- [ ] Create `0001_postgres_initial.sql`.
- [ ] Create local Postgres database.
- [ ] Start backend and confirm migrations run.

### Milestone C: SQLx Postgres conversion

- [ ] Update `Cargo.toml` SQLx features.
- [ ] Update `db.rs` to `PgPool`.
- [ ] Update `main.rs` `DATABASE_URL` behavior.
- [ ] Convert all SQL placeholders from `?` to `$n`.
- [ ] Convert boolean SQL literals from `0`/`1` to `false`/`true`.
- [ ] Fix aggregate decode types.
- [ ] Run `cargo check` until clean.

### Milestone D: backend tests

- [ ] Run `cargo test`.
- [ ] Fix compile/runtime failures.
- [ ] Add at least one database smoke test if none exists.

### Milestone E: local full-stack verification

- [ ] Run backend locally against Postgres.
- [ ] Run frontend locally.
- [ ] Complete manual checklist.

### Milestone F: Supabase verification

- [ ] Create Supabase project.
- [ ] Get Postgres connection string.
- [ ] Run local backend against Supabase.
- [ ] Confirm migrations run in Supabase.
- [ ] Complete smoke test.

### Milestone G: hosted rollout

- [ ] Update Render `DATABASE_URL` to Supabase.
- [ ] Redeploy Render backend.
- [ ] Confirm `/api/health`.
- [ ] Confirm Vercel frontend works.
- [ ] Monitor Render logs.
- [ ] Monitor Supabase database usage.

### Milestone H: optional data migration

- [ ] Decide if existing SQLite data matters.
- [ ] Write one-time migration script.
- [ ] Test script locally.
- [ ] Run script against Supabase only after backup/export.

---

## 21. Useful commands reference

### Backend local Postgres run

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
$env:HOST = "127.0.0.1"
$env:PORT = "8080"
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/factoryplan"
cargo run
```

### Backend tests

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
$env:DATABASE_URL = "postgresql://postgres:YOUR_PASSWORD@localhost:5432/factoryplan"
cargo test
```

### Frontend local run

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\frontend
npm install
npm run dev
```

### Supabase local backend smoke test

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
$env:DATABASE_URL = "postgresql://postgres:SUPABASE_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
cargo run
```

### Render backend health check

```powershell
curl https://factoryplan-backend.onrender.com/api/health
```

---

## 22. Recommended first implementation task

Start with only this:

```text
Make the copied backend compile and start against local Postgres with an empty schema.
```

Do not touch Supabase or Render until local Postgres works.

Detailed first task checklist:

- [ ] Create local Postgres DB `factoryplan`.
- [ ] Replace SQLx SQLite feature with Postgres feature.
- [ ] Convert `backend/src/db.rs` to `PgPool`.
- [ ] Replace migrations with Postgres baseline.
- [ ] Run `cargo check`.
- [ ] Fix compile errors.
- [ ] Run backend and confirm migrations apply.
- [ ] Hit `/api/health`.

After that, continue with query placeholder conversion and endpoint testing.

---

## 23. Final recommendation

Use this migration path:

```text
SQLite current app remains deployed and usable.
Copied workspace moves to local Postgres.
Local Postgres success unlocks Supabase.
Supabase success unlocks Render production DATABASE_URL switch.
```

This approach keeps the working app safe while building the Postgres version deliberately.
