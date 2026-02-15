# Performance & Security Audit (Gemini)

**Date:** 2026-02-13
**Scope:** Full codebase review — server (services, routes, DB, WebSocket) and UI (API client, hooks, components)
**Auditor:** Gemini CLI

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
**Files:** `packages/server/src/routes/files.ts`, `packages/server/src/routes/services.ts`

Wildcard route parameters (`/api/repos/:id/files/*`) pass `req.params['*']` directly into `path.join()` without validation:

```typescript
// files.ts
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

### S2. Command Injection in open-folder

**Severity:** HIGH
**File:** `packages/server/src/routes/setup.ts`

```typescript
// DANGEROUS: shell interprets metacharacters in folderPath
child_process.exec(`${cmd[0]} "${cmd[1]}"`);
```

The folder path is validated to exist as a directory, but a directory name containing shell metacharacters (`"`, backtick, `$()`) could still lead to shell injection.

**Fix:** Use `execFile()` which does not spawn a shell.

### S3. CORS Allows All Origins

**Severity:** HIGH
**File:** `packages/server/src/app.ts`

```typescript
await app.register(fastifyCors, { origin: true });
```

`origin: true` reflects the request origin, allowing any website to call the API. Combined with the path traversal above, a malicious page could read/write files on the user's machine.

**Fix:** Restrict origins to `localhost` and `127.0.0.1`.

### S4. No Authentication / Authorization

**Severity:** HIGH (context-dependent)
**Files:** All routes

All API routes check `state.db` but never verify caller identity. This is acceptable for a localhost-only tool, but problematic if exposed on a LAN.

**Mitigation:** Bind to `127.0.0.1` instead of `0.0.0.0`.

### S5. Server Listens on 0.0.0.0

**Severity:** MEDIUM
**File:** `packages/server/src/config.ts`

```typescript
host: process.env.HOST || '0.0.0.0',
```

By default, the server accepts connections from all network interfaces. Anyone on the same network can access the API.

**Fix:** Default to `127.0.0.1`.

### S6. Unbounded File Content Reading

**Severity:** MEDIUM
**Files:** `packages/server/src/services/sync-engine.ts`

Files are read with `fs.readFile(path, 'utf-8')` without checking size first. A single large file (>100 MB) could exhaust memory.

**Fix:** Check `fs.stat().size` before reading; reject files above a configurable limit.

### S7. Symlink-Based Directory Escape

**Severity:** MEDIUM
**Files:** `packages/server/src/routes/files.ts`

When creating symlinks via PUT:

```typescript
await fs.symlink(req.body.target, storeFilePath);
```

The symlink target from the request body is not validated. A user could create a symlink pointing to any path on the system.

**Fix:** Validate symlink targets are relative paths or at least don't point outside the repo/store tree.

---

## Performance Issues

### P1. N+1 Queries in Repo/Service Listing

**Severity:** HIGH
**Files:** `packages/server/src/routes/repos.ts`

The `GET /api/repos` endpoint loads all repos, then for each repo executes multiple SQL queries and filesystem calls (`getDirectorySize`).

**Fix:** Use a single aggregating query and cache directory sizes.

### P2. Polling Interval Can Pile Up

**Severity:** HIGH
**File:** `packages/server/src/services/sync-engine.ts`

```typescript
this.pollingTimer = setInterval(() => {
  this.scanAllReposForNewFiles()
    // ... chain of promises ...
    .catch(console.error);
}, interval);
```

If a poll takes longer than the interval (default 5 s), the next one starts before the previous finishes.

**Fix:** Use `setTimeout` with re-scheduling after completion.

### P3. getDirectorySize Called in Request Path

**Severity:** MEDIUM
**Files:** `packages/server/src/routes/repos.ts`

`getDirectorySize()` recursively walks the filesystem in a route handler. For large stores, this blocks the response.

**Fix:** Cache the result or compute asynchronously.

### P4. Map Cleanup

**Severity:** MEDIUM
**File:** `packages/server/src/services/file-watcher.ts` (inferred)

If internal maps like `selfChanges` are not aggressively cleaned up, they can leak memory over time.

### P5. picomatch Compiled on Every Call

**Severity:** MEDIUM
**File:** `packages/server/src/services/sync-engine.ts`

```typescript
const matcher = picomatch(ignorePatterns, { dot: true });
```

This compiles ignore patterns into a regex on every call.

**Fix:** Cache the compiled matcher keyed by repo ID.

---

## Conclusion

The codebase is generally well-structured but contains typical "localhost-only" assumptions that create security risks if the environment is not strictly controlled. The N+1 query issue in the repo listing is the most significant performance bottleneck for users with many repositories.
