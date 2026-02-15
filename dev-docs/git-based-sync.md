# Git-Based 3-Way Merge Sync

## Problem

The app syncs AI config files between a central **store** (a git repo) and multiple **target repos**. The naive approach — comparing checksums and mtimes to detect "which side changed" — is fragile:

- When sync engine copies store → target, the target file gets a new mtime, causing false "both sides changed" detection
- Rapid edits can race with the watcher + DB update cycle
- Edge cases accumulate into a complex, bug-prone state machine

**Git already solves all of these problems.** The store is already a git repo with auto-commits after every sync. We can leverage git's 3-way merge instead of reinventing it.

## Core Concept

Every time a file is synced, the store directory is committed to git. This means:

```
BASE    = last committed version in store git repo (git show HEAD:<path>)
STORE   = current file on disk in store directory
TARGET  = current file on disk in target repo
```

By comparing STORE and TARGET against BASE, we get a clean 3-way diff:

| Store vs Base | Target vs Base | Result                                    |
| ------------- | -------------- | ----------------------------------------- |
| Same          | Same           | Nothing changed, skip                     |
| Same          | Different      | Only target changed → copy target → store |
| Different     | Same           | Only store changed → copy store → target  |
| Different     | Different      | Both changed → attempt `git merge-file`   |

When both sides changed, `git merge-file` performs a 3-way merge:

- **Clean merge** (no overlapping changes) → auto-resolve, write result to both sides
- **Conflict** (overlapping changes) → show conflict markers to user

## How It Works Step-by-Step

### 1. File Change Detected

Chokidar watcher detects a file change (store or target side). After 300ms debounce and self-change guard check, it triggers `syncFile()`.

### 2. Quick Checksum Fast-Path

Before doing any git operations, compare current checksums against DB-stored values:

```
currentStoreChecksum = sha256(storeFile)
currentTargetChecksum = sha256(targetFile)

if both match DB values → nothing changed, skip (no git call needed)
if both are equal to each other → already in sync, update DB, skip
```

This means **git is only invoked when files actually differ**, keeping the common case (polling, no changes) fast.

### 3. Get Base Version from Git

```bash
git show HEAD:repos/my-project/CLAUDE.md
```

This retrieves the last committed content — the state at the time of the last successful sync. This is our "common ancestor" for the 3-way comparison.

### 4. Compare and Decide

Compare store content and target content against base:

- `store == base` → store hasn't changed since last sync
- `target == base` → target hasn't changed since last sync
- Neither equals base → both sides were modified independently

### 5. Auto-Merge (when both changed)

Use `git merge-file --stdout` with three temp files:

```bash
git merge-file --stdout store_tmp base_tmp target_tmp
```

