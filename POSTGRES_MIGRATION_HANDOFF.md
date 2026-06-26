# Postgres/Supabase migration handoff

Workspace:

```text
C:\Users\pdangol\CascadeProjects\facotryplan-postg
```

Primary migration spec:

```text
POSTGRES_SUPABASE_MIGRATION_SPEC.md
```

## Current status

The backend Postgres conversion pass is complete and has been verified against a local PostgreSQL 17 database.

Completed work:

- Switched backend SQLx dependency from SQLite to Postgres in `backend/Cargo.toml`.
- Converted `backend/src/db.rs` from `SqlitePool` to `PgPool`.
- Updated `backend/src/main.rs` default local `DATABASE_URL` to:

  ```text
  postgresql://postgres:postgres@localhost:5432/factoryplan
  ```

- Replaced `backend/migrations/0001_initial.sql` with a Postgres-compatible baseline schema.
- Converted `backend/migrations/0002_factory_bay_count.sql` through `0008_factory_changeover_days.sql` to no-op `SELECT 1;` migrations because their schema changes are included in the new baseline.
- Converted backend SQL placeholders from SQLite `?` to Postgres `$1`, `$2`, etc.
- Converted boolean SQL literals for scenario active flags from `0`/`1` to `false`/`true`.
- Updated run persistence transaction type from `sqlx::Sqlite` to `sqlx::Postgres`.
- Kept Rust API/model behavior stable by using `BIGINT` in the Postgres baseline for numeric columns that existing Rust models decode as `i64`.
- Created and verified the local Postgres database `factoryplan` owned by the `postgres` role.
- Verified the local `postgres` role password used for development is `postgres`.

## Local environment status

PostgreSQL is installed here:

```text
C:\Program Files\PostgreSQL\17
```

Direct executable check worked:

```powershell
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" --version
```

Output was:

```text
psql (PostgreSQL) 17.10
```

Local Postgres currently has these relevant databases:

- `factoryplan` - project database for this migration.
- `bookstore` - created accidentally during pgAdmin exploration; not used by this project.
- `postgres`, `template0`, `template1` - default PostgreSQL databases.

The required connection string for local development is:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
```

## Verification completed

### Backend compile and unit tests

From the repository, these commands were run using the backend manifest path and local Postgres `DATABASE_URL`:

```powershell
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
cargo check --manifest-path "C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend\Cargo.toml"
cargo test --manifest-path "C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend\Cargo.toml"
```

Results:

- `cargo check` passed.
- `cargo test` passed: 30 tests passed, 0 failed.
- Remaining warnings are existing dead-code warnings in `scheduling.rs`.

Earlier conversion scans also completed:

- No SQLite imports/defaults remained in backend Rust/TOML/SQL.
- No SQL-style raw `?` placeholders remained in backend Rust query strings.
- No SQLite `PRAGMA` or integer boolean schema patterns remained in backend migrations.

### Local backend run

The backend was run against local Postgres using:

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
$env:HOST = "127.0.0.1"
$env:PORT = "8080"
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
cargo run
```

Health check passed:

```powershell
curl.exe http://127.0.0.1:8080/api/health
```

Expected response:

```json
{"status":"ok","service":"factoryplan-backend","version":"0.1.0"}
```

### Local backend endpoint smoke tests

The following API flows were smoke tested successfully against local Postgres:

- Create scenario.
- Create factory.
- Create product with product lead times.
- Create product factory lead-time override.
- Create product factory allocation.
- Create demand.
- Run scheduler.
- Fetch run results.
- Export run CSV.
- Export run XLSX.
- Edit scenario.
- Edit factory and bay-count overrides.
- Edit product and lead times.
- Edit demand.
- Re-run scheduler after edits.

Example smoke-test IDs from the successful run:

```text
scenario=dd1aa187-53ca-467c-a3e3-5537637c4184
factory=d282efd5-789d-454a-abe5-36bc681d72ab
product=75dc6f8e-caaa-412d-a842-bf57d079eed2
demand=cf2197b1-f0d9-44b4-9cf4-331dd2b12152
run=8f24dad8-1f5e-4a40-8742-66aac1717165
rerun=f18a7161-47ca-432b-aec4-5768d4cfa74f
```

## Plan: use the app locally with Postgres

1. Start local PostgreSQL 17 if it is not already running.
2. Confirm the project database exists:

   ```powershell
   $env:PGPASSWORD = "postgres"
   & "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -p 5432 -c "\l"
   ```

   Confirm `factoryplan` appears in the database list.

3. Start the backend:

   ```powershell
   cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
   $env:HOST = "127.0.0.1"
   $env:PORT = "8080"
   $env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
   cargo run
   ```

4. In a second terminal, confirm the backend is healthy:

   ```powershell
   curl.exe http://127.0.0.1:8080/api/health
   ```

5. Start the frontend:

   ```powershell
   cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\frontend
   npm install
   npm run dev
   ```

