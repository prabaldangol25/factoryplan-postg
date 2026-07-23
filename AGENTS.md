# Project guidance for agents

## Project overview

This repository contains `factoryplanMS`, a finite-capacity production planning app.

- Backend: Rust 2021, Actix-web, Tokio, SQLx, PostgreSQL.
- Frontend: React, Vite, TypeScript, Tailwind.
- Production architecture: Vercel frontend -> Render Rust backend -> Supabase Postgres.
- The browser/frontend must not connect directly to Supabase or contain database credentials.

## Important paths

- Backend entrypoint: `backend/src/main.rs`
- Database pool and helpers: `backend/src/db.rs`
- Embedded SQLx migrations: `backend/migrations/*.sql`
- Backend handlers: `backend/src/handlers/`
- Scheduler core: `backend/src/scheduling.rs`
- Recommendations: `backend/src/recommendations.rs`
- Frontend API client: `frontend/src/api/index.ts`
- Frontend app shell: `frontend/src/App.tsx`
- Deployment plan: `docs/DEPLOYMENT.md`

## Local development

Backend:

```bash
cd backend
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/factoryplan cargo run
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8080`.

## Verification commands

Backend tests:

```bash
cd backend
cargo test
```

Frontend build:

```bash
cd frontend
npm run build
```

Frontend lint:

```bash
cd frontend
npm run lint
```

## Production environment notes

Render backend should be treated as stateless. Durable application data lives in Supabase Postgres.

Recommended Render backend environment variables after Supabase cutover:

```text
HOST=0.0.0.0
DATABASE_URL=<Supabase session-pooler connection string with TLS required>
DB_POOL_MAX_CONNECTIONS=3
DB_POOL_MIN_CONNECTIONS=1
RUST_LOG=info
APP_PASSWORD=<shared app password>
ALLOWED_ORIGINS=<Vercel frontend origin>
```

`APP_PASSWORD` is required when binding the backend to a non-local host. Do not remove this protection unless a stronger authentication layer is added.

Keep database pool sizes conservative for Supabase. Prefer the Supabase session pooler for the Render backend. Do not use the transaction pooler for migrations or restore operations.

## Render/Supabase migration safety

After moving the database to Supabase:

- The old Render PostgreSQL database is no longer needed for steady-state production.
- Do not delete or allow deletion of the old Render PostgreSQL database until Supabase row counts, smoke tests, backups, and the rollback window are complete.
- Vercel should continue pointing `VITE_API_BASE_URL` at the backend origin, not at Supabase.
- Never commit database URLs, dumps, passwords, or Supabase credentials.

## Security expectations

- Do not log secrets or connection strings.
- Keep `APP_PASSWORD` set in production unless replaced by real authentication.
- Restrict CORS with `ALLOWED_ORIGINS` in production.
- Do not add frontend code that directly uses privileged Supabase keys.
- Agent tab deployment is separate: it requires the `devin` CLI installed and authenticated on the backend host.
