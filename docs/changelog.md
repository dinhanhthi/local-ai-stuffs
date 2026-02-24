# Changelog

## v0.2.0

- Unify dev and prod port to 2703: Vite dev server now runs on port 2703 (was 5173), Fastify dev server moves to port 2704 as internal API backend
- Add cross-machine settings sync: all settings, file patterns, ignore patterns, and per-repo/service overrides are now persisted in a git-tracked `sync-settings.json` file. Settings are automatically restored on new machines when you clone the store
- Add cross-machine service linking: unlinked services now appear on the dashboard with Link/Delete/Auto-link actions, matching existing repo linking behavior. Store custom service metadata in single `services/services.json`
- Add landing page with documentation and installation instructions
- Ask user before modifying `.gitignore` when adding a new repo (opt-in checkbox in Add Repository dialog)
- Add setting to control file tree default expand/collapse when opening a repo or service (collapsed by default)

## v0.1.4

- Fix size color thresholds ignoring user settings (was using hardcoded values instead of configured thresholds)
- Fix store size calculation scanning entire directory instead of tracked files only, causing heavy I/O and log spam
- Fix inflated service store size on dashboard
- Remove `projects/**` from default sync patterns
- Auto-add `.db/` and `.DS_Store` to store `.gitignore` on startup
- Improve settings page: reorganize action buttons, add post-save prompts, show "user" badge on custom patterns
- Add per-repo "Clean files" action with scoped options (target only, store only, both)
- Prompt user before applying `.gitignore` changes instead of auto-applying
- Update docs

## v0.1.3

- Update logo

## v0.1.2

- Fix multiple memory leaks in sync engine, WebSocket client, and sync log pruning

## v0.1.1

- Fix excessive git commits on startup

## v0.1.0

- Add desktop notifications for new conflicts with per-file deduplication
- Add notification toggle in Settings

## v0.0.4

- Fix conflict filter

## v0.0.3

- Fix "Sync All" and "Pause/Resume All" to include AI services

## v0.0.2

- Add built-in service definitions for Gemini, Agents, OpenCode, Codex, and Cursor

## v0.0.1

- Central git-based store with bidirectional 3-way merge sync
- Web Admin UI with editor, conflict resolver, and templates
- AI service config sync with custom service management
- Multi-machine support
- Per-repo settings, ignore patterns, file patterns, `.gitignore` management
- File tree with search, context menu, file size indicators
- Clone files/folders across repos
- Store size display with warnings
- Update notification from GitHub Releases
- Security hardening
