# @ai-sync/landing

Public-facing landing page for AI Sync. Built with React, Vite, and Tailwind CSS (dark theme only).

## Development

```bash
# From monorepo root (starts all three: server, UI, and landing)
pnpm dev

# Landing page only
pnpm dev:landing

# Or from this directory
pnpm dev
```

Opens at http://localhost:2705

## Build

```bash
# From monorepo root
pnpm build:landing

# Or from this directory
pnpm build
```

Output goes to `dist/` — deploy to any static hosting (GitHub Pages, Vercel, Netlify, etc.).

## Pages

| Route        | Content                                                       |
| ------------ | ------------------------------------------------------------- |
| `/`          | Landing page (hero, features, diagrams, install instructions) |
| `/docs`      | Documentation (rendered from `docs/documentation.md`)         |
| `/changelog` | Changelog (rendered from `docs/changelog.md`)                 |

## Notes

- Markdown files are imported at build time via Vite's `?raw` query from the shared `docs/` directory
- Dark theme only (no light/dark toggle)
- Runs independently from the main admin UI (`packages/ui`) and Fastify server (`packages/server`)
- Port 2705 avoids conflicts with the admin UI (2703) and API server (2704)
