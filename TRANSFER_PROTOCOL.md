# Transfer Protocol — setting up factoryplan-rust on another machine

> Note: this older handoff guide is retained for context. For the current
> PostgreSQL/GitHub setup, prefer `DEVIN_SETUP.md`. For the Docker/WSL workflow,
> prefer `DOCKER_SETUP.md`.

This guide explains how to stand up the app on a coworker's desktop. It is a
local dev project, so setup = install toolchains, copy the source, run two dev
servers. Targets **Windows / PowerShell**; macOS/Linux notes are inline where
they differ.

Reference versions known to work (the machine this was authored on):
Rust **1.92**, Node **20 LTS**, npm **10**.

---

## 1. Install prerequisites (one-time, per machine)

| Tool | Why | Install | Verify |
|---|---|---|---|
| **Rust** (`cargo`) | builds/runs the backend | https://rustup.rs → run `rustup-init.exe`, accept defaults, reopen terminal | `cargo --version` |
| **Node.js 20 LTS** (`node`, `npm`) | builds/runs the frontend | https://nodejs.org → MSI installer | `node --version` |
| **Git** *(optional)* | transfer via clone | https://git-scm.com | `git --version` |
| **`devin` CLI** *(optional)* | only for the **Agent** tab | install per https://cli.devin.ai/docs, then `devin auth login` | `devin --version` |

No admin rights or extra system libraries are required beyond these — SQLite is
bundled into the backend, and Plotly is just an npm package. The Agent tab is the
**only** feature that needs `devin`; everything else works without it.

---

## 2. Get the source onto the machine

Pick one method.

### Option A — Git (best for ongoing sharing)
On the source machine (one-time, if no remote yet):
```powershell
cd C:\Users\pdangol\CascadeProjects\factoryplan-rust
git remote add origin <your-repo-url>
git push -u origin main
```
On the target machine:
```powershell
git clone <your-repo-url>
```

### Option B — Zip & copy
Zip the project folder but **exclude generated/large files** so it stays small:

- `backend\target\` — Rust build output (regenerates)
- `frontend\node_modules\` — npm dependencies (regenerates)
- `backend\factoryplan.db` (+ `-wal`, `-shm`) — the database (~90 MB). Only
  include it if you want to carry your existing scenarios over (see §4).

---

## 3. Run it (two terminals)

**Terminal 1 — backend** (first build takes a few minutes; creates the DB if missing):
```powershell
cd <path>\factoryplan-rust\backend
cargo run
```
Wait for: `factoryplan-backend starting on 127.0.0.1:8080`. **Ctrl+C** stops it.

**Terminal 2 — frontend:**
```powershell
cd <path>\factoryplan-rust\frontend
npm install      # first time only
npm run dev      # http://localhost:5173 (or 5174 if the port is busy)
```

Open the URL it prints. The dev server proxies `/api/*` to the backend
automatically — no extra configuration needed.

---

## 4. (Optional) bring existing data

A fresh setup starts with an **empty database**. To carry over your scenarios /
factories / products / demand / runs:

1. **Stop the backend** on both machines (Ctrl+C) so the SQLite file is flushed.
2. Copy these from the source `backend\` folder into the target `backend\` folder:
   - `factoryplan.db`
   - `factoryplan.db-wal` and `factoryplan.db-shm` (if present)
3. Start the backend again.

Otherwise, just start fresh and build scenarios in the UI.

---

## 5. Configuration (environment variables)

The backend reads these (all optional):

| Var | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to allow other machines on the LAN to reach it. |
| `PORT` | `8080` | Bind port. |
| `DATABASE_URL` | `sqlite://factoryplan.db` | SQLite file path. |
| `RUST_LOG` | `info` | Log filter. |
| `DEVIN_CMD` | `devin` | Path to the `devin` CLI (override if not on PATH). |

Example (PowerShell, this session only):
```powershell
$env:PORT = "9000"; cargo run
```

---

## 6. Deployment models — pick what fits

### A. Each coworker runs their own copy (what §1–§3 describe)
Best when people want to work independently. Each desktop installs Rust + Node.

### B. One shared instance on your machine (no installs elsewhere)
Coworkers just open a browser; nothing to install on their desktops.
1. Build the frontend to static files:
   ```powershell
   cd frontend
   npm run build        # outputs to frontend\dist
   ```
2. Serve `frontend\dist` with any static server (e.g. `npx serve dist`) and run
   the backend with `HOST=0.0.0.0` so other machines can reach the API. The
   backend already allows cross-origin requests (CORS is open), so the static
   site can call `http://<your-ip>:8080/api/...`.
3. Share `http://<your-ip>:<port>`. (Open the Windows Firewall for that port.)

> Note: the Vite `/api` proxy only applies to `npm run dev`. For a production
> build you must point the frontend at the backend's real origin (same host, or
> via the open CORS policy).

### C. Packaged / Docker / one-click — not built yet
There is currently **no** Dockerfile or start script. If you want a coworker to
"double-click and go," ask and these can be added:
- a `Dockerfile` (multi-stage: build Rust + frontend, serve both), and/or
- a `run.ps1` that launches backend + frontend together, and/or
- having the backend serve the built frontend directly (single process, single
  port) so there's nothing to proxy.

---

## 7. Troubleshooting

- **`cargo` / `node` not recognized** → reopen the terminal after installing (PATH
  refresh), or restart the machine.
- **Port already in use** → another instance is running. Free port 8080:
  ```powershell
  Get-NetTCPConnection -LocalPort 8080 | Select-Object -Expand OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force }
  ```
  or change `PORT` (backend) — the frontend dev server auto-picks the next free port.
- **"Backend not reachable" in the UI** → the backend isn't running, or is on a
  different port than the frontend proxy expects (`127.0.0.1:8080`).
- **Agent tab says it can't start the agent** → `devin` isn't installed / on PATH,
  or not logged in. Run `devin --version` and `devin auth status`.
- **First `cargo run` is slow** → that's the one-time dependency compile; later
  runs are fast.

---

## 8. Quick checklist

- [ ] Rust installed (`cargo --version`)
- [ ] Node 20 installed (`node --version`)
- [ ] Source copied/cloned (without `target/`, `node_modules/`)
- [ ] `cargo run` in `backend/` → "starting on 127.0.0.1:8080"
- [ ] `npm install` then `npm run dev` in `frontend/`
- [ ] Browser opens the app; create or import a scenario
- [ ] *(optional)* `factoryplan.db` copied over for existing data
- [ ] *(optional)* `devin` installed + logged in for the Agent tab
