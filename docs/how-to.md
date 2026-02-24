# How to Use ?

This guide walks you through the complete workflow of using AI Sync, from initial setup to daily usage.

## Prerequisites

- **Node.js** 22 or later
- **pnpm** 10 or later
- **Git** installed and configured

## Installation

```bash
git clone <repo-url>
cd ai-sync
pnpm install
pnpm build
```

## Start the Server

```bash
# Production mode
pnpm start

# Development mode (with hot reload)
pnpm dev

# Override data directory via environment variable
DATA_DIR=/path/to/data pnpm start
```

Then open [http://localhost:2703](http://localhost:2703) in your browser.

On startup, the server automatically creates a SQLite database at `<data-dir>/.db/ai-sync.db` if it doesn't already exist. This database stores all app state — repos, tracked files, sync logs, settings, and conflict records. The `.db/` directory is git-ignored, so the database stays local to each machine.

## First-Run Setup

On your first launch, the app will show a setup screen:

1. **Choose a data directory** — This is where your AI config files will be centrally stored. It will be initialized as a git repository.
2. Click **Initialize** to complete the setup.

> **Tip**: If you already have a store repo from another machine, clone it first, then point the setup to that directory.

## Adding Repositories

1. On the **Dashboard**, click the **Add Repository** button.
2. Enter the local path to a git repository on your machine.
3. The tool will:
   - Scan for existing AI config files in the repository
   - Import found files into the central store
   - Update the repo's `.gitignore` to exclude AI files
   - Run `git rm --cached` to remove tracked AI files from git history

## Adding AI Services

Beyond per-repository config files, AI Sync can also sync local AI service configurations (e.g., `~/.claude/` for Claude Code).

1. On the **Dashboard**, find the **AI Services** section and click **Add Service**.
2. The dialog shows available services with auto-detection — if the service directory exists on your machine, it shows as "Detected".
3. Click **Add** next to the service you want to sync.
4. The tool will:
   - Scan the service directory for matching files using predefined patterns (e.g., `commands/**`, `projects/**`, `CLAUDE.md`, `settings.json`, `scripts/**` for Claude Code)
   - Copy found files to the central store under `services/<service-type>/`
   - Start watching for changes in both directions
   - Skip `.gitignore` management (service directories are not git repos)

Click on a service card to open its **detail page** — it works the same as a repository detail page with file tree, editor, conflict resolver, sync/scan/pause/resume controls.

### Customizing Service Patterns

Each service comes with predefined file patterns, but you can customize them per service:

1. Open the service detail page and click the **gear icon** (Settings).
2. **Toggle off** default patterns you don't want to sync (e.g., disable `projects/**` if you don't need it).
3. **Add custom patterns** to include additional files or folders.
4. Click **Save** — the watcher restarts automatically with the new patterns.

## Editing Files

Click on a repository or service card to open its **Detail** view:

- The **left sidebar** shows a file tree of all tracked AI config files
- The **right panel** is a code editor (CodeMirror 6) where you can edit files
- Changes are saved to the store and automatically synced to the target repo or service directory

## Resolving Conflicts

Conflicts occur when both the store and a target (repository or service directory) modify the same file. The app uses **git 3-way merge** to handle this:

- **Non-overlapping changes** are auto-merged (no user intervention needed)
- **Overlapping changes** create a conflict that requires manual resolution

When a conflict is detected, there are:

- **Base** — the last synced version
- **Store** version
- **Target** version
- **Merged** result (pre-filled by git merge)

You can choose to keep the store version, the target version, or the merged result, just like when you handle the conflicts in git.

## Cloning Files to Other Repos

You can copy files or folders from one repository to others directly from the file tree:

1. **Hover** over a file or folder in the tree sidebar — a small **copy icon** appears on the right.
2. **Click** the icon to open the clone dialog.
3. **Select target repositories** — pick one or more repos to clone into, then click **Next**.
4. **Review the preview** — each file is shown as "New" (will be created), "Same" (already identical, skipped), or "Conflict" (different content exists).
5. **Resolve conflicts** — expand a conflict to see a side-by-side diff (Source vs Existing), then choose **Overwrite**, **Keep existing**, or **Manual edit**.
6. Click **Clone** to apply all changes. The cloned files sync to the target repos automatically.

> **Tip**: Cloning a folder clones all tracked files inside it recursively.

## Managing Templates

The **Templates** page lets you define default AI config files for new repositories. When you add a new repository, these templates will be applied automatically. The structure of the files will be the same as the templates.

## Configuring Settings

All settings changes are automatically saved to a git-tracked `sync-settings.json` file in the store, so they sync across machines when you push/pull the store repository.

The **Settings** page has four tabs:

- **General** — Sync interval, watch debounce, auto sync, and auto-commit options
- **AI File Patterns** — Glob patterns that detect AI config files (add, remove, or toggle). Use **Apply to repos** to add these patterns to each target repo's `.gitignore` and untrack matching files from git. After saving pattern changes, you'll be prompted to apply them to repos automatically
- **Ignore Patterns** — Glob patterns to exclude files from sync (e.g., `.DS_Store`, `node_modules/**`). These patterns only affect AI Sync's internal tracking — they do **not** modify `.gitignore` files in target repos. Use **Clean files** to remove already-tracked files that match ignore patterns from both the store and target locations. After saving pattern changes, you'll be prompted to clean matching files automatically
- **Machine** — View/edit machine name, copy machine ID, and see all known machines that share this store

