# Introduction

**AI Sync** is a centralized management tool for AI configuration files across multiple Git repositories and local AI services. It provides bidirectional sync between a central store and your target repositories or service directories, with a web admin UI for easy management.

## The Problem

Modern development involves using multiple AI coding assistants — Claude Code, Cursor, GitHub Copilot, Gemini, and more. Each requires configuration files in the repository root:

- `CLAUDE.md` for Claude Code
- `.cursor/` directory for Cursor
- `GEMINI.md` for Gemini
- `.github/copilot-instructions.md` for GitHub Copilot
- `.agents/**` for Agents and many more...

These files:

- **Should not be committed** to the repository (they're personal/local preferences) or you just want to keep them private.
- **Need to be maintained** across dozens of repositories
- **Are tedious** to manage manually
- **Get lost** when re-cloning repositories on a new machine

Additionally, AI tools like Claude Code store global configurations in local directories (e.g., `~/.claude/`) including custom commands, project settings, and scripts. These local service configs are equally important to back up and sync across machines.

## The Solution

AI Sync provides a single-source-of-truth approach:

1. **Central Store** — All AI config files are stored in a user-chosen directory (a separate git repo)
2. **Automatic Sync** — A background service watches for file changes and syncs bidirectionally between the store and target repositories
3. **AI Service Configs** — Sync local AI service settings (e.g., `~/.claude/` for Claude Code) with predefined file patterns — no manual path browsing needed
4. **Multi-Machine Support** — Each machine gets a unique identity. Git-tracked files (`machines.json` for path mappings, `sync-settings.json` for shared settings) ensure the same store works across machines with different directory structures. Repos are auto-linked on startup, and all settings/patterns/overrides are automatically restored
5. **Web Admin UI** — A local web interface for managing repositories, editing files, resolving conflicts, and monitoring sync status
6. **Portable** — Clone this tool on any machine, point it to your store directory, and repos/services with known paths are auto-linked. Unlinked items can be manually linked via the dashboard
7. **Separated Data** — App code and user data live in different directories — update the tool without affecting your data
8. **Symbolic Link Support** — Symlinks are properly detected, tracked, and synced between store and target repositories
9. **Tracking Patterns** — Configurable glob patterns define which files AI Sync should watch and sync (e.g., `CLAUDE.md`, `.claude/**`). You can optionally apply these patterns to each target repo's `.gitignore` and untrack matching files from git. This ensures AI configuration files are managed exclusively by AI Sync and remain hidden from the target repository's version control — keeping your AI tooling private and separate from your project code.
10. **Ignore Patterns** — Configurable glob patterns to exclude unwanted files (e.g., `.DS_Store`, `node_modules/**`) from AI Sync's internal tracking.

## How Sync Works

The sync engine uses a **git-based 3-way merge** — the same algorithm that powers `git merge`. The central store is a git repo, and every successful sync is auto-committed. This gives three versions of each file:

- **Base** — the last committed version in the store git repo (`git show HEAD:<path>`)
- **Store** — the current file on disk in the store directory
- **Target** — the current file on disk in the target repo

By comparing Store and Target against Base:

| Store vs Base | Target vs Base | What happens                                |
| :-----------: | :------------: | ------------------------------------------- |
|     Same      |      Same      | Nothing changed, skip                       |
|     Same      |   Different    | Only target changed → copy target → store   |
|   Different   |      Same      | Only store changed → copy store → target    |
|   Different   |   Different    | Both changed → `git merge-file` 3-way merge |

When both sides changed:

- **Non-overlapping changes** are auto-merged — no user intervention needed
- **Overlapping changes** create a conflict with a pre-filled merge result for easy resolution

A checksum fast-path ensures git is only invoked when files actually differ, keeping the common case fast.

## Multi-Machine Support

When multiple machines share the same store repository (data directory) via git, each machine may have different absolute paths for the same repository (e.g., `/Users/thi/git/project` on a Mac vs `/home/thi/code/project` on Linux).

AI Sync handles this with:

- **Machine Identity** — Each machine gets a unique UUID and a human-readable name (defaults to hostname), stored in the local config (`~/.ai-sync/config.json`)
- **`machines.json`** — A git-tracked file in the store repo that maps each repo/service to each machine's local path. All machines see each other's mappings through git sync
- **`sync-settings.json`** — A git-tracked file that stores all shared settings: global settings, file patterns, ignore patterns, and per-repo/service overrides. On startup, settings are restored from this file so customizations carry over to new machines automatically
- **Auto-linking** — On startup, if the store contains repos or services with known paths for the current machine, they are automatically registered in the local database and start syncing. Built-in services also try the platform default path (e.g., `~/.claude/`) when no explicit mapping exists. Per-repo/service settings overrides are applied as items are linked
- **Unlinked items** — The dashboard shows store repos and services that exist but aren't linked on the current machine, with options to link manually, auto-link, or delete from the store
- **Machine settings** — View and edit the machine name, see the machine ID, and list all known machines in the Settings page

## Local Database

AI Sync uses a **SQLite database** (`<data-dir>/.db/ai-sync.db`) to track runtime state on each machine. The database is **not synced** between machines — it is git-ignored (`.db/` in the store's `.gitignore`) because much of its contents are machine-specific (local paths, checksums, sync status).

However, **settings and patterns are synced** via the git-tracked `sync-settings.json` file. The database acts as a local cache — on each startup, it is hydrated from `sync-settings.json` so all customizations carry over to new machines.

What the database stores:

| Table              | Purpose                                                                | Synced via `sync-settings.json`? |
| ------------------ | ---------------------------------------------------------------------- | -------------------------------- |
| `repos`            | Registered repositories with local paths (different per machine)       | No (machine-specific)            |
| `service_configs`  | Registered AI service configs with local paths                         | No (machine-specific)            |
| `tracked_files`    | Every synced file with checksums, mtimes, and sync status              | No (machine-specific)            |
| `conflicts`        | Pending conflicts with store/target/base/merged content for resolution | No (machine-specific)            |
| `file_patterns`    | Glob patterns that detect AI config files                              | Yes                              |
| `ignore_patterns`  | Glob patterns to exclude files from sync                               | Yes                              |
| `settings`         | App configuration (sync interval, auto-commit, etc.)                   | Yes                              |
| `repo_settings`    | Per-repo overrides for patterns and ignore rules                       | Yes (keyed by store path)        |
| `service_settings` | Per-service overrides for patterns and ignore rules                    | Yes (keyed by store path)        |
| `sync_log`         | Event history for debugging (auto-pruned after 30 days)                | No (machine-specific)            |

The database is created automatically on first startup. Settings and patterns are restored from `sync-settings.json` on each startup. The actual AI config files live in the git-tracked store.

## Architecture Overview

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
            │                    │                │
    ┌───────┴───────┐  ┌───-─────┴───────┐  ┌──-──┴───────────┐
    │     Store     │  │  Target Repos   │  │  AI Services    │
    │ (user chosen) │  │ /path/to/repo-1 │  │ ~/.claude/      │
    └───────────────┘  │ /path/to/repo-2 │  │ (Claude Code)   │
                       └─────────────────┘  └─────────────────┘
```

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

## Supported AI File Patterns

| Pattern                           | Tool            |
| --------------------------------- | --------------- |
| `CLAUDE.md`                       | Claude Code     |
| `.claude/**`                      | Claude Code     |
| `GEMINI.md`                       | Gemini          |
| `.gemini/**`                      | Gemini          |
| `.cursor/**`                      | Cursor          |
| `.cursorrules`                    | Cursor (legacy) |
| `.github/copilot-instructions.md` | GitHub Copilot  |
| `.copilot/**`                     | GitHub Copilot  |
| `.github/skills/**`               | GitHub Skills   |
| `.aider*`                         | Aider           |
| `.windsurfrules`                  | Windsurf        |
| `.agent/**`                       | Agent           |
| `.agents/**`                      | Agents          |
| `.opencode/**`                    | OpenCode        |

Custom patterns can be added via the Settings page.

## Supported AI Services

In addition to per-repository AI config files, AI Sync can sync local AI service configurations. These are global settings directories that live outside of any git repository.

| Service     | Local Path            | Synced Patterns                                                                                          |
| ----------- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| Claude Code | `~/.claude/`          | `CLAUDE.md`, `commands/**`, `plugins/installed_plugins.json`, `scripts/**`, `settings.json`, `skills/**` |
| Gemini      | `~/.gemini/`          | `GEMINI.md`, `settings.json`, `skills/**`                                                                |
| Agents      | `~/.agents/`          | `skills/**`                                                                                              |
| OpenCode    | `~/.config/opencode/` | `skills/**`                                                                                              |
| Cursor      | `~/.cursor/`          | `mcp.json`, `skills/**`                                                                                  |
| Codex       | `~/.codex/`           | `skills/**`                                                                                              |

Service configs are stored separately in the data directory under `services/<service-type>/` and use their own predefined file patterns (not the global AI File Patterns from Settings). Gitignore management is skipped since these directories are not git repositories.
