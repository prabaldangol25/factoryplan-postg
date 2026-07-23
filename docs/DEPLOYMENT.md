# Deployment plan: Render backend + Supabase Postgres + Vercel frontend

## Target architecture

- **Render** runs the Rust/Actix backend as a stateless web service.
- **Supabase** hosts the PostgreSQL database.
- **Vercel** serves the Vite/React frontend and continues to use the Render backend origin through `VITE_API_BASE_URL`.

The backend is already PostgreSQL-native. SQLx uses the Postgres driver, all application migrations are Postgres-compatible, and migrations run automatically when the backend starts. Moving to Supabase is therefore a database copy and `DATABASE_URL` cutover, not an application rewrite.

## Migration goals

1. Preserve all production application data.
2. Keep the existing Render database unchanged during the acceptance period.
3. Minimize the write freeze during final export and restore.
4. Avoid placing database credentials in source control, shell history, URLs in documentation, or logs.
5. Make rollback an environment-variable change while the old database is retained.

## Phase 1: Prepare Supabase

1. Create a Supabase project in the desired region.
2. Generate and store its database password in an approved password manager.
3. In Supabase database connection settings, copy these connection strings rather than constructing them manually:
   - a **direct** connection string for migrations and `pg_restore` when the machine running them has compatible network access;
   - a **session pooler** connection string for the long-running Render backend, especially when direct database networking is unavailable;
   - do not use the transaction pooler for migration or restore operations.
4. Ensure the selected URI requires TLS. Add `sslmode=require` only if the Supabase-provided URI does not already specify it.
5. Do not commit either connection string. Store the temporary local values only in process environment variables.

Suggested local variable names:

```powershell
$env:RENDER_DATABASE_URL = "<Render external PostgreSQL URL>"
$env:SUPABASE_DIRECT_URL = "<Supabase direct or session-pooler migration URL>"
```

## Phase 2: Initialize and verify the destination schema

The destination should start without factoryplan application tables. Point the local backend at Supabase once so the embedded SQLx migrations create the schema and `_sqlx_migrations` history:

```powershell
cd backend
$env:HOST = "127.0.0.1"
$env:PORT = "8080"
$env:DATABASE_URL = $env:SUPABASE_DIRECT_URL
$env:DB_POOL_MAX_CONNECTIONS = "3"
$env:DB_POOL_MIN_CONNECTIONS = "1"
cargo run
```

Confirm `/api/health`, then stop this local backend before restoring data. Inspect Supabase and verify migrations `0001` through `0014` are recorded. Do not create scenarios or other application data in Supabase yet.

## Phase 3: Rehearse the production copy

Before the final cutover, perform a rehearsal while the production backend remains online:

1. Create a custom-format, data-only dump from the Render PostgreSQL database.
2. Exclude `_sqlx_migrations`; Supabase already has migration history from Phase 2.
3. Restore into a disposable Supabase project or reset destination.
4. Compare row counts for every application table.
5. Run the backend locally against the restored database and exercise the application.
6. Delete the rehearsal destination only after recording the results. Never delete or alter the source database.

Use PostgreSQL client tools compatible with the source server version:

```powershell
$dump = Join-Path $PWD "factoryplan-production-data.dump"
pg_dump --format=custom --data-only --schema=public --exclude-table=public._sqlx_migrations --no-owner --no-privileges --file=$dump $env:RENDER_DATABASE_URL
pg_restore --data-only --no-owner --no-privileges --dbname=$env:SUPABASE_DIRECT_URL $dump
```

The dump contains production data and must not be committed. Delete it securely after the migration and retention window according to the applicable data-handling policy.

## Phase 4: Final cutover

### 4.1 Freeze writes

Stop or suspend the Render backend immediately before the final dump. The frontend may remain deployed, but API actions will be temporarily unavailable. Verify no process can write to the source database during the copy.

### 4.2 Create the final dump

Run the same `pg_dump` command used in rehearsal. Record:

- dump completion time;
- dump file size;
- source row counts;
- source database identifier.

### 4.3 Restore to Supabase

