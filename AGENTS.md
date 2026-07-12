# AGENTS.md

## Cursor Cloud specific instructions

OpenWA is a NestJS API (`src/`) plus a React/Vite dashboard (`dashboard/`). Standard
setup/run/test commands live in `CONTRIBUTING.md`, root `package.json` scripts, and
`.github/workflows/ci.yml` — refer to those rather than duplicating them. Notes below are
the non-obvious bits for working in this environment.

### Services & how to run

- `npm run dev` starts both services via `concurrently`: the API (with hot reload) on
  port **2785** and the Vite dashboard dev server on port **2886**. Use a background/tmux
  session — it is a long-running process.
- The Vite dev server (2886) proxies `/api` and `/socket.io` to the backend on 2785
  (see `dashboard/vite.config.ts`), so open the dashboard at **http://localhost:2886**
  during development. The backend also serves the *pre-built* bundled dashboard at 2785
  (from `dashboard/dist`), but that copy only reflects the last `npm run dashboard:build`.
- Swagger API docs: http://localhost:2785/api/docs.

### Config, database, and auth (non-obvious)

- No external services are required for local dev: it defaults to **SQLite**
  (`data/openwa.sqlite`, `data/main.sqlite`) and local-filesystem media storage. Redis,
  Postgres, MinIO/S3 are all optional and disabled by default.
- A `.env` is **not strictly required** — on first run the app auto-generates default
  config and writes `data/.env.generated`. For explicit dev defaults, copy `.env.minimal`
  (or `.env.example`) to `.env`. `.env` and the whole `data/` dir are gitignored.
- On first startup the app **auto-creates an API key**, prints it in the API logs
  (`AuthService` banner), and stores it at **`data/.api-key`**. Read that file to get the
  key for authenticating dashboard login and REST calls (header `X-API-Key: <key>`).
  Setting `API_MASTER_KEY` in `.env` overrides this.
- Harmless startup warnings you can ignore: `chmod 0o600 ... ENOENT` for files under
  `data/` on the very first run, and `DockerService ... connect ENOENT /var/run/docker.sock`
  (Docker container orchestration is optional and simply disabled when Docker is absent).

### Lint / test / build gotchas

- `npm run lint` currently reports a few pre-existing `no-floating-promises` **warnings**
  in `src/engine/adapters/baileys.adapter.ts` (0 errors) — these are not introduced by
  setup.
- CI (`.github/workflows/ci.yml`) additionally runs `npx tsc --noEmit -p tsconfig.json`
  (full-program type-check incl. specs), `npm run format -- --check`, `npm run check:versions`,
  and `npm run openapi:check` (fails if `openapi.json` is stale after controller/DTO
  changes — regenerate with `npm run openapi:export`). Run these before pushing.
- Jest mocks `@whiskeysockets/baileys` (see `package.json` jest config) so unit tests do
  not need a real WhatsApp connection.

### End-to-end WhatsApp caveat

- True message send/receive requires linking a real WhatsApp account by scanning the QR
  (`GET /api/sessions/:id/qr`) with the default `whatsapp-web.js` engine (Puppeteer/
  Chromium, already installed). Session/API/dashboard CRUD can be exercised fully without
  a linked phone.
