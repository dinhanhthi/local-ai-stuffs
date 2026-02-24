# AI Sync

<p align="center">
  <img src="assets/logo.svg" alt="AI Sync Logo" width="100" />
</p>

Centralized management tool for AI configuration files (`CLAUDE.md`, `.cursor/`, `GEMINI.md`, `.github/copilot-instructions.md`, etc.) across Git repositories and local AI services. Keep files synced across all your repos, and sync local AI service configs (e.g., `~/.claude/` for Claude Code) — all without committing them.

> [!WARNING]  
> This repository is in heavy development, use at your own risk.

## How it works

- A **central store** (a separate git repo you choose) holds all AI config files, organized by repository and service
- A **sync engine** watches for changes on both sides and syncs automatically using **git 3-way merge** — non-conflicting changes are auto-merged
- **AI service configs** (e.g., Claude Code's `~/.claude/`) can be synced with predefined file patterns — no manual path browsing needed
- **Multi-machine support** — each machine gets a unique identity; a git-tracked `machines.json` maps repo paths per machine, and `sync-settings.json` carries all shared settings across machines automatically. Repos are auto-linked on startup
- A **web UI** lets you manage repos, services, edit files, and resolve conflicts
- AI files are automatically **git-ignored** and **removed from git tracking** in target repos
- **App code and user data are fully separated** — update the tool without affecting your data

## Quick Start

**Prerequisites:** Node.js 22+, pnpm 10+

```bash
# Install
pnpm install

# Build
pnpm build

# Run (production)
pnpm start
```

Open http://localhost:2703

## Usage

1. On first launch, the UI shows a **setup screen** — pick a directory for your data store
2. This directory becomes a Git repo containing all your AI config files
3. Click **Add Repository** to register a local git repo — optionally apply the default template and update `.gitignore`
4. The tool scans for AI config files, copies them to the store, and starts syncing
5. AI files are added to the target repo's `.gitignore` and removed from git tracking
6. Click **Add Service** to sync local AI service configs (e.g., Claude Code) — the tool auto-detects installed services and uses predefined file patterns
7. Edit files in the UI or directly in the repo/service directory — changes sync both ways
8. Conflicts (both sides changed) appear in the detail page for resolution
9. Use **Push/Pull** buttons in the footer to sync the store with a remote git repository

### Data directory structure

```
<your-data-dir>/              # Git repo (you chose this path)
├── machines.json             # Machine-to-path mappings (git-tracked)
├── repos/
│   ├── _default/             # Template for new repos
│   ├── my-project/           # AI files for my-project
│   └── another-project/      # AI files for another-project
├── services/
│   └── claude-code/          # Claude Code config files
└── .db/
    └── ai-sync.db           # SQLite database (git-ignored)
```

### Override data directory

```bash
DATA_DIR=/path/to/data pnpm start
```

## Setting up on a new machine

```bash
git clone <this-repo-url>
cd ai-sync
pnpm install && pnpm build && pnpm start
```

On the setup screen, point to your existing data directory (clone your store repo first if needed).

The app will automatically:

- Assign a unique machine ID and name (based on hostname)
- Restore all shared settings from `sync-settings.json`
- Auto-link repos and services that have known paths for this machine

Items that couldn't be auto-linked appear as **Unlinked Repositories** / **Unlinked Services** on the dashboard — click **Link** to map them to local paths, **Auto-link All** to link everything at once, or the **trash icon** to remove items you no longer need.

## Development

```bash
# Start both server and UI with hot reload
pnpm dev # open http://localhost:2703

# Or run them separately
pnpm dev:server   # Fastify on :2704
pnpm dev:ui       # Vite on :2703 (proxies API to :2704)
pnpm dev:landing  # Landing page on :2705

# Test
pnpm test         # Run all tests

# Format & lint
pnpm format       # Format all code with Prettier
pnpm format:check # Check formatting without writing
pnpm lint         # Run ESLint on all packages
pnpm lint:fix     # Auto-fix ESLint issues
```

### Reset to fresh state

To return to the initial setup screen (e.g. to pick a different data directory):

- **Via the UI**: Click the **Change** button next to the data directory path on the Dashboard
- **Via the command line**:

  ```bash
  rm ~/.ai-sync/config.json
  ```

This only removes the pointer to your data directory — it does **not** delete your data files.

To fully wipe everything (data directory + config):

```bash
rm ~/.ai-sync/config.json
rm -rf /path/to/your/data-dir   # the directory you chose during setup
```

## Tech Stack

| Layer    | Technology                                                  |
| -------- | ----------------------------------------------------------- |
| Backend  | Fastify 5, TypeScript, better-sqlite3, chokidar, simple-git |
| Frontend | React 19, Vite, shadcn/ui, Tailwind CSS, CodeMirror 6       |
| Monorepo | pnpm workspace (`packages/server` + `packages/ui`)          |

## Project Structure

```
├── packages/server/    # Fastify backend + sync engine
├── packages/ui/        # React SPA
├── dev-docs/           # Documentation for development
└── docs/               # Documentation for the project
```

User data is stored externally in the directory you choose during setup (config saved at `~/.ai-sync/config.json`).

See [docs/documentation.md](docs/documentation.md) for the full documentation.

## License

[MIT](LICENSE)
