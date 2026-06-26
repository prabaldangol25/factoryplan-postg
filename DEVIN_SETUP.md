# Devin setup guide — factoryplan-postg

This file is intended for a Devin agent setting up this project on a fresh coworker machine from GitHub. It assumes **no local data transfer** is needed; the target setup starts with an empty PostgreSQL database.

## Project summary

`factoryplan-postg` is a local planning app with:

- Rust / Actix backend on `127.0.0.1:8080`
- PostgreSQL database named `factoryplan`
- React / Vite frontend on `localhost:5173` or the next available Vite port
- Optional Agent tab that shells out to the target user's authenticated `devin` CLI

Current default backend database URL:

```text
postgresql://postgres:postgres@localhost:5432/factoryplan
```

Do not copy another user's Devin credentials, Postgres data directory, or local auth/config files. If installers or firewall changes need admin rights, ask the user or IT/admin to approve/run them.

---

## 1. Prerequisites

Install or verify these tools on the target machine.

| Tool | Required for | Verify |
|---|---|---|
| Git | cloning from GitHub | `git --version` |
| Rust / Cargo | backend build/run | `cargo --version` |
| Node.js 20.19+ / npm | frontend build/run | `node --version`; `npm --version` |
| PostgreSQL 17 or compatible | database | `psql --version` |
| Devin CLI | Agent tab only | `devin --version` |

Preferred installs:

- Git: https://git-scm.com/downloads
- Rust: https://rustup.rs
- Node.js LTS: https://nodejs.org
- PostgreSQL: https://www.postgresql.org/download/windows/
- Devin CLI: https://cli.devin.ai/docs

After installing tools that modify PATH, reopen PowerShell before verifying.

---

## 2. Clone the repository

If the repo URL is not known, ask the user for it.

```powershell
cd $env:USERPROFILE
mkdir CascadeProjects -ErrorAction SilentlyContinue
cd CascadeProjects
git clone <GITHUB_REPO_URL> factoryplan-postg
cd factoryplan-postg
```

If the repo was already cloned:

```powershell
cd $env:USERPROFILE\CascadeProjects\factoryplan-postg
git pull
```

---

## 3. Create the PostgreSQL database

The backend expects a database named `factoryplan` unless `DATABASE_URL` is overridden.

### Standard Windows PostgreSQL install path

```powershell
$env:PGPASSWORD = "postgres"
& "C:\Program Files\PostgreSQL\17\bin\createdb.exe" -U postgres -h localhost -p 5432 factoryplan
```

If `factoryplan` already exists, this command may fail with `database already exists`; that is okay. Verify connectivity:

```powershell
$env:PGPASSWORD = "postgres"
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -p 5432 -d factoryplan -c "select current_database();"
```

### If PostgreSQL is on PATH

```powershell
$env:PGPASSWORD = "postgres"
createdb -U postgres -h localhost -p 5432 factoryplan
psql -U postgres -h localhost -p 5432 -d factoryplan -c "select current_database();"
```

### If the local Postgres password/user differs

Use the actual approved local credentials and set `DATABASE_URL` before running the backend:

```powershell
$env:DATABASE_URL = "postgresql://<USER>:<PASSWORD>@localhost:5432/factoryplan"
```

Do not store real passwords in Git.

---

## 4. Run backend

Open PowerShell terminal 1:

```powershell
cd $env:USERPROFILE\CascadeProjects\factoryplan-postg\backend
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
$env:RUST_LOG = "info"
cargo run
```

Expected log line:

```text
factoryplan-backend starting on 127.0.0.1:8080
```

The backend runs embedded migrations automatically on startup.

Health check from another terminal:

```powershell
curl.exe http://127.0.0.1:8080/api/health
```

Expected response includes:

```json
{"status":"ok","service":"factoryplan-backend"}
```

---

## 5. Run frontend

Open PowerShell terminal 2:

```powershell
cd $env:USERPROFILE\CascadeProjects\factoryplan-postg\frontend
npm install
npm run dev
```

Open the Vite URL printed by the command, usually:

```text
http://localhost:5173
```

In dev mode, the frontend proxies `/api/*` to `http://127.0.0.1:8080`.

---

## 6. Configure Agent tab with the target user's Devin CLI

The app's Agent tab works only if the backend process can run the `devin` CLI.

On the target machine, authenticate as the target user:

```powershell
devin auth login
devin auth status
devin --version
```

If `devin` is on PATH, no backend env var is needed. If not, set `DEVIN_CMD` before `cargo run`:

```powershell
$env:DEVIN_CMD = "C:\Path\To\devin.exe"
```

Then restart the backend and test the Agent tab with a simple prompt:

```text
Summarize this scenario.
```

Do not copy another user's Devin auth tokens or config directory.

---

## 7. Verification commands

Run these before calling setup complete.

### Backend checks

```powershell
cd $env:USERPROFILE\CascadeProjects\factoryplan-postg\backend
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
cargo test
cargo check
```

### Frontend checks

```powershell
cd $env:USERPROFILE\CascadeProjects\factoryplan-postg\frontend
npm run build
npm audit
```

Expected:

- Rust tests pass
- Backend check finishes successfully
- Frontend build succeeds
- `npm audit` reports `found 0 vulnerabilities`

---

## 8. UI smoke test

With backend and frontend running:

1. Open the frontend URL.
2. Create a scenario.
3. Add at least one factory.
4. Add at least one product and lead time.
5. Add demand, including spreadsheet paste into the quantity matrix.
6. Run the scheduler.
7. Confirm Results tab loads:
   - recommendation panel
   - quarterly backlog
   - expandable actual shipments by quarter
   - shipment summary
   - Gantt chart
   - report table
8. Test CSV/XLSX export.
9. If Devin CLI is configured, test Agent tab.

---

## 9. Common troubleshooting

### `cargo` / `node` / `psql` / `devin` not recognized

Reopen PowerShell after install. If still missing, check the tool's install directory and PATH. Ask the user/admin before changing system-wide settings.

### Backend cannot connect to database

Verify Postgres service is running and credentials are correct:

```powershell
$env:PGPASSWORD = "postgres"
& "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -p 5432 -d factoryplan -c "select 1;"
```

If credentials differ, set `DATABASE_URL` accordingly.

### Port 8080 already in use

Find the owner:

```powershell
Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress,LocalPort,OwningProcess,@{Name='ProcessName';Expression={(Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName}}
```

Do not kill unrelated processes without user approval. Either stop the known existing backend or run this backend on another port:

```powershell
$env:PORT = "8081"
cargo run
```

If changing backend port, update the frontend proxy or run with the expected default `8080`.

### Frontend says backend not reachable

Confirm backend health:

```powershell
curl.exe http://127.0.0.1:8080/api/health
```

Start/restart backend if needed.

### Agent tab fails

Check:

```powershell
devin --version
devin auth status
```

If needed, set `DEVIN_CMD` before starting the backend.

---

## 10. GitHub push checklist for source owner

Before asking the coworker/Devin agent to set up from GitHub:

```powershell
cd C:\Users\pdangol\CascadeProjects\facotryplan-postg
git status
```

Review changes, then commit and push through the normal approved workflow. Ensure the repo does not include:

- `backend/target/`
- `frontend/node_modules/`
- `frontend/dist/`
- database dumps or local Postgres data
- Devin auth files or tokens
- `.env` files containing real credentials

Useful final checks before push:

```powershell
cd backend
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
cargo test

cd ..\frontend
npm run build
npm audit
```
