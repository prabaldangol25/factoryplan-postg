# Docker / WSL setup — factoryplan-postg

This setup runs the app in containers:

- `postgres` — PostgreSQL 17 with a persistent Docker volume
- `backend` — Rust/Actix API on container port `8080`
- `frontend` — built React/Vite app served by nginx on host port `3000`

Your existing local development workflow is unchanged. Docker mode uses its own PostgreSQL volume and does not overwrite your local Postgres database.

## Requirements

- Docker Desktop installed and running
- WSL 2 integration enabled in Docker Desktop if running commands from WSL
- Git clone of this repository

The Agent tab is not the focus of Docker mode. The backend container does not include or authenticate the host user's `devin` CLI by default. Use local dev mode for Agent tab testing.

---

## Recommended WSL workflow

From WSL, work inside the Linux filesystem for better Docker build performance:

```bash
mkdir -p ~/projects
cd ~/projects
git clone <GITHUB_REPO_URL> factoryplan-postg
cd factoryplan-postg
```

If you are testing the current Windows working copy from WSL, use the mounted path instead:

```bash
cd /mnt/c/Users/pdangol/CascadeProjects/facotryplan-postg
```

This works, but builds may be slower than cloning under `~/projects` in WSL.

---

## Start the full app

```bash
docker compose up --build
```

Open:

```text
http://localhost:3000
```

The frontend nginx container proxies `/api/*` to the backend container, so the browser only needs port `3000`.

Backend health check from host/WSL:

```bash
curl http://localhost:8080/api/health
```

Expected response includes:

```json
{"status":"ok","service":"factoryplan-backend"}
```

---

## Stop the app

Press `Ctrl+C`, then:

```bash
docker compose down
```

This stops/removes containers but keeps the Postgres data volume.

---

## Reset Docker database

This deletes all Docker-mode database data:

```bash
docker compose down -v
```

Then restart fresh:

```bash
docker compose up --build
```

---

## Services and ports

| Service | Container | Host URL |
|---|---|---|
| Frontend nginx | `frontend:80` | `http://localhost:3000` |
| Backend API | `backend:8080` | `http://localhost:8080` |
| Postgres | `postgres:5432` | `localhost:5433` |

Postgres is exposed on host port `5433` to avoid colliding with a local Postgres on `5432`.

Container backend uses:

```text
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/factoryplan
```

Host tools can connect to Docker Postgres with:

```bash
psql postgresql://postgres:postgres@localhost:5433/factoryplan
```

---

## Rebuild after code changes

For production-style Docker mode:

```bash
docker compose up --build
```

For active development with hot reload and Devin Agent tab, use local dev mode instead:

```powershell
# backend terminal
cd backend
$env:DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/factoryplan"
cargo run

# frontend terminal
cd frontend
npm run dev
```

---

## Troubleshooting

### Docker is not available from WSL

Confirm Docker Desktop is running, then in Docker Desktop enable:

```text
Settings → Resources → WSL Integration → Enable integration with your distro
```

Then restart WSL:

```powershell
wsl --shutdown
```

Open WSL again and run:

```bash
docker version
docker compose version
```

### Port already in use

If `3000`, `8080`, or `5433` is already used, change the host-side port in `docker-compose.yml`.

Example:

```yaml
ports:
  - "3001:80"
```

Then open `http://localhost:3001`.

### Backend waits for database

Compose uses a Postgres healthcheck. If startup still fails, inspect logs:

```bash
docker compose logs postgres
docker compose logs backend
```

### Agent tab fails in Docker mode

Expected unless the image is extended to install/authenticate `devin`. Use local dev mode for Agent tab.
