# @ai-sync/ui

Web admin UI for AI Sync. Built with React 19, Vite, shadcn/ui, Tailwind CSS 4, and CodeMirror 6.

## Development

```bash
# From monorepo root (starts both UI and server)
pnpm dev

# UI only
pnpm dev:ui

# Or from this directory
pnpm dev
```

Opens at http://localhost:2703. In dev mode, API requests are proxied to the Fastify server on port 2704.

## Build

```bash
# From monorepo root
pnpm build

# Or from this directory
pnpm build
```

Output goes to `dist/` — served by the Fastify server in production.

## Pages

| Route           | Content                                                         |
| --------------- | --------------------------------------------------------------- |
| `/`             | Dashboard (repos, services, conflicts, unlinked items)          |
| `/repos/:id`    | Repository detail (file tree, editor, conflict resolver)        |
| `/services/:id` | Service detail (same layout as repo detail)                     |
| `/templates`    | Template management for new repos                               |
| `/settings`     | App settings (general, file patterns, ignore patterns, machine) |

## Tech

- **React 19** with React Router 7
- **shadcn/ui** components (Radix primitives)
- **CodeMirror 6** for file editing
- **Tailwind CSS 4** for styling
- **WebSocket** for real-time sync status updates
