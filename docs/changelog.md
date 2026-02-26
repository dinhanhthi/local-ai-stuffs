# Changelog

## v0.2.4

- **feat**: Hide paused cards toggle (persisted in settings)
- **feat**: Landing page in dev mode with syntax highlighting
- **improve**: Settings UX with dirty-state tracking
- **improve**: Clearer conflict resolution labels
- **fix**: Landing page routing with Vercel

## v0.2.3

- **fix**: Critical bug: bad conflict handling after `git pull` auto-merges

## v0.2.2

- **fix**: Post-pull sync using wrong base: after git pull, the sync engine now uses the pre-pull commit as the merge base, correctly detecting remote vs local changes instead of always keeping local

## v0.2.1

- **fix**: Handle store config conflicts during git pull
- **feat**: Add OG meta tags and image for social sharing
- **fix**: Landing page click install navigation

## v0.2.0

- **refactor**: Unify dev and prod port to 2703: Vite dev server now runs on port 2703 (was 5173), Fastify dev server moves to port 2704 as internal API backend
- **feat**: Add cross-machine settings sync: all settings, file patterns, ignore patterns, and per-repo/service overrides are now persisted in a git-tracked `sync-settings.json` file. Settings are automatically restored on new machines when you clone the store
- **feat**: Add cross-machine service linking: unlinked services now appear on the dashboard with Link/Delete/Auto-link actions, matching existing repo linking behavior. Store custom service metadata in single `services/services.json`
- **feat**: Add landing page with documentation and installation instructions
- **feat**: Ask user before modifying `.gitignore` when adding a new repo (opt-in checkbox in Add Repository dialog)
- **feat**: Add setting to control file tree default expand/collapse when opening a repo or service (collapsed by default)
- **feat**: Add "Pull" changes from the remote.

## v0.1.4

- **fix**: Size color thresholds ignoring user settings (was using hardcoded values instead of configured thresholds)
- **fix**: Store size calculation scanning entire directory instead of tracked files only, causing heavy I/O and log spam
- **fix**: Inflated service store size on dashboard
- **chore**: Remove `projects/**` from default sync patterns
- **chore**: Auto-add `.db/` and `.DS_Store` to store `.gitignore` on startup
- **improve**: Settings page: reorganize action buttons, add post-save prompts, show "user" badge on custom patterns
- **feat**: Add per-repo "Clean files" action with scoped options (target only, store only, both)
- **improve**: Prompt user before applying `.gitignore` changes instead of auto-applying
- **docs**: Update docs

## v0.1.3

- **chore**: Update logo

## v0.1.2

- **fix**: Multiple memory leaks in sync engine, WebSocket client, and sync log pruning

## v0.1.1

- **fix**: Excessive git commits on startup

## v0.1.0

- **feat**: Add desktop notifications for new conflicts with per-file deduplication
- **feat**: Add notification toggle in Settings

## v0.0.4

- **fix**: Conflict filter

## v0.0.3

- **fix**: "Sync All" and "Pause/Resume All" to include AI services

## v0.0.2

- **feat**: Add built-in service definitions for Gemini, Agents, OpenCode, Codex, and Cursor

## v0.0.1

- **feat**: Central git-based store with bidirectional 3-way merge sync
- **feat**: Web Admin UI with editor, conflict resolver, and templates
- **feat**: AI service config sync with custom service management
- **feat**: Multi-machine support
- **feat**: Per-repo settings, ignore patterns, file patterns, `.gitignore` management
- **feat**: File tree with search, context menu, file size indicators
- **feat**: Clone files/folders across repos
- **feat**: Store size display with warnings
- **feat**: Update notification from GitHub Releases
- **feat**: Security hardening
