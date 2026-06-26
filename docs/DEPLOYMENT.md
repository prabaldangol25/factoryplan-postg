# Deployment plan: Render backend + Vercel frontend

This project is already committed and pushed to GitHub:

- Repository: `https://github.com/prabaldangol25/factoryplan-rust`
- Frontend framework: Vite + React in `frontend/`
- Backend framework: Rust + Actix-web + SQLite in `backend/`

The recommended production setup is:

- **Render** hosts the long-running Rust API server and its persistent SQLite database.
- **Vercel** hosts the static Vite frontend and points it at the Render API URL.

Vercel alone should not host the backend as-is because the backend is a persistent Actix web server using SQLite. It needs a long-running process and durable disk storage.

---

## Current state

Already completed locally:

1. GitHub repo created and pushed.
2. Frontend has been updated to support `VITE_API_BASE_URL`.
3. Frontend has been deployed once to Vercel.
4. Generated local files and SQLite sidecar files are ignored by Git.

Current Vercel URLs from the first deployment:

- Production deployment: `https://frontend-3nnjck7eb-gops1.vercel.app`
- Alias: `https://frontend-orcin-seven-85.vercel.app`

These frontend URLs will load the UI, but API-backed features will not work until the backend is live and `VITE_API_BASE_URL` is configured in Vercel.

---

## Step 1: Deploy the backend on Render

In Render, create a new **Web Service** from the GitHub repository.

### Render service settings

Use these settings:

| Setting | Value |
|---|---|
| Service type | `Web Service` |
| Repository | `prabaldangol25/factoryplan-rust` |
| Root Directory | `backend` |
| Runtime | Rust / Native build from `Cargo.toml` |
| Build Command | `cargo build --release` |
| Start Command | `./target/release/factoryplan-backend` |
| Instance type | Starter is fine for initial testing |

### Render environment variables

Set these environment variables on the Render backend service:

| Variable | Value | Notes |
|---|---|---|
| `HOST` | `0.0.0.0` | Required so Render can route traffic to the service. |
| `DATABASE_URL` | `sqlite:///var/data/factoryplan.db` | Stores SQLite on the persistent disk. |
| `RUST_LOG` | `info` | Optional but useful for logs. |

Do **not** manually set `PORT` unless Render specifically requires it. The app reads `PORT`, and Render provides it automatically for web services.

### Render persistent disk

Add a persistent disk to the Render service:

| Disk setting | Value |
|---|---|
| Mount path | `/var/data` |
| Size | Start with `1 GB`; increase if needed |

The backend creates the SQLite file automatically if it does not exist. It also runs embedded SQL migrations on startup.

### Backend health check

After the Render deploy finishes, open:

```text
https://<your-render-service>.onrender.com/api/health
```

Expected response:

```json
{
  "status": "ok",
  "service": "factoryplan-backend",
  "version": "0.1.0"
}
```

Save the backend origin, without a trailing slash, for the Vercel step. Example:

```text
https://factoryplan-backend.onrender.com
```

---

## Step 2: Configure the Vercel frontend

The Vercel frontend must know the backend origin. Set this environment variable in Vercel:

| Variable | Value |
|---|---|
| `VITE_API_BASE_URL` | `https://<your-render-service>.onrender.com` |

Use the Render service origin only. Do not include `/api` at the end.

### Option A: Vercel dashboard

1. Open the Vercel project.
2. Go to **Settings → Environment Variables**.
3. Add `VITE_API_BASE_URL`.
4. Set it for **Production**.
5. Redeploy the latest deployment or trigger a new production deploy.

### Option B: Vercel CLI

From the repo root:

```powershell
npx vercel env add VITE_API_BASE_URL production
```

Paste the Render backend origin when prompted, for example:

```text
https://factoryplan-backend.onrender.com
```

Then redeploy production:

```powershell
npx vercel frontend --prod
```

---

## Step 3: Verify the full app

After the frontend redeploys, open the production Vercel URL and verify:

1. The UI loads.
2. The Scenarios tab loads without API errors.
3. Creating a scenario works.
4. Adding a factory/product/demand row works.
5. Running the scheduler works.
6. Exporting CSV/XLSX works.

Also verify the backend directly:

```text
https://<your-render-service>.onrender.com/api/health
```

---

## Important notes

### Agent tab

The Agent tab depends on the `devin` CLI being installed and authenticated on the backend host. A standard Render Rust service will not have an authenticated `devin` CLI by default.

The rest of the app works without it. If the Agent tab is required in production, handle that as a separate deployment task and avoid placing credentials in Git.

### SQLite persistence

SQLite is acceptable for this small planning app if the Render service runs as a single instance with a persistent disk. Do not scale the backend horizontally with multiple instances while using one SQLite database file.

For a larger multi-user production app, migrate from SQLite to Postgres.

### Existing local data

The GitHub repo intentionally does not include the local SQLite database. The first hosted deploy will start with an empty database.

If existing local scenarios must be moved to production, stop the local backend first so SQLite flushes cleanly, then copy these files into the Render persistent disk using an approved Render data import method:

- `backend/factoryplan.db`
- `backend/factoryplan.db-wal`, if present
- `backend/factoryplan.db-shm`, if present

Only do this if you intentionally want the hosted app to contain the local data.

### CORS

The backend currently allows cross-origin requests, so the Vercel frontend can call the Render backend directly.

---

## Deployment order checklist

- [ ] Create Render Web Service from `prabaldangol25/factoryplan-rust`.
- [ ] Set Render root directory to `backend`.
- [ ] Set Render build command: `cargo build --release`.
- [ ] Set Render start command: `./target/release/factoryplan-backend`.
- [ ] Add Render persistent disk at `/var/data`.
- [ ] Set Render env vars: `HOST=0.0.0.0`, `DATABASE_URL=sqlite:///var/data/factoryplan.db`, `RUST_LOG=info`.
- [ ] Deploy Render backend.
- [ ] Confirm `/api/health` returns `status: ok`.
- [ ] Set Vercel env var `VITE_API_BASE_URL` to the Render backend origin.
- [ ] Redeploy Vercel frontend production.
- [ ] Verify app features end-to-end.
