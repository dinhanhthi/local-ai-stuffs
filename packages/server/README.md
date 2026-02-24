# @ai-sync/server

Backend server for AI Sync. Built with Fastify 5, TypeScript (ESM), better-sqlite3, chokidar 5, and simple-git.

## Development

```bash
# From monorepo root (starts both server and UI)
pnpm dev

# Server only
pnpm dev:server

# Or from this directory
pnpm dev
```

Runs on port 2704 in dev mode (API backend for the Vite dev server on 2703), port 2703 in production.

## Build

```bash
# From monorepo root
pnpm build

# Or from this directory
pnpm build
```

## Production

```bash
# From monorepo root
pnpm start

# Override data directory
DATA_DIR=/path/to/data pnpm start
```

## Architecture

- **Fastify 5** REST API + WebSocket server
- **SQLite** (better-sqlite3) for local state
- **chokidar 5** for file watching with debounce
- **simple-git** for git operations (3-way merge sync)
- Serves the built React UI via `@fastify/static` in production

## Key directories

| Path            | Purpose                                                                        |
| --------------- | ------------------------------------------------------------------------------ |
| `src/routes/`   | REST API endpoints (setup, repos, files, sync, conflicts, settings, templates) |
| `src/services/` | Business logic (sync engine, file watcher, conflict detector, git manager)     |
| `src/db/`       | SQLite schema, initialization, and query helpers                               |
| `src/ws/`       | WebSocket event broadcasting                                                   |
| `src/types/`    | Shared TypeScript types                                                        |