Restore the final dump into the already migrated, otherwise empty Supabase schema. If rehearsal data exists in the destination, reset only the factoryplan application tables before the final restore. Any reset/drop operation requires explicit confirmation and a verified backup.

### 4.4 Validate data before traffic

Compare source and destination counts for these tables:

```text
scenario
factory
factory_bay_count
factory_bay_week
product
product_lead_time
product_factory_lead_time
product_factory_allocation
demand
scenario_order
schedule_run
scheduled_unit
recommendation
quarter_miss
agent_conversation
agent_message
```

Also verify:

- all foreign keys are valid;
- all 14 SQLx migrations are present;
- a representative scenario contains its factories, orders, weekly capacity, runs, and anchored units;
- no application table contains duplicate primary keys.

### 4.5 Switch Render

Set these variables on the existing Render backend service:

```text
HOST=0.0.0.0
DATABASE_URL=<Supabase session-pooler connection string with TLS required>
DB_POOL_MAX_CONNECTIONS=3
DB_POOL_MIN_CONNECTIONS=1
RUST_LOG=info
APP_PASSWORD=<existing shared password>
ALLOWED_ORIGINS=<Vercel frontend origin, for example https://your-app.vercel.app>
```

`3` is a conservative initial application-pool size, not a universal Supabase limit. Confirm the current project connection allowance in Supabase and tune this value without code changes.

Redeploy/restart Render. A backend restart invalidates existing application login sessions, so users must log in again with the same `APP_PASSWORD`.

Vercel does not require a database-related change. Keep:

```text
VITE_API_BASE_URL=<existing Render backend origin>
```

## Phase 5: Production smoke test

Verify in this order:

1. Render backend starts without migration or TLS errors.
2. `/api/health` returns `status: ok`.
3. Login succeeds with the existing shared password.
4. Existing scenarios and production row counts are present.
5. Open a representative scenario and inspect factories, weekly bays, orders, anchors, and run history.
6. Create a temporary validation scenario.
7. Run the scheduler and inspect Results and Report.
8. Export CSV/XLSX.
9. Delete only the temporary validation scenario after explicit confirmation.
10. Monitor Render and Supabase connection/error metrics through the acceptance period.

## Rollback

Retain the old Render database unchanged until acceptance is complete.

If cutover fails before new production writes are accepted:

1. stop the backend to freeze writes;
2. restore Render's previous `DATABASE_URL` value;
3. restore its previous pool settings if changed;
4. redeploy/restart Render;
5. verify health and representative source data.

If users have written data to Supabase after cutover, switching back alone loses those new writes from the active view. Freeze writes and explicitly reconcile/export the Supabase changes before rollback.

Do not delete the source Render database, its backups, or the final dump until the acceptance and rollback window has passed.

## Render cost change

Supabase removes the database workload from Render. The Render backend can run without a database persistent disk because all durable application state lives in Supabase. The Render PostgreSQL instance is no longer required after production has been verified against Supabase and the rollback window has passed. Do not delete or allow deletion of the old Render PostgreSQL instance until the Supabase row counts, smoke tests, and retention/backup requirements are complete.

The database migration does not eliminate the need to host the Rust web process. If Render's current free web-service tier is acceptable for the app's availability and cold-start requirements, the backend can be hosted as a stateless web service while the database lives in Supabase. If cold starts, uptime, or resource limits are not acceptable, use a paid Render web-service plan or another backend host.

## Release gates

Do not cut over production until all gates pass:

- [ ] Supabase project and connection strings created.
- [ ] Destination migrations `0001`–`0014` applied.
- [ ] Rehearsal dump/restore completed.
- [ ] Rehearsal row counts match.
- [ ] Local backend smoke test against restored Supabase data passes.
- [ ] Final source write freeze confirmed.
- [ ] Final dump completed and retained securely.
- [ ] Final restore completed.
- [ ] Final source/destination row counts match.
- [ ] Render environment values recorded for rollback.
- [ ] Render cutover succeeds.
- [ ] Full production smoke test passes.
- [ ] Monitoring shows no database connection errors.