6. Open the frontend:

   ```text
   http://localhost:5173
   ```

7. Manually test the main app flows against local Postgres:

   - Load app.
   - Create scenario.
   - Rename scenario.
   - Clone scenario.
   - Delete scenario.
   - Activate scenario.
   - Create factory.
   - Edit factory.
   - Set bay overrides.
   - Create product.
   - Edit product lead times.
   - Set factory-specific lead times.
   - Set factory allocations.
   - Create demand.
   - Import Excel demand if practical.
   - Run scheduler.
   - Inspect recommendations.
   - Inspect Gantt.
   - Inspect shipment summary.
   - Inspect report.
   - Export CSV.
   - Export XLSX.

## Plan: upload current local Postgres work to GitHub before Supabase

Goal: preserve the completed local Postgres migration before starting Supabase-specific changes.

Important current state: this workspace currently has a `.gitignore` file but no `.git` directory, so `git status` reports `fatal: not a git repository`. Before uploading to GitHub, either initialize this folder as a new git repository or copy these files into the intended existing repository clone.

Recommended workflow if this folder should become the GitHub repository:

1. Review the current folder contents:

   ```powershell
   cd C:\Users\pdangol\CascadeProjects\facotryplan-postg
   dir
   ```

2. Confirm no secrets are included in tracked files. The local password `postgres` is acceptable only as a local development default; do not commit real Supabase passwords.

3. Initialize git and make the first commit:

   ```powershell
   git init
   git status
   git add -A
   git status
   git commit -m "Migrate backend to local Postgres"
   ```

4. Create an empty GitHub repository in the GitHub UI.
5. Connect this local repository to GitHub and push. Replace the URL with the actual GitHub repository URL:

   ```powershell
   git remote add origin https://github.com/YOUR_USER/YOUR_REPO.git
   git branch -M main
   git push -u origin main
   ```

6. Open GitHub and confirm the commit is visible.

Recommended workflow if a GitHub repository already exists elsewhere:

1. Open or clone the real repository.
2. Copy the updated project files into that repository.
3. Run:

   ```powershell
   git status
   git diff
   ```

4. Confirm no secrets are included.
5. Commit and push from the real repository clone.

## Plan: Supabase implementation by pull request

Only start this after the local Postgres work is committed and uploaded to GitHub.

Recommended workflow:

1. Create a new branch for Supabase:

   ```powershell
   git checkout -b supabase-postgres
   ```

2. Create a Supabase project.
3. Save the Supabase database password securely outside the repository.
4. Get the direct database connection string from Supabase project settings. Expected pattern:

   ```text
   postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
   ```

5. Locally point the backend at Supabase without committing the password:

   ```powershell
   cd C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend
   $env:HOST = "127.0.0.1"
   $env:PORT = "8080"
   $env:DATABASE_URL = "postgresql://postgres:SUPABASE_PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
   cargo run
   ```

6. Verify Supabase smoke tests:

   - `/api/health`.
   - Create scenario.
   - Create factory.
   - Create product.
   - Create demand.
   - Run scheduler.

7. If Supabase requires connection-pool adjustments, update code/config in the branch and re-run backend verification.
8. Update Render environment variables after Supabase is verified:

   ```text
   HOST=0.0.0.0
   DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
   RUST_LOG=info
   ```

   Remove SQLite-specific Render disk/settings if still present.

9. Run final verification:

   ```powershell
   cargo check --manifest-path "C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend\Cargo.toml"
   cargo test --manifest-path "C:\Users\pdangol\CascadeProjects\facotryplan-postg\backend\Cargo.toml"
   ```

10. Commit Supabase-specific changes on the Supabase branch.
11. Push the Supabase branch.
12. Open a pull request from `supabase-postgres` into the main branch.
13. In the PR description, include:

    - Summary of Supabase changes.
    - Local Postgres verification results.
    - Supabase smoke-test results.
    - Render environment variable changes needed.
    - Confirmation that no secrets were committed.

## Resume prompt

Use this prompt next session if continuing from here:

```text
Continue the Postgres/Supabase migration in C:\Users\pdangol\CascadeProjects\facotryplan-postg. Read POSTGRES_MIGRATION_HANDOFF.md and POSTGRES_SUPABASE_MIGRATION_SPEC.md first. Local PostgreSQL 17 is installed, local database factoryplan exists, postgres/postgres works locally, backend health check passed, endpoint smoke tests passed, cargo check passed, and cargo test passed. Next: use the frontend locally against the local Postgres backend, then commit/push the local Postgres migration to GitHub, then start Supabase work on a separate PR branch.
```

## Do not forget

- Do not commit real Supabase passwords or production secrets.
- Use local `postgres:postgres` only for local development.
- Only move to Supabase after the local Postgres work is committed/uploaded.
- Supabase work should happen on a separate branch and be reviewed through a pull request.
