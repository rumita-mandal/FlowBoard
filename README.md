# TaskFlow – Full-Stack Kanban Board

A multi-user Kanban task manager: **Express REST API + SQLite + cookie-based auth**, with a dependency-free vanilla-JS client (optimistic UI, drag and drop, undo, search/filter/sort, dark mode, JSON import/export). Ships with tests, Docker, and CI.

**Live demo:** _add your URL here_ &nbsp;·&nbsp; **Try it without signing up:** click *"Try the live demo"* on the login screen.

## Features

- **Accounts & sessions** – register / login / logout; passwords hashed with **scrypt**; session is a signed **JWT in an HttpOnly, SameSite=Lax cookie** (unreadable by JavaScript)
- **One-click guest demo** – temporary seeded account, auto-purged after 24 h
- **Per-user data isolation** – every query is scoped by `user_id`; covered by tests
- **Kanban board** – To Do → In Progress → Done, drag and drop (plus arrow buttons for keyboard/touch), edit, delete with **undo**
- Search, priority filter, sorting, overdue detection, progress dashboard
- **Optimistic UI** – changes appear instantly; writes go through a serial request queue and the board re-syncs from the server if a write is rejected
- JSON export / import (invalid rows skipped and reported)
- Accessible (labelled controls, ARIA live toasts, focus styles, reduced-motion support)

## Architecture

```
Browser (vanilla JS)                    Node 22 / Express 5
┌───────────────────────┐   JSON/HTTPS  ┌──────────────────────────────┐
│ public/src/app.js     │ ────────────► │ server/app.js   routes       │
│  optimistic UI + queue│ ◄──────────── │ server/auth.js  scrypt + JWT │
│ public/src/store.js ◄─┼── shared ────►│ server/db.js    SQL (SQLite) │
│  pure validation logic│   validation  └──────────────┬───────────────┘
└───────────────────────┘                              ▼
                                                  data/taskflow.db (WAL)
```

```
taskflow/
├── server/
│   ├── index.js      # config, startup, guest purge job, graceful shutdown
│   ├── app.js        # Express app factory: middleware + routes
│   ├── auth.js       # scrypt hashing, JWT cookie sessions
│   └── db.js         # schema + all SQL (node:sqlite, transactions)
├── public/
│   ├── index.html · styles.css
│   └── src/store.js  # UMD module: runs in the browser AND is imported by the server
│       src/app.js    # DOM, events, API client
├── tests/            # 19 unit tests + 18 API integration tests (node:test, no extra deps)
├── Dockerfile · docker-compose.yml · render.yaml · .github/workflows/ci.yml
```

## Run locally

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`, so there are no native modules to compile).

```bash
npm install
npm start            # http://localhost:3000   (random dev JWT secret; data in ./data)
npm run dev          # auto-restart on change
npm test             # 37 tests
```

## Deploy

### Option A – Render (free, ~3 minutes)
1. Push this folder to a GitHub repo.
2. Render → **New → Blueprint** → select the repo. `render.yaml` provisions a Docker web service, generates `JWT_SECRET`, and wires the `/healthz` health check.
3. Open the `onrender.com` URL. Done.

> Render's free tier has no persistent disk, so SQLite data resets when the instance restarts or redeploys (fine for a demo; guest data is disposable anyway). To keep data, use a paid instance with the disk block in `render.yaml`, or mount a volume on any host below.

### Option B – Any Docker host (Railway, Fly.io, VPS)
```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
docker compose up --build        # http://localhost:3000, data in a named volume
```
On Railway/Fly: deploy from the Dockerfile, set `JWT_SECRET`, and attach a volume at `/data`.

### Environment variables
| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | – | **Required** when `NODE_ENV=production` (server refuses to start without it) |
| `PORT` | `3000` | |
| `DB_PATH` | `./data/taskflow.db` | Docker image uses `/data/taskflow.db` |
| `AUTH_RATE_LIMIT` | `30` | Login/register attempts per 15 min per IP |
| `GUEST_RATE_LIMIT` | `20` | Demo sessions per hour per IP |
| `COOKIE_SECURE` | `true` in production | Set `false` only for plain-http production runs |

## REST API

All task routes require the session cookie. Errors are `{ "error": "message" }`.

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/auth/register` | `{ email, password }` → 201, sets cookie, seeds a starter board |
| `POST` | `/api/auth/login` | `{ email, password }` → 200 |
| `POST` | `/api/auth/guest` | Temporary demo account |
| `POST` | `/api/auth/logout` | 204 |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/tasks` | All tasks in display order |
| `POST` | `/api/tasks` | Create (client may supply a well-formed `id`) |
| `PATCH` | `/api/tasks/:id` | Partial update |
| `DELETE` | `/api/tasks/:id` | 204 |
| `PUT` | `/api/tasks/order` | `{ tasks: [{ id, status }] }` – persist column + order after drag/drop. `409` if the list is stale |
| `POST` | `/api/tasks/import` | `{ tasks: [...] }` – invalid rows skipped, id collisions re-keyed |
| `GET` | `/healthz` | Liveness + DB check |

## Security notes

- scrypt password hashing with per-user salt; constant-time comparison; unknown-email logins cost the same as real ones (no timing-based user enumeration)
- JWT pinned to `HS256`, 7-day expiry, HttpOnly + SameSite=Lax (+ `Secure` in production)
- Origin check on all state-changing requests (CSRF defence in depth)
- `helmet` headers with a strict CSP (`script-src 'self'`), rate limiting on auth routes, 1 MB body limit, per-user task cap
- Parameterised SQL everywhere; client-supplied ids are regex-validated; UI renders user text with `textContent` only (no `innerHTML`)
- Container runs as a non-root user

## Design decisions (interview talking points)

- **Shared validation** – `store.js` is a UMD module used by both browser and server, so the rules can never drift. It's pure and DOM-free, which makes it trivially unit-testable.
- **Optimistic UI + serial queue** – instant feedback, ordered writes, automatic resync on failure. Cross-column reorder is a single idempotent `PUT /order`, which avoids per-card position races.
- **SQLite via `node:sqlite`** – zero native dependencies and a one-file database; all SQL is isolated in `db.js`, so moving to PostgreSQL means rewriting one module.
- **Composite key `(user_id, id)`** – lets clients mint ids for optimistic creates without cross-tenant collisions.
- **App factory + injected deps** – tests boot the real app on an ephemeral port with an in-memory DB.

## Known limitations / next steps

- SQLite on a single instance (no horizontal scaling); swap `db.js` for PostgreSQL to scale out
- No email verification or password reset
- Last-write-wins on concurrent edits from multiple tabs (stale reorders get a 409 and resync)
- Ideas: WebSocket live sync, boards/projects, subtasks, TypeScript migration, Playwright E2E in CI

## License

MIT
