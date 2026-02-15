# Performance & Security Audit

**Date:** 2025-02-13
**Scope:** Full codebase review — server (services, routes, DB, WebSocket) and UI (API client, hooks, components)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Security Issues](#security-issues)
   - [S1. Path Traversal in File Routes](#s1-path-traversal-in-file-routes)
   - [S2. Command Injection in open-folder](#s2-command-injection-in-open-folder)
   - [S3. CORS Allows All Origins](#s3-cors-allows-all-origins)
   - [S4. No Authentication / Authorization](#s4-no-authentication--authorization)
   - [S5. Server Listens on 0.0.0.0](#s5-server-listens-on-0000)
   - [S6. Unbounded File Content Reading](#s6-unbounded-file-content-reading)
   - [S7. Symlink-Based Directory Escape](#s7-symlink-based-directory-escape)
   - [S8. WebSocket Has No Origin Check or Size Limit](#s8-websocket-has-no-origin-check-or-size-limit)
   - [S9. Browse Endpoint Has No Path Boundary](#s9-browse-endpoint-has-no-path-boundary)
   - [S10. sync_log Grows Without Limit](#s10-sync_log-grows-without-limit)
3. [Performance Issues](#performance-issues)
   - [P1. N+1 Queries in Repo/Service Listing](#p1-n1-queries-in-reposervice-listing)
   - [P2. Polling Interval Can Pile Up](#p2-polling-interval-can-pile-up)
   - [P3. getDirectorySize Called in Request Path](#p3-getdirectorysize-called-in-request-path)
   - [P4. Self-Change Map and Debounce Timer Maps Never Cleaned](#p4-self-change-map-and-debounce-timer-maps-never-cleaned)
   - [P5. picomatch Compiled on Every Call](#p5-picomatch-compiled-on-every-call)
   - [P6. Missing Database Indexes](#p6-missing-database-indexes)
   - [P7. Sequential File Sync in syncRepo/syncService](#p7-sequential-file-sync-in-syncreposyncservice)
   - [P8. Unbounded Glob Results in Scanner](#p8-unbounded-glob-results-in-scanner)
   - [P9. No DB Transactions Around Multi-Statement Sync Updates](#p9-no-db-transactions-around-multi-statement-sync-updates)
   - [P10. Checksum Uses Truncated SHA-256](#p10-checksum-uses-truncated-sha-256)
4. [Low-Risk Observations](#low-risk-observations)
5. [Recommendation Priority Matrix](#recommendation-priority-matrix)

---

## Executive Summary

AI Sync is a local-first tool that watches and syncs AI config files between a central store and target repositories. Because it is designed to run on `localhost` for a single user, many traditional web-app security concerns (authentication, CSRF) are lower risk. However, several issues could become serious if the app is exposed to a network or if a malicious local site exploits the open CORS policy.

**Key findings:**

| Category    | Critical | High | Medium | Low |
| ----------- | -------- | ---- | ------ | --- |
| Security    | 1        | 3    | 4      | 2   |
| Performance | 0        | 2    | 5      | 3   |

The most impactful items to fix are:

1. **Path traversal** in wildcard file routes (security)
2. **Command injection** in `/api/open-folder` (security)
3. **N+1 queries** in list endpoints (performance)
4. **CORS `origin: true`** allowing cross-origin access to local API (security)

---

## Security Issues

### S1. Path Traversal in File Routes

**Severity:** CRITICAL
**Files:** `routes/files.ts`, `routes/services.ts`, `routes/templates.ts`

Wildcard route parameters (`/api/repos/:id/files/*`) pass `req.params['*']` directly into `path.join()` without validation:

```typescript
// files.ts:40 — filePath comes straight from the URL
const storeFilePath = path.join(config.storeReposPath, storeName, filePath);
```

An attacker (or a script from a malicious site via the open CORS) could request:

```
GET /api/repos/{id}/files/../../../../etc/passwd
PUT /api/repos/{id}/files/../../other-repo/CLAUDE.md
```

`path.join()` resolves `..` segments, so the resulting path escapes the store directory.

**Fix:** Add a centralized path validator used by every file route:

```typescript
function safeJoin(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}
```

Apply it everywhere `path.join(config.storeReposPath, ...)` or `path.join(localPath, ...)` is used with user-controlled segments. There are ~15 call sites across `files.ts`, `services.ts`, `templates.ts`, `conflicts.ts`, and `sync-engine.ts`.

---

### S2. Command Injection in open-folder

**Severity:** HIGH
**File:** `routes/setup.ts:124`

```typescript
// DANGEROUS: shell interprets metacharacters in folderPath
const child_process = require('node:child_process');
child_process.exec(`${cmd[0]} "${cmd[1]}"`);
```

The folder path is validated to exist as a directory, but a directory name containing shell metacharacters (`"`, backtick, `$()`) could still lead to shell injection.

**Fix:** Use `execFile()` which does not spawn a shell:

```typescript
import { execFile } from 'node:child_process';
execFile(cmd[0], [cmd[1]]);
```

The codebase already uses `execFile` in `store-git.ts` for `git merge-file`, so this is consistent.

---

### S3. CORS Allows All Origins

**Severity:** HIGH
**File:** `app.ts:23`

```typescript
await app.register(fastifyCors, { origin: true });
```

`origin: true` reflects the request origin, allowing any website to call the API. Combined with the path traversal above, a malicious page could read/write files on the user's machine.

**Fix:**

```typescript
await app.register(fastifyCors, {
  origin: [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
});
```

Restrict to localhost and 127.0.0.1 origins only.

---

### S4. No Authentication / Authorization

**Severity:** HIGH (context-dependent)
**Files:** All routes

All API routes check `state.db` but never verify caller identity. This is acceptable for a localhost-only tool, but problematic if exposed on a LAN.

Key destructive endpoints that are completely open:

- `POST /api/setup/reset` — wipes config
- `DELETE /api/repos/:id` — deletes tracked files
- `POST /api/sync/trigger` — triggers all syncs (resource-intensive)
- `PUT /api/settings` — changes global settings

**Mitigation (short-term):** Bind to `127.0.0.1` instead of `0.0.0.0` (see S5). This is the simplest fix that addresses the majority of the risk.

**Mitigation (long-term):** If multi-user or network access is ever needed, add a bearer token generated at startup and stored in the config.

---

### S5. Server Listens on 0.0.0.0

**Severity:** MEDIUM
**File:** `config.ts:63`

```typescript
host: process.env.HOST || '0.0.0.0',
```

By default, the server accepts connections from all network interfaces. Anyone on the same network can access the API.

**Fix:** Default to `127.0.0.1`:

```typescript
host: process.env.HOST || '127.0.0.1',
```

Users who intentionally want network access can set `HOST=0.0.0.0`.

---

### S6. Unbounded File Content Reading

**Severity:** MEDIUM
**Files:** `sync-engine.ts:487-488`, `routes/files.ts:48`, `routes/conflicts.ts:29`, `routes/services.ts`

Files are read with `fs.readFile(path, 'utf-8')` without checking size first. A single large file (>100 MB) could exhaust memory.

The size-blocking mechanism in `syncRepo()` checks total store directory size, but individual file sizes during sync or API reads are not checked.

**Fix:** Check `fs.stat().size` before reading; reject files above a configurable limit (e.g., 10 MB):

```typescript
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const stat = await fs.stat(filePath);
if (stat.size > MAX_FILE_SIZE) {
  throw new Error(`File too large: ${stat.size} bytes`);
}
const content = await fs.readFile(filePath, 'utf-8');
```

---

### S7. Symlink-Based Directory Escape

**Severity:** MEDIUM
**Files:** `sync-engine.ts`, `routes/files.ts:84`, `routes/repos.ts`

When a user registers a repo, AI Sync follows symlinks in various code paths. If a symlink at `.cursor` points to `/etc/`, files under it could be synced into the store.

The scanner in `repo-scanner.ts` uses `follow: false` in glob and filters out paths whose parent is a symlink — this is good. However, when creating symlinks via PUT (`files.ts:84`):

```typescript
await fs.symlink(req.body.target, storeFilePath);
```

The symlink target from the request body is not validated. A user could create a symlink pointing to any path on the system.

**Fix:** Validate symlink targets are relative paths or at least don't point outside the repo/store tree.

---

### S8. WebSocket Has No Origin Check or Size Limit

**Severity:** MEDIUM
**Files:** `ws/handlers.ts`, `app.ts`

- No origin validation on WebSocket upgrade (inherits from open CORS)
- No `maxPayload` configured on the WebSocket plugin
- No authentication — anyone who connects receives all broadcast events

**Fix:**

```typescript
await app.register(fastifyWebsocket, {
  options: { maxPayload: 1024 * 100 }, // 100 KB
});
```

---

### S9. Browse Endpoint Has No Path Boundary

**Severity:** LOW
**File:** `routes/setup.ts:21-49`

`GET /api/browse?path=/etc` lists directories anywhere on the filesystem. The endpoint filters out dotfiles (`.` prefix), but system directories like `/etc`, `/var`, `/root` are browsable.

**Fix:** For the setup flow this is by design (user picks a data directory). If this feels too permissive, restrict browsing to the user's home directory and its subdirectories.

---

### S10. sync_log Grows Without Limit

**Severity:** LOW
**Files:** `sync-engine.ts:1394-1400`, `db/schema.ts`

Every sync operation inserts a row into `sync_log`. With frequent polling (5 s) and many repos, this table can grow to millions of rows over months.

**Fix:** Add periodic cleanup — delete rows older than N days:

```sql
DELETE FROM sync_log WHERE created_at < datetime('now', '-30 days');
```

Run this once at startup or in the polling loop.

---

## Performance Issues

### P1. N+1 Queries in Repo/Service Listing

**Severity:** HIGH
**Files:** `routes/repos.ts:34-75`, `routes/services.ts` (similar pattern)

The `GET /api/repos` endpoint loads all repos, then for each repo:

1. Queries `tracked_files` for sync status counts
2. Queries `tracked_files` for `MAX(last_synced_at)`
3. Calls `getDirectorySize()` (filesystem walk)

For 50 repos, this means 100+ DB queries + 50 filesystem scans per request.

**Fix:** Use a single aggregating query:

```sql
SELECT r.*,
  COUNT(tf.id) as total_files,
  SUM(CASE WHEN tf.sync_status = 'synced' THEN 1 ELSE 0 END) as synced,
  SUM(CASE WHEN tf.sync_status = 'conflict' THEN 1 ELSE 0 END) as conflicts,
  MAX(tf.last_synced_at) as last_synced_at
FROM repos r
LEFT JOIN tracked_files tf ON r.id = tf.repo_id
GROUP BY r.id
ORDER BY r.name
```

For directory sizes: cache them with a short TTL (e.g., 30 s) or compute in a background timer.

---

### P2. Polling Interval Can Pile Up

**Severity:** HIGH
**File:** `sync-engine.ts:174-180`

```typescript
this.pollingTimer = setInterval(() => {
  this.scanAllReposForNewFiles()
    .then(() => this.scanAllServicesForNewFiles())
    .then(() => this.syncAllRepos())
    .then(() => this.syncAllServices())
    .catch(console.error);
}, interval);
```

If a poll takes longer than the interval (default 5 s), the next one starts before the previous finishes. With many repos doing git operations, this is realistic.

**Fix:** Use `setTimeout` with re-scheduling after completion:

```typescript
const poll = async () => {
  try {
    await this.scanAllReposForNewFiles();
    await this.scanAllServicesForNewFiles();
    await this.syncAllRepos();
    await this.syncAllServices();
  } catch (err) {
    console.error('Polling error:', err);
  }
  this.pollingTimer = setTimeout(poll, interval);
};
this.pollingTimer = setTimeout(poll, interval);
```

---

### P3. getDirectorySize Called in Request Path

**Severity:** MEDIUM
**Files:** `routes/repos.ts:52`, `routes/services.ts`

`getDirectorySize()` recursively walks the filesystem in a route handler. For large stores (thousands of files), this can take hundreds of milliseconds, blocking the response.

**Fix:** Cache the result with a TTL, or calculate it asynchronously in the sync loop and store in the database/memory.

---

### P4. Self-Change Map and Debounce Timer Maps Never Cleaned

**Severity:** MEDIUM
**File:** `file-watcher.ts:25-26`

```typescript
private debounceTimers = new Map<string, NodeJS.Timeout>();
private selfChanges = new Map<string, number>();
```

`selfChanges` entries are only removed when checked (lazy cleanup). If a path is marked as self-change but never checked again (file deleted or repo removed), the entry leaks. Over many sync cycles, these maps grow.

**Fix:** Add periodic sweep (e.g., every 60 s) to remove expired entries from `selfChanges`. For `debounceTimers`, entries are cleared after firing, so this is less of a concern.

---

### P5. picomatch Compiled on Every Call

**Severity:** MEDIUM
**File:** `sync-engine.ts:221-222`

```typescript
private isIgnored(relativePath: string, repoId?: string): boolean {
  const rawPatterns = repoId ? getRepoIgnorePatterns(this.db, repoId) : getIgnorePatterns(this.db);
  const ignorePatterns = expandIgnorePatterns(rawPatterns);
  const matcher = picomatch(ignorePatterns, { dot: true });
  return matcher(relativePath);
}
```

This compiles ignore patterns into a regex on every call. During a full sync cycle with 100 files per repo, that's 100 compilations per repo.

**Fix:** Cache the compiled matcher keyed by repo ID, invalidated when patterns change.

---

### P6. Missing Database Indexes

**Severity:** MEDIUM
**File:** `db/schema.ts`

Missing indexes for common query patterns:

```sql
-- Conflicts are always looked up by tracked_file_id
CREATE INDEX idx_conflicts_tracked_file ON conflicts(tracked_file_id);

-- Active repos/services are frequently filtered by status
CREATE INDEX idx_repos_status ON repos(status);
CREATE INDEX idx_service_configs_status ON service_configs(status);

-- Sync log queries by repo + time range
CREATE INDEX idx_sync_log_repo_created ON sync_log(repo_id, created_at DESC);
```

These are cheap to add (migration version 8) and will improve query performance as data grows.

---

### P7. Sequential File Sync in syncRepo/syncService

**Severity:** LOW
**File:** `sync-engine.ts:1072-1087`

Files are synced one-by-one in a `for` loop. Each file does:

- 2-3 `fs.stat` / `fs.readFile` calls
- 1 git operation (`getCommittedContent` or `ensureStoreCommitted`)
- 1-3 DB updates

For a repo with 50 files, this is sequential I/O.

**Fix:** This is intentionally sequential to avoid race conditions with git. The current design is correct; parallelizing would need careful locking. Not recommended to change without significant refactoring.

---

### P8. Unbounded Glob Results in Scanner

**Severity:** LOW
**File:** `repo-scanner.ts:83-89`

The glob patterns like `.cursor/**` can match thousands of files in large repos. No upper limit is enforced.

**Fix:** Add a `{ maxResults: 5000 }` option (or custom early-exit logic) to prevent runaway scanning. The existing size-blocking mechanism helps, but only applies at sync time, not scan time.

---

### P9. No DB Transactions Around Multi-Statement Sync Updates

**Severity:** LOW
**File:** `sync-engine.ts` (multiple locations)

A typical sync operation does: INSERT/UPDATE tracked_file, DELETE conflict, INSERT sync_log, then calls git commit. If the process crashes mid-way, the database can be left with stale `sync_status` or orphaned conflict records.

**Fix:** Wrap related DB operations in explicit transactions:

```typescript
const txn = this.db.transaction(() => {
  this.db.prepare('UPDATE tracked_files SET ...').run(...);
  this.db.prepare("DELETE FROM conflicts WHERE ...").run(...);
  this.db.prepare('INSERT INTO sync_log ...').run(...);
});
txn();
```

better-sqlite3 transactions are synchronous and fast. This is a low-effort, high-reliability improvement.

---

### P10. Checksum Uses Truncated SHA-256

**Severity:** LOW
**File:** `checksum.ts`

All checksums are the first 16 characters of a SHA-256 hex digest. This is 64 bits — collision probability is ~1 in 2^32 (birthday paradox). For the expected data volume (<100K files), this is safe.

**Note:** No action needed. Documented here for awareness.

---

## Low-Risk Observations

1. **SQL queries use parameterized statements** throughout — no SQL injection risk from user input.
2. **Dynamic SQL in `repos.ts:332`** (`UPDATE repos SET ${updates.join(', ')}`) — the column names come from a fixed `if/else` block (not user input), so this is safe despite looking suspicious.
3. **UI has no XSS risk** — React escapes content by default. No `dangerouslySetInnerHTML` usage found.
4. **WebSocket reconnection** uses a fixed 3-second delay (not exponential backoff), which is fine for single-user localhost.
5. **useEffect cleanups** are properly implemented across all hooks — no memory leak risk from subscriptions.
6. **simple-git library** handles shell escaping for git commit messages. No injection risk through `commitStoreChanges()`.
7. **Temp files in gitMergeFile** use `fs.mkdtemp()` with cleanup in `finally` block — safe.
8. **No rate limiting** — acceptable for localhost single-user. Would need adding if network-exposed.

---

## Recommendation Priority Matrix

### Immediate (effort: low, impact: high)

| #   | Issue                            | Fix                                           |
| --- | -------------------------------- | --------------------------------------------- |
| S1  | Path traversal in file routes    | Add `safeJoin()` validator (~15 call sites)   |
| S2  | Command injection in open-folder | Replace `exec()` with `execFile()` (1 line)   |
| S5  | 0.0.0.0 binding                  | Default to `127.0.0.1` (1 line)               |
| P2  | Polling pile-up                  | Replace `setInterval` with `setTimeout` chain |

### Short-term (effort: medium, impact: high)

| #   | Issue                         | Fix                                        |
| --- | ----------------------------- | ------------------------------------------ |
| S3  | CORS allows all origins       | Restrict origins in production mode        |
| P1  | N+1 queries in list endpoints | Single aggregating SQL + cached dir sizes  |
| P6  | Missing DB indexes            | Add migration v8 with 4 indexes            |
| P9  | No DB transactions            | Wrap sync operations in `db.transaction()` |

### Medium-term (effort: medium, impact: medium)

| #   | Issue                      | Fix                                      |
| --- | -------------------------- | ---------------------------------------- |
| S6  | Unbounded file reading     | Check file size before `readFile()`      |
| S7  | Symlink directory escape   | Validate symlink targets                 |
| S8  | WebSocket limits           | Configure `maxPayload`, add origin check |
| P3  | getDirectorySize in routes | Cache with TTL                           |
| P4  | Map cleanup                | Periodic sweep for expired selfChanges   |
| P5  | picomatch re-compilation   | Cache compiled matchers by repo ID       |
| S10 | sync_log unbounded growth  | Periodic cleanup of old entries          |

### Nice-to-have (effort varies)

| #   | Issue                  | Fix                                       |
| --- | ---------------------- | ----------------------------------------- |
| S4  | No authentication      | Add bearer token if network access needed |
| S9  | Browse has no boundary | Restrict to home directory                |
| P8  | Unbounded glob         | Add maxResults limit                      |