- Exit code 0: clean merge, no conflicts
- Exit code > 0: merge has conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`)

Clean merges are written to both sides automatically. Conflicts go to the UI for user resolution.

### 6. Commit Store

After any write to the store, auto-commit so that the next sync cycle has the correct base.

## All Possible Scenarios

### Scenario 1: Store modified, target untouched

**Example**: User edits `CLAUDE.md` in the store UI.

```
BASE (git):   "Hello World"
STORE (disk): "Hello World\nNew line"
TARGET (disk): "Hello World"
```

- `store != base` → store changed
- `target == base` → target unchanged
- **Action**: Copy store → target
- **Result**: Both files now contain "Hello World\nNew line"

### Scenario 2: Target modified, store untouched

**Example**: User edits `CLAUDE.md` directly in their project repo.

```
BASE (git):    "Hello World"
STORE (disk):  "Hello World"
TARGET (disk): "Hello World\nEdited in project"
```

- `store == base` → store unchanged
- `target != base` → target changed
- **Action**: Copy target → store, commit store
- **Result**: Both files synced, store committed

### Scenario 3: Both modified, no overlap (auto-merge)

**Example**: User adds a line at the top in store, and a line at the bottom in target.

```
BASE (git):    "Line 1\nLine 2\nLine 3"
STORE (disk):  "Line 0\nLine 1\nLine 2\nLine 3"
TARGET (disk): "Line 1\nLine 2\nLine 3\nLine 4"
```

- Both differ from base
- `git merge-file` succeeds (changes don't overlap):
  ```
  Line 0
  Line 1
  Line 2
  Line 3
  Line 4
  ```
- **Action**: Write merged content to both sides, commit store
- **Result**: Auto-merged! No user intervention needed.

### Scenario 4: Both modified, overlapping (true conflict)

**Example**: User edits the same line in both store and target.

```
BASE (git):    "greeting = hello"
STORE (disk):  "greeting = bonjour"
TARGET (disk): "greeting = hola"
```

- Both differ from base
- `git merge-file` produces conflict markers:
  ```
  <<<<<<< store
  greeting = bonjour
  =======
  greeting = hola
  >>>>>>> target
  ```
- **Action**: Create conflict record with base content + merged content (with markers)
- **Result**: UI shows conflict for user resolution, pre-filled with merge result

### Scenario 5: New file created in store (no git history)

**Example**: User creates a new `GEMINI.md` in store.

```
BASE (git):    null (file doesn't exist in git)
STORE (disk):  "New file content"
TARGET (disk): does not exist
```

- `getCommittedContent()` returns null
- Store exists, target doesn't, never synced before
- **Action**: Copy store → target (existing logic, no git needed)
- **Result**: File created in target

### Scenario 6: New file created in store, synced, then store modified

**This is the original bug scenario.**

```
Step 1: Create file in store → sync to target (both empty or same content)
Step 2: Git commits the store
Step 3: User modifies the file in store

BASE (git):    "" (empty, from initial sync commit)
STORE (disk):  "New content added"
TARGET (disk): "" (empty, untouched since sync)
```

- `store != base` → store changed
- `target == base` → target unchanged (still empty, same as committed version)
- **Action**: Copy store → target
- **Result**: Correctly syncs without conflict! The old checksum/mtime approach would have detected both as "changed" here.

### Scenario 7: File deleted from target

**Example**: User deletes `CLAUDE.md` from their project.

```
BASE (git):    "Some content"
STORE (disk):  "Some content"
TARGET (disk): does not exist
```

- Target doesn't exist, but it was previously synced (base exists in git)
- **Action**: Create delete-vs-exists conflict for user to decide
- **Options**: Keep store version (recreate in target) or delete from store too

### Scenario 8: File deleted from store

**Example**: User removes a file via the store UI.

```
BASE (git):    "Some content"
STORE (disk):  does not exist
TARGET (disk): "Some content"
```

- Store doesn't exist, but base exists in git
- **Action**: Create delete-vs-exists conflict
- **Options**: Keep target version (recreate in store) or delete from target too

### Scenario 9: Both sides identical but different from base

**Example**: Both sides were edited to the same content independently.

```
BASE (git):    "Old content"
STORE (disk):  "New content"
TARGET (disk): "New content"
```

- Checksums match → fast-path: already in sync
- **Action**: Update DB, commit store, done
- Git operations not even needed (caught by checksum fast-path)

### Scenario 10: File modified in target, then same edit in store before sync

**Example**: Race condition where user edits both sides to different content before the watcher fires.

```
BASE (git):    "Original"
STORE (disk):  "Edit A"
TARGET (disk): "Edit B"
```

- Both differ from base, non-overlapping? → auto-merge
- Overlapping? → conflict with markers
- **Result**: Handled correctly by git merge-file, no special case needed

### Scenario 11: First-ever sync (empty git repo)

**Example**: App just initialized, store git repo has no commits yet.

```
BASE (git):    null (no commits)
STORE (disk):  "Template content"
TARGET (disk): "Existing project content"
```

- `getCommittedContent()` returns null (no HEAD)
- **Fallback**: Use direct content comparison. If different, create conflict. If one side is empty, copy from the other.
- After first sync completes and store is committed, subsequent syncs use git-based approach.

### Scenario 12: Store file modified multiple times before target syncs

**Example**: User makes several edits to store file rapidly.

```
BASE (git):    "Version 1" (committed after last sync)
STORE (disk):  "Version 4" (edited 3 times since)
TARGET (disk): "Version 1" (untouched)
```

- `store != base` → store changed
- `target == base` → target unchanged
- **Action**: Copy store → target, commit store
- **Result**: All intermediate versions are lost (same as git — only committed states matter). The latest version is synced.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    syncFile()                         │
│                                                       │
│  1. Checksum fast-path (no git needed)               │
│     ├─ Both match DB? → skip                         │
│     └─ Both equal? → update DB, skip                 │
│                                                       │
│  2. git show HEAD:<path> → get BASE                  │
│     └─ null? → fallback to simple copy logic         │
│                                                       │
│  3. Compare STORE vs BASE, TARGET vs BASE            │
│     ├─ Only store changed → copy store → target      │
│     ├─ Only target changed → copy target → store     │
│     └─ Both changed → git merge-file                 │
│         ├─ Clean merge → write to both sides         │
│         └─ Conflicts → create conflict record        │
│                                                       │
│  4. Commit store (if modified)                       │
│  5. Broadcast WebSocket event                        │
└─────────────────────────────────────────────────────┘
```

## Key Functions

| Function                            | File                   | Purpose                                                    |
| ----------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `getCommittedContent(path)`         | `store-git.ts`         | Get last committed file content via `git show HEAD:<path>` |
| `gitMergeFile(base, store, target)` | `store-git.ts`         | 3-way merge using `git merge-file --stdout`                |
| `ensureStoreCommitted()`            | `store-git.ts`         | Ensure store has no uncommitted changes before comparison  |
| `syncFile(trackedFile, repo)`       | `sync-engine.ts`       | Main sync logic using git-based approach                   |
| `createConflict(...)`               | `conflict-detector.ts` | Create conflict record with base + merged content          |

## Why This Is Better

| Aspect          | Old (checksum/mtime)                | New (git 3-way merge)                              |
| --------------- | ----------------------------------- | -------------------------------------------------- |
| False conflicts | Common (mtime changes on copy)      | Impossible (base is a committed snapshot)          |
| Auto-merge      | Never (any both-changed = conflict) | Yes (non-overlapping changes merge cleanly)        |
| Reliability     | Fragile (race conditions, timing)   | Robust (git's battle-tested algorithm)             |
| Performance     | Fast (pure checksums)               | Fast with checksum fast-path, git only when needed |
| Conflict UX     | Store vs Target only                | Base + Store + Target + pre-filled merge result    |
| Complexity      | High (many edge cases)              | Lower (git handles edge cases)                     |
