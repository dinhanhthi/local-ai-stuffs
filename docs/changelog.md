# Changelog

## v0.1.4

- Fix dashboard showing inflated service store size by calculating from tracked files only instead of scanning entire directory
- Remove `projects/**` from Claude Code default sync patterns (too large, machine-specific)
- Ensure `.db/` and `.DS_Store` are always present in store `.gitignore` on startup
- Update docs with database details, quick ignore instructions, and all supported services
- Move "Apply .gitignore" button from General tab to AI File Patterns tab with clearer naming
- Add post-save modals to prompt users to apply/clean patterns after saving changes
- Reorganize Clean button in Ignore Patterns tab with 3-action dialog (target only, store only, both)
- Add scope parameter to ignore pattern clean API for selective file removal
- Clarify documentation on Ignore Patterns vs AI File Patterns functionality
- Stop auto-applying .gitignore when saving file patterns — prompt user to confirm instead
- Apply same "Apply to repo" button and post-save prompt to per-repo settings dialog
- Show "user" badge on custom-added patterns in global Settings to distinguish from defaults, with user patterns sorted to the top

## v0.1.3

- Update logo: white curves on gradient background, increased curve width
- Replace inline Logo component with static SVG asset (`/logo.svg`)

## v0.1.2

- Fix memory leak: `sync_log` table growing unbounded — add periodic pruning of entries older than 30 days
- Fix memory leak: WebSocket client `connect()` not clearing pending reconnect timer, causing duplicate connections
- Fix memory leak: `SyncEngine.stop()` not removing event listeners, clearing `wsClients`, or clearing `ignoreMatcherCache`
- Fix memory leak: debounce timers not cleaned up when individual repo/service watchers are stopped

## v0.1.1

- Fix excessive git commits in data repo on every server startup (only `lastSeen` timestamp change in `machines.json`)

## v0.1.0

- Add desktop notifications (macOS, Windows, Linux) when new conflicts are detected
- Notifications are deduplicated per tracked file — only new conflicts trigger a notification
- Add toggle in Settings > General to enable/disable desktop notifications

## v0.0.4

- Fix conflict filter not showing repos/services that have conflicts, and not filtering services at all

## v0.0.3

- Fix "Sync All" and "Pause/Resume All" buttons to also affect AI services, not just repositories

## v0.0.2

- Add built-in service definitions for Gemini (`~/.gemini`), Agents (`~/.agents`), OpenCode (`~/.config/opencode`), Codex (`~/.codex`), and Cursor (`~/.cursor`)

## v0.0.1

- Central store as a git repo for AI config files with bidirectional sync using git-based 3-way merge
- Web Admin UI with CodeMirror editor, conflict resolver, and template system
- AI Service Config sync (e.g., `~/.claude/` for Claude Code) with custom service management
- Multi-machine support with `machines.json` for cross-machine sync
- Per-repository settings, ignore patterns, file pattern management, and `.gitignore` management
- File tree with search, right-click actions (delete, ignore), file size indicators
- Clone files/folders across repos with conflict preview
- Store size display with warning indicators and sync blocking threshold
- Update notification from GitHub Releases
- Security hardening: path traversal protection, CORS/host lockdown, symlink validation
- Supported: Claude Code, Cursor, Gemini, GitHub Copilot, Aider, Windsurf