### Per-Repository Settings

Click the **gear icon** on any repo card to override global settings for that specific repository. Each item shows a `global` or `local` badge — local overrides take precedence, and unmodified settings automatically follow global changes.

### File Tree Context Menu

Right-click any file or folder in the tree sidebar to access quick actions:

#### Untrack file / Untrack folder

Stops syncing a file or folder **without deleting** it from the target repo:

1. **Right-click** a file or folder and select **Untrack file** or **Untrack folder**.
2. The pattern (e.g., `.cursor/**` for a folder) is saved as a **local** override for that specific repo or service — it won't affect other repos.
3. Matching files are removed from the **store only** — the original files in the target repo or service directory are left untouched.
4. The file watcher restarts automatically to stop tracking the ignored paths going forward.

Use this when you want to exclude files from sync but keep them in your project.

#### Delete from both sides

Permanently removes a file or folder from **both** the store and the target repo:

1. **Right-click** a file or folder and select **Delete from both sides**.
2. A confirmation dialog appears — this action **cannot be undone**.
3. On confirm, the files are deleted from both the central store and the target repo or service directory, and their tracking records are removed from the database.

Use this when you want to completely get rid of files from both sides. Unlike Untrack, no ignore pattern is added — if the file is recreated later, it will be picked up by the watcher again.

#### Quick comparison

|                          | **Untrack**                         | **Delete from both sides** |
| ------------------------ | ----------------------------------- | -------------------------- |
| Removes from store       | Yes                                 | Yes                        |
| Removes from target repo | No                                  | Yes                        |
| Adds ignore pattern      | Yes (local)                         | No                         |
| Confirmation required    | No                                  | Yes                        |
| Reversible               | Yes — remove the pattern to re-sync | No                         |

These patterns are persisted in the local SQLite database and also in the git-tracked `sync-settings.json` file, so they carry over to other machines automatically when you clone the store.

## Pushing Changes to Remote

If your data directory is connected to a remote git repository, use the **Push changes** button in the footer to push your store to the remote. This backs up your AI configs and makes them available on other machines

## Setting Up on a New Machine

1. Clone this tool repository then run `pnpm install && pnpm build && pnpm start`, the app will start at [http://localhost:2703](http://localhost:2703) in your browser.
2. Clone your store repository (data directory)
3. On the setup screen, point to the cloned store directory
4. The app will automatically:
   - Assign a unique machine ID and name (based on hostname)
   - Restore all shared settings from `sync-settings.json` (global settings, file patterns, ignore patterns, per-repo/service overrides)
   - Register this machine in `machines.json`
   - Auto-link any repos and services that have known paths for this machine
   - Apply per-repo/service settings overrides as repos and services are linked
5. Items that couldn't be auto-linked will appear as **Unlinked Services** and **Unlinked Repositories** on the dashboard — click **Link** to map them to local paths, or **Auto-link All** if paths are already mapped from another machine
6. To remove an unlinked item you no longer need, click the **trash icon** on its card to delete it from the store

## Multi-Machine Workflow

AI Sync supports using the same store across multiple machines, even when repos live at different paths on each machine.

### How It Works

- Each machine gets a **unique ID** (UUID) and a **name** (defaults to your hostname), stored locally in `~/.ai-sync/config.json`
- A **`machines.json`** file in the store repo tracks which machine has which repo at which local path
- When you add a repo on Machine A, the path mapping is saved in `machines.json`. When Machine B pulls the store, it can use that mapping to auto-link or manually link the repo

### Managing Unlinked Items

When the store contains repos or services that aren't linked on the current machine, they appear in the **Unlinked Services** and **Unlinked Repositories** sections on the dashboard:

- **Auto-link All** — Automatically link all items that have a valid path mapping for this machine. For built-in services (Claude Code, Gemini, etc.), auto-link also tries the platform default path (e.g., `~/.claude/`) when no explicit mapping exists
- **Link** — Manually specify the local path for a specific repo or service. For services, the dialog pre-fills the path from the previously recorded path or the platform default
- **Delete** — Remove the item from the store entirely (trash icon on each card)

Services work slightly differently from repos during linking:

- Built-in services (Claude Code, Gemini, Cursor, etc.) have a known default path per platform — the link dialog pre-fills this path automatically
- Custom services store their metadata (name, patterns) in `services/services.json` in the store, so they can be linked on another machine without reconfiguring patterns

### Machine Settings

Go to **Settings → Machine** to:

- **Edit machine name** — Change the display name for this machine
- **View machine ID** — Copy the unique identifier for debugging
- **See all machines** — List every machine that has ever connected to this store, with last-seen dates

## Keyboard Shortcuts

| Shortcut       | Action            |
| -------------- | ----------------- |
| `Ctrl/Cmd + S` | Save current file |

## Symbolic Links

The tool supports symbolic links in your repositories:

- Symlinks are automatically detected and tracked with their file type preserved
- They sync correctly between the store and target repositories
- Both file symlinks and folder symlinks are supported

## Tips

- **Pause sync** for a repo or service when doing major refactoring to avoid noise
- **Use templates** to ensure consistent AI config across all projects
- The tool **auto-manages .gitignore** — you don't need to manually exclude AI files (for repositories; services skip this since they're not git repos)
- **Use ignore patterns** to keep unwanted files out of sync (configured in Settings)
- **Add AI services** to sync your local AI tool settings (e.g., Claude Code custom commands) across machines
