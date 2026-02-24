# AI Sync

## Overview

**AI Sync** is a centralized management tool for AI configuration files across multiple Git repositories. It solves the problem of maintaining AI-related files (like `CLAUDE.md`, `.cursor/`, `.claude/`, `GEMINI.md`, etc.) that you want to keep locally in each repository without committing them to the remote.

## Problem

Modern development involves using multiple AI coding assistants (Claude Code, Cursor, GitHub Copilot, Gemini, etc.), each requiring configuration files in the repository root. These files:

- Should not be committed to the repository (they're personal/local preferences)
- Need to be maintained across dozens of repositories
- Are tedious to manage manually
- Get lost when re-cloning repositories on a new machine

## Solution

A single-source-of-truth approach:

1. **Central Store**: All AI config files are stored in a user-chosen directory (a separate git repo)
2. **Automatic Sync**: A background service watches for file changes and syncs bidirectionally between the store and target repositories
3. **Web Admin UI**: A local web interface for managing repositories, editing files, resolving conflicts, and monitoring sync status
4. **Portable**: Clone this tool on any machine, point it to your store directory, attach your repositories, and all AI configs sync automatically
5. **Separated data**: App code and user data live in different directories — update the tool without affecting your data

## Architecture

### System Components

```
┌─────────────────────────────────────────────────────────┐
│                    Web Admin UI (React)                 │
│                  http://localhost:2703                  │
└──────────────────────┬──────────────────────────────────┘
                       │ REST API + WebSocket
┌──────────────────────┴──────────────────────────────────┐
│                  Fastify Backend                        │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  REST Routes │  │  Sync Engine │  │  File Watcher │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  SQLite DB   │  │  Git Manager │  │  Conflict Mgr │  │
│  └──────────────┘  └──────────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────┘
            │                                 │
    ┌───────┴───────┐              ┌──────────┴──────────┐
    │     Store     │              │   Target Repos      │
    │ (user chosen) │              │ /path/to/repo-1     │
    └───────────────┘              │ /path/to/repo-2     │
                                   └─────────────────────┘
```

### Data Directory Structure

The data directory is chosen by the user on first launch and stored in `~/.ai-sync/config.json`. It can be overridden with the `DATA_DIR` env var.

```
<data-dir>/                          # Git repo root (user-chosen)
├── .git/
├── .gitignore                       # Ignores .db/
├── .db/
│   └── ai-sync.db                  # SQLite database (git-ignored)
├── repos/
│   ├── _default/                    # Template for new repos
│   │   ├── CLAUDE.md
│   │   └── .cursor/
│   │       └── rules/
│   ├── my-project/                  # One folder per target repo
│   │   ├── CLAUDE.md
│   │   ├── GEMINI.md
│   │   └── .cursor/
│   │       └── rules/
│   │           └── main-rules.mdc
│   └── org--nested-project/         # Nested paths use -- separator
│       ├── CLAUDE.md
│       └── .claude/
│           └── settings.local.json
```

### Sync Algorithm (Git-Based 3-Way Merge)

The sync engine uses a **git-based 3-way merge** approach. The store directory is a git repo, and every successful sync is auto-committed. This gives us three versions of each file:

```
BASE    = last committed version in store git (git show HEAD:<path>)
STORE   = current file on disk in store directory
TARGET  = current file on disk in target repo
```

#### Checksum Fast-Path

Before any git operations, the engine compares current SHA-256 checksums against DB-stored values:

- Both match DB → nothing changed, skip (no git call needed)
- Both are equal to each other → already in sync, update DB, skip

Git is only invoked when files actually differ.

#### 3-Way Comparison

When both files exist and differ, the engine retrieves the base from git and compares:

| Store vs Base | Target vs Base | Action                                              |
| :-----------: | :------------: | --------------------------------------------------- |
|     Same      |      Same      | Nothing changed, skip                               |
|     Same      |   Different    | Only target changed → copy target → store           |
|   Different   |      Same      | Only store changed → copy store → target            |
|   Different   |   Different    | Both changed → attempt `git merge-file` (see below) |

#### Auto-Merge

When both sides changed, `git merge-file --stdout` performs a 3-way merge:

- **Clean merge** (no overlapping changes) → auto-resolve, write result to both sides
- **Conflict** (overlapping changes) → create conflict record with base + merged content (including conflict markers), show in UI for user resolution

#### File Existence Cases

| Store exists | Target exists | Previously synced? | Action                                          |
| :----------: | :-----------: | :----------------: | ----------------------------------------------- |
|     Yes      |      Yes      |         -          | 3-way compare (see above)                       |
|     Yes      |      No       |         No         | Copy store → target (new file)                  |
|     Yes      |      No       |        Yes         | **Conflict** (target was intentionally deleted) |
|      No      |      Yes      |         No         | Copy target → store (new file)                  |
|      No      |      Yes      |        Yes         | **Conflict** (store was intentionally deleted)  |
|      No      |      No       |         -          | Remove tracking entry                           |

After any write to the store, the engine auto-commits so the next sync cycle has the correct base.

> For full details and all 12 edge-case scenarios, see [git-based-sync.md](git-based-sync.md).

### Conflict Resolution

When a conflict is created, users can resolve it via the web UI with these options:

| Resolution  | Action                                               |
| ----------- | ---------------------------------------------------- |
| Keep Store  | Use the store version, overwrite target              |
| Keep Target | Use the target version, overwrite store              |
| Save Manual | Use manually edited content, write to both sides     |
| Delete File | Delete the file from both sides and stop tracking it |

### Supported AI File Patterns

| Pattern                           | Tool            |
| --------------------------------- | --------------- |
| `CLAUDE.md`                       | Claude Code     |
| `.claude/**`                      | Claude Code     |
| `GEMINI.md`                       | Gemini          |
| `.cursor/**`                      | Cursor          |
| `.cursorrules`                    | Cursor (legacy) |
| `.github/copilot-instructions.md` | GitHub Copilot  |
| `.copilot/**`                     | GitHub Copilot  |
| `.aider*`                         | Aider           |
| `.windsurfrules`                  | Windsurf        |

Custom patterns can be added via the settings UI.

## Tech Stack

| Layer           | Technology                 |
| --------------- | -------------------------- |
| Runtime         | Node.js + TypeScript (ESM) |
| Package Manager | pnpm (workspace)           |
| Backend         | Fastify 5                  |
| Frontend        | React 19 + Vite            |
| UI Components   | shadcn/ui + Tailwind CSS 4 |
| Database        | better-sqlite3             |
| File Watching   | chokidar 5                 |
| WebSocket       | @fastify/websocket         |
| Git Operations  | simple-git                 |
| Code Editor     | CodeMirror 6               |

## Getting Started

### Prerequisites

- Node.js 22+
- pnpm 10+

### Installation

```bash
git clone <repo-url>
cd ai-sync
pnpm install
pnpm build
```

### Running

```bash
# Production
pnpm start

# Development (with hot reload)
pnpm dev

# Override data directory
DATA_DIR=/path/to/data pnpm start
```

Open http://localhost:2703 in your browser.

### Usage

1. **First-run setup**: On first launch, choose a directory for your data store
2. **Add a repository**: Click "Add Repository" and provide the local path to a git repository
3. **Automatic scanning**: The tool scans for existing AI config files and imports them to the store
4. **Gitignore management**: The tool automatically updates the target repo's `.gitignore` to exclude AI files and runs `git rm --cached` to remove them from git tracking
5. **Live sync**: Changes to AI files in either location are automatically synced
6. **Conflict resolution**: When both sides change, the UI shows a conflict for manual resolution
7. **Edit files**: Use the built-in editor to modify AI config files directly

### How It Works

#### File Detection

Files are detected through two mechanisms:

1. **Real-time watchers** (chokidar): Monitor both the store and all target repos for `add`, `change`, and `unlink` events on files matching the configured patterns.
2. **Periodic polling** (every 5s by default): Scans both target repos and store folders for new files that watchers might have missed (e.g., files added while the app was offline).

#### Sync Flow (Git-Based 3-Way Merge)

When a file change is detected:

1. **Checksum fast-path** → Compare SHA-256 checksums; if both sides match DB or each other, skip (no git needed)
2. **New file (one side only)** → Copy to the other side, create tracked entry
3. **Both files exist and differ** → Get base from `git show HEAD:<path>`, then:
   - Only store changed → copy store → target
   - Only target changed → copy target → store
   - Both changed → `git merge-file` 3-way merge
     - Clean merge (no overlap) → auto-resolve, write to both sides
     - Conflict (overlapping edits) → create conflict record for user resolution
4. **File deleted on one side** (previously synced) → Create a delete-vs-exists conflict
5. **File deleted on both sides** → Remove the tracked entry entirely
6. **Commit store** → Auto-commit after any store write so the next cycle has the correct base

#### Conflict Scenarios

Conflicts are created in three cases:

- **Overlapping edits**: Both store and target changed the same lines — `git merge-file` produces conflict markers, user resolves in UI (pre-filled with merge result)
- **Delete vs. modify**: One side deleted a previously-synced file while the other still has it — user decides whether to keep the file or delete it from both sides
- **Resolution options**: Keep Store, Keep Target, Save Manual (custom edit), or Delete File (remove from both sides and stop tracking)

Non-overlapping edits from both sides are **auto-merged** without user intervention.

#### Sync Loop Prevention

When the sync engine writes a file, it marks the path as a "self-change" with a TTL. The file watcher checks this set and skips events for paths recently written by sync, preventing infinite loops.

### Setting Up on a New Machine

1. Clone this tool repository
2. Run `pnpm install && pnpm build && pnpm start`
3. On the setup screen, point to your existing data directory (clone your store repo first)
4. Attach your locally-cloned repos via the UI — files sync automatically

## API Reference

### Setup

- `GET /api/setup/status` - Check if app is configured
- `POST /api/setup` - Initialize data directory (first-run)

### Repos

- `GET /api/repos` - List all registered repos
- `POST /api/repos` - Register a new repo
- `PUT /api/repos/:id` - Update repo settings
- `DELETE /api/repos/:id` - Unregister a repo
- `POST /api/repos/:id/sync` - Force sync
- `POST /api/repos/:id/scan` - Re-scan for AI files

### Files

- `GET /api/repos/:id/files` - List tracked files
- `GET /api/repos/:id/files/*path` - Get file content
- `PUT /api/repos/:id/files/*path` - Update file
- `POST /api/repos/:id/files/*path` - Create file
- `DELETE /api/repos/:id/files/*path` - Delete file

### Conflicts

- `GET /api/conflicts` - List pending conflicts
- `GET /api/conflicts/:id` - Get conflict detail
- `POST /api/conflicts/:id/resolve` - Resolve a conflict

### Settings

- `GET /api/settings` - Get all settings
- `PUT /api/settings` - Update settings
- `GET /api/patterns` - Get file patterns
- `PUT /api/patterns` - Update file patterns

### WebSocket

- `ws://localhost:2703/ws` - Real-time sync events (proxied to :2704 in dev)

## Project Structure

```
ai-sync/
├── packages/
│   ├── server/         # Fastify backend + sync engine
│   └── ui/             # React SPA with shadcn/ui
└── dev-docs/           # Documentation for development
└── docs/               # Documentation for the project

# User data lives externally (path in ~/.ai-sync/config.json)
```
