import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import picomatch from 'picomatch';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import {
  expandIgnorePatterns,
  getIgnorePatterns,
  getRepoIgnorePatterns,
  getServiceEnabledPatterns,
  getServiceEnabledIgnorePatterns,
} from '../db/index.js';
import { fileChecksum, contentChecksum, symlinkChecksum } from './checksum.js';
import {
  getFileMtime,
  getSymlinkMtime,
  fileExists,
  symlinkExists,
  ensureDir,
  scanRepoForAIFiles,
  parentPathHasSymlink,
  isSymlink,
} from './repo-scanner.js';
import { createConflict } from './conflict-detector.js';
import { sendConflictNotification, clearNotifiedConflict } from './notifier.js';
import {
  queueStoreCommit,
  commitStoreChanges,
  getCommittedContent,
  getCommittedContentAt,
  getHeadCommitHash,
  ensureStoreCommitted,
  gitMergeFile,
  type MergeConflictInfo,
} from './store-git.js';
import { FileWatcherService } from './file-watcher.js';
import { scanServiceFiles } from './service-scanner.js';
import { getServiceDefinition } from './service-definitions.js';
import type { TrackedFile, Repo, ServiceConfig, SyncTarget, WsEvent } from '../types/index.js';
import { mapRow, mapRows } from '../db/index.js';
import { getFileSizes, getSyncBlockThreshold } from './size-calculator.js';

function repoToSyncTarget(repo: Repo): SyncTarget {
  return {
    id: repo.id,
    name: repo.name,
    localPath: repo.localPath,
    storePath: repo.storePath,
    status: repo.status,
    type: 'repo',
  };
}

function serviceToSyncTarget(svc: ServiceConfig): SyncTarget {
  return {
    id: svc.id,
    name: svc.name,
    localPath: svc.localPath,
    storePath: svc.storePath,
    status: svc.status,
    type: 'service',
  };
}

function getStoreBasePath(target: SyncTarget): string {
  if (target.type === 'service') {
    return path.join(config.storeServicesPath, target.storePath.replace(/^services\//, ''));
  }
  return path.join(config.storeReposPath, target.storePath.replace(/^repos\//, ''));
}

function getStoreGitRelativePath(target: SyncTarget, relativePath: string): string {
  if (target.type === 'service') {
    return path
      .join(target.storePath.replace(/^services\//, 'services/'), relativePath)
      .replace(/\\/g, '/');
  }
  return path
    .join(target.storePath.replace(/^repos\//, 'repos/'), relativePath)
    .replace(/\\/g, '/');
}

function broadcastId(target: SyncTarget): { repoId?: string; serviceId?: string } {
  return target.type === 'repo' ? { repoId: target.id } : { serviceId: target.id };
}

/**
 * Check if file content contains git conflict markers.
 * Used to detect when a git merge "succeeds" but leaves conflict markers in the file
 * (e.g. when git auto-merge keeps both sides).
 */
function hasConflictMarkers(content: string): boolean {
  // Check for conflict markers at the start of a line (how git writes them).
  // Simple includes() would false-positive on documentation that mentions markers.
  return /^<{7}/m.test(content) && /^={7}/m.test(content) && /^>{7}/m.test(content);
}

/**
 * Parse conflict markers from content, extracting the "ours" and "theirs" sides.
 * Lines outside conflict blocks are included in both sides.
 */
function parseConflictMarkerSides(content: string): { ours: string; theirs: string } {
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let inOurs = false;
  let inTheirs = false;

  for (const line of content.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      inOurs = true;
      inTheirs = false;
    } else if (line.startsWith('=======') && inOurs) {
      inOurs = false;
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>') && inTheirs) {
      inOurs = false;
      inTheirs = false;
    } else if (inOurs) {
      oursLines.push(line);
    } else if (inTheirs) {
      theirsLines.push(line);
    } else {
      oursLines.push(line);
      theirsLines.push(line);
    }
  }

  return { ours: oursLines.join('\n'), theirs: theirsLines.join('\n') };
}

export class SyncEngine {
  private db: Database.Database;
  private watcher: FileWatcherService;
  private pollingTimer: NodeJS.Timeout | null = null;
  private wsClients: Set<{ send: (data: string) => void }> = new Set();
  private ignoreMatcherCache = new Map<string, picomatch.Matcher>();
  private lastLogCleanup = 0;
  private sizeBlockLoggedAt = new Map<string, number>();
  private baseCommitOverride: string | null = null;
  private pullSyncInProgress = false;
  private pullCompletedAt = 0;
  private lastKnownHead: string | null = null;

  constructor(db: Database.Database) {
    this.db = db;
    this.watcher = new FileWatcherService(db);
  }

  registerWsClient(client: { send: (data: string) => void }): void {
    this.wsClients.add(client);
  }

  unregisterWsClient(client: { send: (data: string) => void }): void {
    this.wsClients.delete(client);
  }

  private broadcast(event: WsEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wsClients) {
      try {
        client.send(data);
      } catch {
        this.wsClients.delete(client);
      }
    }
  }

  async start(): Promise<void> {
    // Ensure store git repo is committed before starting comparisons
    await ensureStoreCommitted();

    // Track HEAD so we can detect external git operations (manual pull, etc.)
    this.lastKnownHead = await getHeadCommitHash();

    // Set up watcher event handlers
    this.watcher.on('storeChange', (relativePath: string) => {
      this.handleStoreChange(relativePath).catch(console.error);
    });

    this.watcher.on('targetChange', (repoId: string, relativePath: string) => {
      this.handleTargetChange(repoId, relativePath).catch(console.error);
    });

    this.watcher.on('serviceStoreChange', (relativePath: string) => {
      this.handleServiceStoreChange(relativePath).catch(console.error);
    });

    this.watcher.on('serviceTargetChange', (serviceId: string, relativePath: string) => {
      this.handleServiceTargetChange(serviceId, relativePath).catch(console.error);
    });

    // Start store watcher
    await this.watcher.startStoreWatcher();

    // Start target watchers for all active repos
    const repos = mapRows<Repo>(
      this.db.prepare("SELECT * FROM repos WHERE status = 'active'").all(),
    );

    for (const repo of repos) {
      await this.watcher.startTargetWatcher(repo.id, repo.localPath);
    }

    // Start service watchers
    const services = mapRows<ServiceConfig>(
      this.db.prepare("SELECT * FROM service_configs WHERE status = 'active'").all(),
    );

    if (services.length > 0) {
      await this.watcher.startServiceStoreWatcher();
    }

    for (const svc of services) {
      const def = getServiceDefinition(svc.serviceType);
      if (def) {
        const patterns = getServiceEnabledPatterns(this.db, svc.id, def.patterns);
        const svcIgnorePatterns = expandIgnorePatterns(
          getServiceEnabledIgnorePatterns(this.db, svc.id),
        );
        await this.watcher.startServiceTargetWatcher(
          svc.id,
          svc.localPath,
          patterns,
          svcIgnorePatterns,
        );
      }
    }

    // Scan all active repos and services for new files added while app was offline
    await this.scanAllReposForNewFiles(repos);
    await this.scanAllServicesForNewFiles(services);

    // Start polling fallback (setTimeout chain prevents overlapping cycles)
    const intervalSetting = this.db
      .prepare("SELECT value FROM settings WHERE key = 'sync_interval_ms'")
      .get() as { value: string } | undefined;
    const interval = parseInt(intervalSetting?.value || '5000', 10);
    this.scheduleNextPoll(interval);

    console.log('Sync engine started');
  }

  private scheduleNextPoll(interval: number): void {
    this.pollingTimer = setTimeout(async () => {
      try {
        // Check for external git operations before normal polling sync
        const handled = await this.checkForExternalHeadChange();
        if (!handled) {
          await this.scanAllReposForNewFiles();
          await this.scanAllServicesForNewFiles();
          await this.syncAllRepos();
          await this.syncAllServices();
        }
        this.pruneOldSyncLogs();
      } catch (err) {
        console.error('Polling error:', err);
      }
      if (this.pollingTimer !== null) {
        this.scheduleNextPoll(interval);
      }
    }, interval);
  }

  private pruneOldSyncLogs(): void {
    const now = Date.now();
    // Run cleanup at most once per hour
    if (now - this.lastLogCleanup < 3_600_000) return;
    this.lastLogCleanup = now;
    try {
      this.db.prepare("DELETE FROM sync_log WHERE created_at < datetime('now', '-30 days')").run();
    } catch (err) {
      console.error('Failed to prune sync_log:', err);
    }
  }

  async stop(): Promise<void> {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }
    this.watcher.removeAllListeners();
    await this.watcher.stopAll();
    this.wsClients.clear();
    this.ignoreMatcherCache.clear();
    console.log('Sync engine stopped');
  }

  async startWatcherForRepo(repo: Repo): Promise<void> {
    await this.watcher.startTargetWatcher(repo.id, repo.localPath);
  }

  async stopWatcherForRepo(repoId: string): Promise<void> {
    await this.watcher.stopTargetWatcher(repoId);
  }

  async startWatcherForService(svc: ServiceConfig): Promise<void> {
    const def = getServiceDefinition(svc.serviceType);
    if (!def) return;
    const patterns = getServiceEnabledPatterns(this.db, svc.id, def.patterns);
    const svcIgnorePatterns = expandIgnorePatterns(
      getServiceEnabledIgnorePatterns(this.db, svc.id),
    );
    await this.watcher.startServiceStoreWatcher();
    await this.watcher.startServiceTargetWatcher(
      svc.id,
      svc.localPath,
      patterns,
      svcIgnorePatterns,
    );
  }

  async stopWatcherForService(serviceId: string): Promise<void> {
    await this.watcher.stopServiceTargetWatcher(serviceId);
  }

  private isIgnored(relativePath: string, repoId?: string): boolean {
    const rawPatterns = repoId
      ? getRepoIgnorePatterns(this.db, repoId)
      : getIgnorePatterns(this.db);
    const ignorePatterns = expandIgnorePatterns(rawPatterns);
    if (ignorePatterns.length === 0) return false;

    const cacheKey = ignorePatterns.join('\0');
    let matcher = this.ignoreMatcherCache.get(cacheKey);
    if (!matcher) {
      matcher = picomatch(ignorePatterns, { dot: true });
      this.ignoreMatcherCache.set(cacheKey, matcher);
    }
    return matcher(relativePath);
  }

  /**
   * Detect external git operations (manual pull, merge, etc.) by checking
   * if HEAD has changed since we last looked. If so, trigger a full sync
   * pass using the previous HEAD as the base reference.
   * Returns true if an external change was detected and handled.
   */
  private async checkForExternalHeadChange(): Promise<boolean> {
    if (this.pullSyncInProgress) return false;

    const currentHead = await getHeadCommitHash();
    if (!currentHead || currentHead === this.lastKnownHead) return false;

    // HEAD changed externally — trigger syncAfterPull with previous HEAD as base
    const previousHead = this.lastKnownHead;
    this.lastKnownHead = currentHead;

    if (previousHead) {
      // Run the full post-pull sync pass so all files get the correct base
      await this.syncAfterPull(previousHead);
    }
    return true;
  }

  private async handleStoreChange(storeRelative: string): Promise<void> {
    // Skip watcher-triggered syncs during post-pull sync pass
    // (syncAfterPull already handles all files with the correct base)
    if (this.pullSyncInProgress) return;

    // Guard against late-arriving debounced watcher events from a recent pull.
    // chokidar's awaitWriteFinish (200ms) + debounce (300ms) can delay events
    // beyond the syncAfterPull() completion, causing them to use the wrong base.
    if (this.pullCompletedAt && Date.now() - this.pullCompletedAt < 2000) return;

    // Detect external git operations (manual pull, etc.)
    if (await this.checkForExternalHeadChange()) return;

    // storeRelative is like "repo-name/CLAUDE.md"
    const slashIdx = storeRelative.indexOf('/');
    if (slashIdx === -1) return;

    const storeName = storeRelative.substring(0, slashIdx);
    const fileRelative = storeRelative.substring(slashIdx + 1);

    const repo = mapRow<Repo>(
      this.db.prepare('SELECT * FROM repos WHERE store_path = ?').get(`repos/${storeName}`),
    );

    if (!repo || repo.status !== 'active') return;

    if (this.isIgnored(fileRelative, repo.id)) return;

    let trackedFile = mapRow<TrackedFile>(
      this.db
        .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
        .get(repo.id, fileRelative),
    );

    if (!trackedFile) {
      // New AI file detected in store — start tracking it
      // Detect if it's a symlink in the store
      const storeFilePath = path.join(
        config.storeReposPath,
        repo.storePath.replace(/^repos\//, ''),
        fileRelative,
      );
      const fileType = (await isSymlink(storeFilePath)) ? 'symlink' : 'file';
      const newId = uuid();
      this.db
        .prepare(
          'INSERT INTO tracked_files (id, repo_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId, repo.id, fileRelative, fileType, 'pending_to_target');

      trackedFile = mapRow<TrackedFile>(
        this.db.prepare('SELECT * FROM tracked_files WHERE id = ?').get(newId),
      );

      this.broadcast({ type: 'files_changed', repoId: repo.id });
    }

    await this.syncFile(trackedFile, repoToSyncTarget(repo));
  }

  private async handleTargetChange(repoId: string, relativePath: string): Promise<void> {
    if (this.isIgnored(relativePath, repoId)) return;

    const repo = mapRow<Repo>(this.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
    if (!repo || repo.status !== 'active') return;

    let trackedFile = mapRow<TrackedFile>(
      this.db
        .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
        .get(repoId, relativePath),
    );

    if (!trackedFile) {
      // New AI file detected in target repo — start tracking it
      const targetFilePath = path.join(repo.localPath, relativePath);
      const fileType = (await isSymlink(targetFilePath)) ? 'symlink' : 'file';
      const newId = uuid();
      this.db
        .prepare(
          'INSERT INTO tracked_files (id, repo_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId, repoId, relativePath, fileType, 'pending_to_store');

      trackedFile = mapRow<TrackedFile>(
        this.db.prepare('SELECT * FROM tracked_files WHERE id = ?').get(newId),
      );

      this.broadcast({ type: 'files_changed', repoId });
    }

    await this.syncFile(trackedFile, repoToSyncTarget(repo));
  }

  private async handleServiceStoreChange(storeRelative: string): Promise<void> {
    // Skip watcher-triggered syncs during post-pull sync pass
    if (this.pullSyncInProgress) return;
    if (this.pullCompletedAt && Date.now() - this.pullCompletedAt < 2000) return;
    if (await this.checkForExternalHeadChange()) return;

    // storeRelative is like "claude-code/commands/foo.md"
    const slashIdx = storeRelative.indexOf('/');
    if (slashIdx === -1) return;

    const storeName = storeRelative.substring(0, slashIdx);
    const fileRelative = storeRelative.substring(slashIdx + 1);

    const svc = mapRow<ServiceConfig>(
      this.db
        .prepare('SELECT * FROM service_configs WHERE store_path = ?')
        .get(`services/${storeName}`),
    );

    if (!svc || svc.status !== 'active') return;

    let trackedFile = mapRow<TrackedFile>(
      this.db
        .prepare('SELECT * FROM tracked_files WHERE service_config_id = ? AND relative_path = ?')
        .get(svc.id, fileRelative),
    );

    if (!trackedFile) {
      const storeFilePath = path.join(getStoreBasePath(serviceToSyncTarget(svc)), fileRelative);
      const fileType = (await isSymlink(storeFilePath)) ? 'symlink' : 'file';
      const newId = uuid();
      this.db
        .prepare(
          'INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId, svc.id, fileRelative, fileType, 'pending_to_target');

      trackedFile = mapRow<TrackedFile>(
        this.db.prepare('SELECT * FROM tracked_files WHERE id = ?').get(newId),
      );

      this.broadcast({ type: 'files_changed', serviceId: svc.id });
    }

    await this.syncFile(trackedFile, serviceToSyncTarget(svc));
  }

  private async handleServiceTargetChange(serviceId: string, relativePath: string): Promise<void> {
    const svc = mapRow<ServiceConfig>(
      this.db.prepare('SELECT * FROM service_configs WHERE id = ?').get(serviceId),
    );
    if (!svc || svc.status !== 'active') return;

    let trackedFile = mapRow<TrackedFile>(
      this.db
        .prepare('SELECT * FROM tracked_files WHERE service_config_id = ? AND relative_path = ?')
        .get(serviceId, relativePath),
    );

    if (!trackedFile) {
      const targetFilePath = path.join(svc.localPath, relativePath);
      const fileType = (await isSymlink(targetFilePath)) ? 'symlink' : 'file';
      const newId = uuid();
      this.db
        .prepare(
          'INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        )
        .run(newId, serviceId, relativePath, fileType, 'pending_to_store');

      trackedFile = mapRow<TrackedFile>(
        this.db.prepare('SELECT * FROM tracked_files WHERE id = ?').get(newId),
      );

      this.broadcast({ type: 'files_changed', serviceId });
    }

    await this.syncFile(trackedFile, serviceToSyncTarget(svc));
  }

  async syncFile(trackedFile: TrackedFile, target: SyncTarget): Promise<void> {
    // Auto-detect if a "file" entry is actually a symlink on disk
    // (handles pre-existing DB entries and entries missed by scanner)
    const storeBase = getStoreBasePath(target);
    if (trackedFile.fileType !== 'symlink') {
      const sp = path.join(storeBase, trackedFile.relativePath);
      const tp = path.join(target.localPath, trackedFile.relativePath);
      if ((await isSymlink(sp)) || (await isSymlink(tp))) {
        this.db
          .prepare("UPDATE tracked_files SET file_type = 'symlink' WHERE id = ?")
          .run(trackedFile.id);
        trackedFile = { ...trackedFile, fileType: 'symlink' };
      }
    }

    if (trackedFile.fileType === 'symlink') {
      await this.syncSymlink(trackedFile, target);
      return;
    }

    const storeFilePath = path.join(storeBase, trackedFile.relativePath);
    const targetFilePath = path.join(target.localPath, trackedFile.relativePath);

    const storeExists = await fileExists(storeFilePath);
    const targetExists = await fileExists(targetFilePath);

    if (!storeExists && !targetExists) {
      // Both deleted — remove tracking
      this.db.prepare('DELETE FROM tracked_files WHERE id = ?').run(trackedFile.id);
      return;
    }

    if (storeExists && !targetExists) {
      // Target was intentionally deleted if it was previously synced and had content
      const targetDeleted =
        trackedFile.lastSyncedAt !== null && trackedFile.targetChecksum !== null;

      if (targetDeleted) {
        // Delete-vs-modify conflict: target deleted, store still has content
        await this.createDeleteConflict(trackedFile, target, storeFilePath, targetFilePath);
        return;
      }

      // File never existed in target — copy store -> target
      await this.copyEntry(storeFilePath, targetFilePath, 'file');
      this.watcher.markSelfChange(targetFilePath);
      const checksum = await fileChecksum(storeFilePath);
      const mtime = await getFileMtime(storeFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(checksum, checksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(target.id, trackedFile.relativePath, 'sync_to_target', 'Store -> Target');
      // Commit store so git base is updated for future comparisons
      this.autoCommitStore(`Add ${trackedFile.relativePath} for ${target.name}`);
      return;
    }

    if (!storeExists && targetExists) {
      // Store was intentionally deleted if it was previously synced and had content
      const storeDeleted = trackedFile.lastSyncedAt !== null && trackedFile.storeChecksum !== null;

      if (storeDeleted) {
        // Delete-vs-modify conflict: store deleted, target still has content
        await this.createDeleteConflict(trackedFile, target, storeFilePath, targetFilePath);
        return;
      }

      // File never existed in store — copy target -> store
      await this.copyEntry(targetFilePath, storeFilePath, 'file');
      this.watcher.markSelfChange(storeFilePath);
      const checksum = await fileChecksum(targetFilePath);
      const mtime = await getFileMtime(targetFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(checksum, checksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(target.id, trackedFile.relativePath, 'sync_to_store', 'Target -> Store');
      this.autoCommitStore(`Sync ${trackedFile.relativePath} from ${target.name}`);
      return;
    }

    // Both exist — read content and compare
    const storeContent = await fs.readFile(storeFilePath, 'utf-8');
    const targetContent = await fs.readFile(targetFilePath, 'utf-8');

    if (storeContent === targetContent) {
      // If both sides have conflict markers (e.g. from a previous sync that
      // copied merged content to both), detect and create a conflict record.
      if (this.baseCommitOverride && hasConflictMarkers(storeContent)) {
        const { ours, theirs } = parseConflictMarkerSides(storeContent);
        // Revert both to clean local content
        await fs.writeFile(storeFilePath, ours, 'utf-8');
        await fs.writeFile(targetFilePath, ours, 'utf-8');
        this.watcher.markSelfChange(storeFilePath);
        this.watcher.markSelfChange(targetFilePath);
        await this.createConflictFromMergeMarkers(
          trackedFile,
          target,
          storeFilePath,
          ours,
          theirs,
          storeContent,
        );
        return;
      }

      // Already in sync — update checksums/mtime and clear any stale conflicts
      const checksum = contentChecksum(storeContent);

      // Don't auto-clear conflicts that have unresolved remote content.
      // After a merge abort, store and target match (both have local content),
      // but the conflict record holds remote content the user needs to review.
      // We detect this by checking: remote content (store_content) differs from
      // current file AND current file still matches the local side (target_content).
      // If the user edited files to something new, we allow auto-clear.
      const hadConflict = this.hasConflict(trackedFile.id);
      let conflictPreserved = false;
      if (hadConflict) {
        const pendingConflict = this.db
          .prepare(
            "SELECT store_content, target_content FROM conflicts WHERE tracked_file_id = ? AND status = 'pending'",
          )
          .get(trackedFile.id) as
          | { store_content: string | null; target_content: string | null }
          | undefined;
        if (
          pendingConflict?.store_content != null &&
          pendingConflict.store_content !== storeContent &&
          pendingConflict.target_content === storeContent
        ) {
          // File still has the local content, remote content not yet applied — keep conflict
          conflictPreserved = true;
        }
      }

      if (conflictPreserved) {
        // Keep sync_status as 'conflict' but update checksums so we don't re-enter
        const mtime = await getFileMtime(storeFilePath);
        this.db
          .prepare(
            `UPDATE tracked_files SET
              store_checksum = ?, target_checksum = ?,
              store_mtime = ?, target_mtime = ?
            WHERE id = ?`,
          )
          .run(checksum, checksum, mtime, mtime, trackedFile.id);
        return;
      }

      const changed =
        checksum !== trackedFile.storeChecksum ||
        checksum !== trackedFile.targetChecksum ||
        trackedFile.syncStatus !== 'synced';

      if (changed) {
        const mtime = await getFileMtime(storeFilePath);
        this.db
          .prepare(
            `UPDATE tracked_files SET
              store_checksum = ?, target_checksum = ?,
              store_mtime = ?, target_mtime = ?,
              sync_status = 'synced', last_synced_at = datetime('now')
            WHERE id = ?`,
          )
          .run(checksum, checksum, mtime, mtime, trackedFile.id);
      }

      // Auto-resolve any pending conflicts now that both sides match
      this.autoClearConflict(trackedFile.id);

      if (changed || hadConflict) {
        this.broadcast({
          type: 'sync_status',
          ...broadcastId(target),
          fileId: trackedFile.id,
          status: 'synced',
        });
      }
      // Commit store so git base stays current
      if (changed) {
        this.autoCommitStore(`Sync ${trackedFile.relativePath}`);
      }
      return;
    }

    // Files differ — use git 3-way merge to determine direction
    // Ensure store git is committed so HEAD reflects latest state
    // (prevents false conflicts when a prior autoCommitStore silently failed)
    const mergeConflicts = await ensureStoreCommitted();
    // Always keep HEAD tracker in sync after our own commits, even during
    // syncAfterPull (baseCommitOverride set). This prevents
    // checkForExternalHeadChange from detecting our own commits as "external"
    // and spuriously re-triggering syncAfterPull.
    this.lastKnownHead = await getHeadCommitHash();

    // If ensureStoreCommitted detected merge conflicts (e.g. from manual git pull),
    // it aborted the merge and returned conflict info. Check if this file is affected.
    if (mergeConflicts.length > 0) {
      await this.handleMergeConflicts(mergeConflicts);
      // After abort, store file reverted to pre-merge state (== target) — re-read & re-check
      const storeAfterAbort = await fs.readFile(storeFilePath, 'utf-8');
      if (storeAfterAbort === targetContent) {
        // Files now match after abort — just update checksums
        const checksum = contentChecksum(storeAfterAbort);
        this.db
          .prepare(
            `UPDATE tracked_files SET
              store_checksum = ?, target_checksum = ?,
              sync_status = 'conflict', last_synced_at = datetime('now')
            WHERE id = ?`,
          )
          .run(checksum, checksum, trackedFile.id);
      }
      return;
    }

    // Get the "base" version: last committed state in store git repo
    const storeGitRelative = getStoreGitRelativePath(target, trackedFile.relativePath);

    const baseContent = this.baseCommitOverride
      ? await getCommittedContentAt(storeGitRelative, this.baseCommitOverride)
      : await getCommittedContent(storeGitRelative);

    if (baseContent === null) {
      // No git history (new file, first sync) — fall back to checksum-based detection
      const storeChecksum = contentChecksum(storeContent);
      const targetChecksum = contentChecksum(targetContent);
      const storeChanged = storeChecksum !== trackedFile.storeChecksum;
      const targetChanged = targetChecksum !== trackedFile.targetChecksum;

      if (storeChanged && !targetChanged) {
        await this.syncToTarget(storeFilePath, targetFilePath, storeContent, trackedFile, target);
      } else if (targetChanged && !storeChanged) {
        await this.syncToStore(targetFilePath, storeFilePath, targetContent, trackedFile, target);
      } else {
        // Both changed or can't determine — store wins for first sync
        await this.syncToTarget(storeFilePath, targetFilePath, storeContent, trackedFile, target);
      }
      return;
    }

    const storeChanged = storeContent !== baseContent;
    const targetChanged = targetContent !== baseContent;

    if (storeChanged && !targetChanged) {
      // If store content has conflict markers (from a git merge that "succeeded"
      // but left markers), create a conflict record instead of blindly syncing.
      // This happens when git pull auto-merges but keeps both sides in the file.
      if (this.baseCommitOverride && hasConflictMarkers(storeContent)) {
        const { ours, theirs } = parseConflictMarkerSides(storeContent);
        // Revert store to the clean pre-merge state (target content)
        await fs.writeFile(storeFilePath, targetContent, 'utf-8');
        this.watcher.markSelfChange(storeFilePath);
        await this.createConflictFromMergeMarkers(
          trackedFile,
          target,
          storeFilePath,
          ours,
          theirs,
          storeContent,
        );
        return;
      }

      // Only store changed — sync store -> target
      await this.syncToTarget(storeFilePath, targetFilePath, storeContent, trackedFile, target);
      return;
    }

    if (targetChanged && !storeChanged) {
      // Only target changed — sync target -> store
      await this.syncToStore(targetFilePath, storeFilePath, targetContent, trackedFile, target);
      return;
    }

    if (!storeChanged && !targetChanged) {
      // Neither changed from base but they differ from each other
      // This shouldn't happen, but use store as source of truth
      await this.syncToTarget(storeFilePath, targetFilePath, storeContent, trackedFile, target);
      return;
    }

    // Both changed — attempt 3-way merge
    const { content: mergedContent, hasConflicts } = await gitMergeFile(
      baseContent,
      storeContent,
      targetContent,
    );

    if (!hasConflicts) {
      // Clean auto-merge! Write merged result to both sides
      await fs.writeFile(storeFilePath, mergedContent, 'utf-8');
      await fs.writeFile(targetFilePath, mergedContent, 'utf-8');
      this.watcher.markSelfChange(storeFilePath);
      this.watcher.markSelfChange(targetFilePath);
      const checksum = contentChecksum(mergedContent);
      const mtime = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(checksum, checksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(target.id, trackedFile.relativePath, 'auto_merged', '3-way merge succeeded');
      this.autoCommitStore(`Auto-merge ${trackedFile.relativePath} for ${target.name}`);
      return;
    }

    // True conflict — merge has conflict markers
    const existingConflict = this.db
      .prepare("SELECT id FROM conflicts WHERE tracked_file_id = ? AND status = 'pending'")
      .get(trackedFile.id);

    if (!existingConflict) {
      const storeChecksum = contentChecksum(storeContent);
      const targetChecksum = contentChecksum(targetContent);
      const storeMtime = await getFileMtime(storeFilePath);
      const targetMtime = await getFileMtime(targetFilePath);

      this.db
        .prepare(
          'UPDATE tracked_files SET store_checksum = ?, target_checksum = ?, store_mtime = ?, target_mtime = ? WHERE id = ?',
        )
        .run(storeChecksum, targetChecksum, storeMtime, targetMtime, trackedFile.id);

      const updatedFile = { ...trackedFile, storeChecksum, targetChecksum };
      const conflict = await createConflict(
        this.db,
        updatedFile,
        storeFilePath,
        targetFilePath,
        'conflict',
        baseContent,
        mergedContent,
      );

      if (conflict) {
        this.broadcast({ type: 'conflict_created', conflict });
        sendConflictNotification(this.db, conflict);
        this.logSync(
          target.id,
          trackedFile.relativePath,
          'conflict_created',
          'Both sides changed (3-way merge failed)',
        );
      }
    } else {
      const ec = existingConflict as { id: string };
      const storeChecksum = contentChecksum(storeContent);
      const targetChecksum = contentChecksum(targetContent);
      const storeMtime = await getFileMtime(storeFilePath);
      const targetMtime = await getFileMtime(targetFilePath);

      // Update tracked_files: sync_status may be stale (e.g. missing_in_store
      // from a prior delete) — set it to 'conflict' now that both files exist
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'conflict'
          WHERE id = ?`,
        )
        .run(storeChecksum, targetChecksum, storeMtime, targetMtime, trackedFile.id);

      // Update the existing conflict record with fresh content
      this.db
        .prepare(
          `UPDATE conflicts SET
            store_content = ?, target_content = ?,
            base_content = ?, merged_content = ?,
            store_checksum = ?, target_checksum = ?
          WHERE id = ?`,
        )
        .run(
          storeContent,
          targetContent,
          baseContent,
          mergedContent,
          storeChecksum,
          targetChecksum,
          ec.id,
        );

      this.broadcast({
        type: 'conflict_updated',
        conflictId: ec.id,
        trackedFileId: trackedFile.id,
        ...broadcastId(target),
      });
    }
  }

  /**
   * Sync a symlink entry. The "content" is the readlink() target string.
   * No 3-way merge — simple overwrite based on which side changed.
   */
  private async syncSymlink(trackedFile: TrackedFile, target: SyncTarget): Promise<void> {
    const storeFilePath = path.join(getStoreBasePath(target), trackedFile.relativePath);
    const targetFilePath = path.join(target.localPath, trackedFile.relativePath);

    const storeExists = await symlinkExists(storeFilePath);
    const targetExists = await symlinkExists(targetFilePath);

    if (!storeExists && !targetExists) {
      this.db.prepare('DELETE FROM tracked_files WHERE id = ?').run(trackedFile.id);
      return;
    }

    if (storeExists && !targetExists) {
      const targetDeleted =
        trackedFile.lastSyncedAt !== null && trackedFile.targetChecksum !== null;

      if (targetDeleted) {
        await this.createDeleteConflict(trackedFile, target, storeFilePath, targetFilePath);
        return;
      }

      // Symlink never existed in target — copy store -> target
      await this.copyEntry(storeFilePath, targetFilePath, 'symlink');
      this.watcher.markSelfChange(targetFilePath);
      const checksum = await symlinkChecksum(storeFilePath);
      const mtime = await getSymlinkMtime(storeFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(checksum, checksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(
        target.id,
        trackedFile.relativePath,
        'sync_to_target',
        'Symlink Store -> Target',
      );
      this.autoCommitStore(`Add symlink ${trackedFile.relativePath} for ${target.name}`);
      return;
    }

    if (!storeExists && targetExists) {
      const storeDeleted = trackedFile.lastSyncedAt !== null && trackedFile.storeChecksum !== null;

      if (storeDeleted) {
        await this.createDeleteConflict(trackedFile, target, storeFilePath, targetFilePath);
        return;
      }

      // Symlink never existed in store — copy target -> store
      await this.copyEntry(targetFilePath, storeFilePath, 'symlink');
      this.watcher.markSelfChange(storeFilePath);
      const checksum = await symlinkChecksum(targetFilePath);
      const mtime = await getSymlinkMtime(targetFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(checksum, checksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(target.id, trackedFile.relativePath, 'sync_to_store', 'Symlink Target -> Store');
      this.autoCommitStore(`Sync symlink ${trackedFile.relativePath} from ${target.name}`);
      return;
    }

    // Both exist — compare targets
    const storeTarget = await fs.readlink(storeFilePath);
    const targetTarget = await fs.readlink(targetFilePath);

    if (storeTarget === targetTarget) {
      // Already in sync
      const checksum = contentChecksum(storeTarget);
      const changed =
        checksum !== trackedFile.storeChecksum ||
        checksum !== trackedFile.targetChecksum ||
        trackedFile.syncStatus !== 'synced';

      if (changed) {
        const mtime = await getSymlinkMtime(storeFilePath);
        this.db
          .prepare(
            `UPDATE tracked_files SET
              store_checksum = ?, target_checksum = ?,
              store_mtime = ?, target_mtime = ?,
              sync_status = 'synced', last_synced_at = datetime('now')
            WHERE id = ?`,
          )
          .run(checksum, checksum, mtime, mtime, trackedFile.id);
      }

      const hadConflict = this.hasConflict(trackedFile.id);
      this.autoClearConflict(trackedFile.id);

      if (changed || hadConflict) {
        this.broadcast({
          type: 'sync_status',
          ...broadcastId(target),
          fileId: trackedFile.id,
          status: 'synced',
        });
      }
      if (changed) {
        this.autoCommitStore(`Sync symlink ${trackedFile.relativePath}`);
      }
      return;
    }

    // Symlinks differ — use checksum-based detection (no 3-way merge for symlinks)
    const storeChecksum = contentChecksum(storeTarget);
    const targetChecksum = contentChecksum(targetTarget);
    const storeChanged = storeChecksum !== trackedFile.storeChecksum;
    const targetChanged = targetChecksum !== trackedFile.targetChecksum;

    if (storeChanged && !targetChanged) {
      await this.copyEntry(storeFilePath, targetFilePath, 'symlink');
      this.watcher.markSelfChange(targetFilePath);
      const mtime = await getSymlinkMtime(storeFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(storeChecksum, storeChecksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(
        target.id,
        trackedFile.relativePath,
        'sync_to_target',
        'Symlink Store -> Target',
      );
      this.autoCommitStore(`Sync symlink ${trackedFile.relativePath} to ${target.name}`);
    } else if (targetChanged && !storeChanged) {
      await this.copyEntry(targetFilePath, storeFilePath, 'symlink');
      this.watcher.markSelfChange(storeFilePath);
      const mtime = await getSymlinkMtime(targetFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(targetChecksum, targetChecksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(target.id, trackedFile.relativePath, 'sync_to_store', 'Symlink Target -> Store');
      this.autoCommitStore(`Sync symlink ${trackedFile.relativePath} from ${target.name}`);
    } else {
      await this.copyEntry(storeFilePath, targetFilePath, 'symlink');
      this.watcher.markSelfChange(targetFilePath);
      const mtime = await getSymlinkMtime(storeFilePath);
      this.db
        .prepare(
          `UPDATE tracked_files SET
            store_checksum = ?, target_checksum = ?,
            store_mtime = ?, target_mtime = ?,
            sync_status = 'synced', last_synced_at = datetime('now')
          WHERE id = ?`,
        )
        .run(storeChecksum, storeChecksum, mtime, mtime, trackedFile.id);
      this.autoClearConflict(trackedFile.id);
      this.broadcast({
        type: 'sync_status',
        ...broadcastId(target),
        fileId: trackedFile.id,
        status: 'synced',
      });
      this.logSync(
        target.id,
        trackedFile.relativePath,
        'sync_to_target',
        'Symlink Store -> Target (both changed)',
      );
      this.autoCommitStore(`Sync symlink ${trackedFile.relativePath} to ${target.name}`);
    }
  }

  private async syncToTarget(
    storeFilePath: string,
    targetFilePath: string,
    content: string,
    trackedFile: TrackedFile,
    target: SyncTarget,
  ): Promise<void> {
    await this.copyEntry(storeFilePath, targetFilePath, 'file');
    this.watcher.markSelfChange(targetFilePath);
    const checksum = contentChecksum(content);
    const mtime = await getFileMtime(storeFilePath);
    this.db
      .prepare(
        `UPDATE tracked_files SET
          store_checksum = ?, target_checksum = ?,
          store_mtime = ?, target_mtime = ?,
          sync_status = 'synced', last_synced_at = datetime('now')
        WHERE id = ?`,
      )
      .run(checksum, checksum, mtime, mtime, trackedFile.id);
    this.autoClearConflict(trackedFile.id);
    this.broadcast({
      type: 'sync_status',
      ...broadcastId(target),
      fileId: trackedFile.id,
      status: 'synced',
    });
    this.logSync(target.id, trackedFile.relativePath, 'sync_to_target', 'Store -> Target');
    this.autoCommitStore(`Sync ${trackedFile.relativePath} to ${target.name}`);
  }

  private async syncToStore(
    targetFilePath: string,
    storeFilePath: string,
    content: string,
    trackedFile: TrackedFile,
    target: SyncTarget,
  ): Promise<void> {
    await this.copyEntry(targetFilePath, storeFilePath, 'file');
    this.watcher.markSelfChange(storeFilePath);
    const checksum = contentChecksum(content);
    const mtime = await getFileMtime(targetFilePath);
    this.db
      .prepare(
        `UPDATE tracked_files SET
          store_checksum = ?, target_checksum = ?,
          store_mtime = ?, target_mtime = ?,
          sync_status = 'synced', last_synced_at = datetime('now')
        WHERE id = ?`,
      )
      .run(checksum, checksum, mtime, mtime, trackedFile.id);
    this.autoClearConflict(trackedFile.id);
    this.broadcast({
      type: 'sync_status',
      ...broadcastId(target),
      fileId: trackedFile.id,
      status: 'synced',
    });
    this.logSync(target.id, trackedFile.relativePath, 'sync_to_store', 'Target -> Store');
    this.autoCommitStore(`Sync ${trackedFile.relativePath} from ${target.name}`);
  }

  /**
   * Handle merge conflicts detected during pull or by ensureStoreCommitted.
   * Creates conflict records so users can resolve them in the UI.
   * For pull conflicts: the merge was completed with "ours" (local content)
   * so the store file on disk has the local version.
   * For ensureStoreCommitted: the merge was aborted, restoring pre-merge state.
   */
  async handleMergeConflicts(conflicts: MergeConflictInfo[]): Promise<void> {
    for (const { filePath, ours, theirs } of conflicts) {
      // Map store-relative path to tracked file
      // filePath is like "repos/my-project/CLAUDE.md" or "services/claude-code/settings.json"
      let trackedFile: TrackedFile | undefined;
      let target: SyncTarget | undefined;
      let storeFilePath: string | undefined;
      let targetFilePath: string | undefined;

      if (filePath.startsWith('repos/')) {
        const withoutPrefix = filePath.replace(/^repos\//, '');
        const slashIdx = withoutPrefix.indexOf('/');
        if (slashIdx === -1) continue;
        const storeName = withoutPrefix.substring(0, slashIdx);
        const fileRelative = withoutPrefix.substring(slashIdx + 1);

        const repo = mapRow<Repo>(
          this.db.prepare('SELECT * FROM repos WHERE store_path = ?').get(`repos/${storeName}`),
        );
        if (!repo) continue;

        trackedFile = mapRow<TrackedFile>(
          this.db
            .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
            .get(repo.id, fileRelative),
        );
        if (!trackedFile) continue;

        target = repoToSyncTarget(repo);
        storeFilePath = path.join(config.storeReposPath, storeName, fileRelative);
        targetFilePath = path.join(repo.localPath, fileRelative);
      } else if (filePath.startsWith('services/')) {
        const withoutPrefix = filePath.replace(/^services\//, '');
        const slashIdx = withoutPrefix.indexOf('/');
        if (slashIdx === -1) continue;
        const storeName = withoutPrefix.substring(0, slashIdx);
        const fileRelative = withoutPrefix.substring(slashIdx + 1);

        const svc = mapRow<ServiceConfig>(
          this.db
            .prepare('SELECT * FROM service_configs WHERE store_path = ?')
            .get(`services/${storeName}`),
        );
        if (!svc) continue;

        trackedFile = mapRow<TrackedFile>(
          this.db
            .prepare(
              'SELECT * FROM tracked_files WHERE service_config_id = ? AND relative_path = ?',
            )
            .get(svc.id, fileRelative),
        );
        if (!trackedFile) continue;

        target = serviceToSyncTarget(svc);
        storeFilePath = path.join(config.storeServicesPath, storeName, fileRelative);
        targetFilePath = path.join(svc.localPath, fileRelative);
      }

      if (!trackedFile || !target || !storeFilePath || !targetFilePath) continue;
      if (this.hasConflict(trackedFile.id)) continue;

      // Mark store file as self-change so the watcher ignores the revert
      // that happens when git merge --abort restores the pre-merge state.
      // Without this, the watcher would trigger syncFile which would see
      // store == target and auto-clear the conflict we're about to create.
      this.watcher.markSelfChange(storeFilePath);

      // Use "ours" as base since it's what both store and target currently have
      // "theirs" is the incoming remote content that conflicts
      // Write theirs as store_content so UI shows: local (target) vs remote (store)
      const conflictId = uuid();
      this.db
        .prepare(
          `INSERT INTO conflicts (id, tracked_file_id, store_content, target_content, base_content, merged_content, store_checksum, target_checksum, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          conflictId,
          trackedFile.id,
          theirs, // "store" side = remote content (what was pulled)
          ours, // "target" side = local content (what was here before)
          ours, // base = local content (common ancestor approximation)
          null,
          trackedFile.storeChecksum || '',
          trackedFile.targetChecksum || '',
        );

      this.db
        .prepare("UPDATE tracked_files SET sync_status = 'conflict' WHERE id = ?")
        .run(trackedFile.id);

      this.broadcast({
        type: 'conflict_created',
        conflict: {
          id: conflictId,
          trackedFileId: trackedFile.id,
          storeContent: theirs,
          targetContent: ours,
          baseContent: ours,
          mergedContent: null,
          storeChecksum: trackedFile.storeChecksum || '',
          targetChecksum: trackedFile.targetChecksum || '',
          status: 'pending',
          resolvedAt: null,
          createdAt: new Date().toISOString(),
          ...(target.type === 'repo'
            ? { repoId: target.id, repoName: target.name, serviceId: null, serviceName: null }
            : { repoId: null, repoName: null, serviceId: target.id, serviceName: target.name }),
          relativePath: trackedFile.relativePath,
        },
      });

      this.logSync(
        target.id,
        trackedFile.relativePath,
        'conflict_created',
        'Merge conflict from external git pull',
      );
    }
  }

  /**
   * Create a conflict record when a git merge left conflict markers in a file.
   * This happens when git pull auto-merges "successfully" but the result
   * still contains <<<<<<</>>>>>>  markers.
   * Reverts the file on disk to clean local content and stores both sides
   * in the conflict record for the user to resolve in the UI.
   */
  private async createConflictFromMergeMarkers(
    trackedFile: TrackedFile,
    target: SyncTarget,
    storeFilePath: string,
    ours: string,
    theirs: string,
    mergedContent: string,
  ): Promise<void> {
    if (this.hasConflict(trackedFile.id)) return;

    const storeChecksum = contentChecksum(theirs);
    const targetChecksum = contentChecksum(ours);
    const mtime = await getFileMtime(storeFilePath);

    this.db
      .prepare(
        'UPDATE tracked_files SET store_checksum = ?, target_checksum = ?, store_mtime = ?, target_mtime = ? WHERE id = ?',
      )
      .run(storeChecksum, targetChecksum, mtime, mtime, trackedFile.id);

    const conflictId = uuid();
    this.db
      .prepare(
        `INSERT INTO conflicts (id, tracked_file_id, store_content, target_content, base_content, merged_content, store_checksum, target_checksum, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(
        conflictId,
        trackedFile.id,
        theirs, // remote content → shown as "Store" in UI
        ours, // local content → shown as "Target" in UI
        ours, // base = pre-merge local state
        mergedContent, // merged content with markers for reference
        storeChecksum,
        targetChecksum,
      );

    this.db
      .prepare("UPDATE tracked_files SET sync_status = 'conflict' WHERE id = ?")
      .run(trackedFile.id);

    this.broadcast({
      type: 'conflict_created',
      conflict: {
        id: conflictId,
        trackedFileId: trackedFile.id,
        storeContent: theirs,
        targetContent: ours,
        baseContent: ours,
        mergedContent,
        storeChecksum,
        targetChecksum,
        status: 'pending',
        resolvedAt: null,
        createdAt: new Date().toISOString(),
        ...(target.type === 'repo'
          ? { repoId: target.id, repoName: target.name, serviceId: null, serviceName: null }
          : { repoId: null, repoName: null, serviceId: target.id, serviceName: target.name }),
        relativePath: trackedFile.relativePath,
      },
    });

    this.logSync(
      target.id,
      trackedFile.relativePath,
      'conflict_created',
      'Git merge left conflict markers in file',
    );
  }

  private hasConflict(trackedFileId: string): boolean {
    return !!this.db
      .prepare("SELECT id FROM conflicts WHERE tracked_file_id = ? AND status = 'pending'")
      .get(trackedFileId);
  }

  private autoClearConflict(trackedFileId: string): void {
    const pendingConflict = this.db
      .prepare("SELECT id FROM conflicts WHERE tracked_file_id = ? AND status = 'pending'")
      .get(trackedFileId) as { id: string } | undefined;

    if (pendingConflict) {
      this.db
        .prepare(
          "UPDATE conflicts SET status = 'resolved_auto', resolved_at = datetime('now') WHERE id = ?",
        )
        .run(pendingConflict.id);
      this.broadcast({ type: 'conflict_resolved', conflictId: pendingConflict.id });
      clearNotifiedConflict(trackedFileId);
    }
  }

  private async createDeleteConflict(
    trackedFile: TrackedFile,
    target: SyncTarget,
    storeFilePath: string,
    targetFilePath: string,
  ): Promise<void> {
    // Check if there's already a pending conflict
    const existingConflict = this.db
      .prepare("SELECT id FROM conflicts WHERE tracked_file_id = ? AND status = 'pending'")
      .get(trackedFile.id);

    if (existingConflict) return;

    const storeExists =
      trackedFile.fileType === 'symlink'
        ? await symlinkExists(storeFilePath)
        : await fileExists(storeFilePath);
    const deleteStatus = storeExists ? 'missing_in_target' : 'missing_in_store';
    const conflict = await createConflict(
      this.db,
      trackedFile,
      storeFilePath,
      targetFilePath,
      deleteStatus,
    );

    if (conflict) {
      this.broadcast({ type: 'conflict_created', conflict });
      sendConflictNotification(this.db, conflict);
      this.logSync(
        target.id,
        trackedFile.relativePath,
        'conflict_created',
        `${storeExists ? 'Target' : 'Store'} deleted, other side still exists`,
      );
    }
  }

  async syncRepo(
    repoId: string,
    options?: { force?: boolean },
  ): Promise<{ synced: number; conflicts: number; errors: number }> {
    const repo = mapRow<Repo>(this.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    const target = repoToSyncTarget(repo);
    const trackedFiles = mapRows<TrackedFile>(
      this.db.prepare('SELECT * FROM tracked_files WHERE repo_id = ?').all(repoId),
    );

    // Block sync if tracked files size exceeds threshold
    const blockThreshold = getSyncBlockThreshold(this.db);
    const storeDir = path.join(config.storeReposPath, repo.storePath.replace(/^repos\//, ''));
    const fileSizes = await getFileSizes(
      storeDir,
      trackedFiles.map((f) => f.relativePath),
    );
    const totalSize = [...fileSizes.values()].reduce((sum, s) => sum + s, 0);
    if (totalSize > blockThreshold) {
      const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
      const limitMB = (blockThreshold / (1024 * 1024)).toFixed(0);
      const lastLogged = this.sizeBlockLoggedAt.get(repo.id) ?? 0;
      if (Date.now() - lastLogged > 300_000) {
        console.warn(
          `Sync blocked for repo ${repo.name}: store size ${sizeMB} MB exceeds ${limitMB} MB`,
        );
        this.sizeBlockLoggedAt.set(repo.id, Date.now());
      }
      this.broadcast({
        type: 'sync_blocked',
        repoId: repo.id,
        reason: `Store size (${sizeMB} MB) exceeds ${limitMB} MB limit`,
        totalSize,
      });
      return { synced: 0, conflicts: 0, errors: 0 };
    }

    let synced = 0;
    let conflicts = 0;
    let errors = 0;

    for (const tf of trackedFiles) {
      try {
        await this.syncFile(tf, target);
        const updated = this.db
          .prepare('SELECT sync_status FROM tracked_files WHERE id = ?')
          .get(tf.id) as { sync_status: string } | undefined;
        if (updated?.sync_status === 'conflict') {
          conflicts++;
        } else {
          synced++;
        }
      } catch (err) {
        errors++;
        console.error(`Error syncing ${tf.relativePath}:`, err);
      }
    }

    if (options?.force) {
      this.db
        .prepare(
          `UPDATE tracked_files SET last_synced_at = datetime('now')
           WHERE repo_id = ? AND sync_status = 'synced'`,
        )
        .run(repoId);
    }

    if (synced > 0 || conflicts > 0 || errors > 0) {
      this.broadcast({ type: 'sync_complete', repoId, summary: { synced, conflicts, errors } });
    }
    return { synced, conflicts, errors };
  }

  async syncService(
    serviceId: string,
    options?: { force?: boolean },
  ): Promise<{ synced: number; conflicts: number; errors: number }> {
    const svc = mapRow<ServiceConfig>(
      this.db.prepare('SELECT * FROM service_configs WHERE id = ?').get(serviceId),
    );
    if (!svc) throw new Error(`Service config not found: ${serviceId}`);

    const target = serviceToSyncTarget(svc);
    const trackedFiles = mapRows<TrackedFile>(
      this.db.prepare('SELECT * FROM tracked_files WHERE service_config_id = ?').all(serviceId),
    );

    // Block sync if tracked files size exceeds threshold
    const blockThreshold = getSyncBlockThreshold(this.db);
    const storeDir = path.join(config.storeServicesPath, svc.storePath.replace(/^services\//, ''));
    const fileSizes = await getFileSizes(
      storeDir,
      trackedFiles.map((f) => f.relativePath),
    );
    const totalSize = [...fileSizes.values()].reduce((sum, s) => sum + s, 0);
    if (totalSize > blockThreshold) {
      const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
      const limitMB = (blockThreshold / (1024 * 1024)).toFixed(0);
      const lastLogged = this.sizeBlockLoggedAt.get(svc.id) ?? 0;
      if (Date.now() - lastLogged > 300_000) {
        console.warn(
          `Sync blocked for service ${svc.name}: store size ${sizeMB} MB exceeds ${limitMB} MB`,
        );
        this.sizeBlockLoggedAt.set(svc.id, Date.now());
      }
      this.broadcast({
        type: 'sync_blocked',
        serviceId: svc.id,
        reason: `Store size (${sizeMB} MB) exceeds ${limitMB} MB limit`,
        totalSize,
      });
      return { synced: 0, conflicts: 0, errors: 0 };
    }

    let synced = 0;
    let conflicts = 0;
    let errors = 0;

    for (const tf of trackedFiles) {
      try {
        await this.syncFile(tf, target);
        const updated = this.db
          .prepare('SELECT sync_status FROM tracked_files WHERE id = ?')
          .get(tf.id) as { sync_status: string } | undefined;
        if (updated?.sync_status === 'conflict') {
          conflicts++;
        } else {
          synced++;
        }
      } catch (err) {
        errors++;
        console.error(`Error syncing ${tf.relativePath}:`, err);
      }
    }

    if (options?.force) {
      this.db
        .prepare(
          `UPDATE tracked_files SET last_synced_at = datetime('now')
           WHERE service_config_id = ? AND sync_status = 'synced'`,
        )
        .run(serviceId);
    }

    if (synced > 0 || conflicts > 0 || errors > 0) {
      this.broadcast({ type: 'sync_complete', serviceId, summary: { synced, conflicts, errors } });
    }
    return { synced, conflicts, errors };
  }

  /**
   * Scan all active repos for new AI files that aren't yet tracked.
   * This catches files added while the app was offline or missed by the watcher.
   * Scans both target repos and store folders.
   */
  private async scanAllReposForNewFiles(repos?: Repo[]): Promise<void> {
    const activeRepos =
      repos ?? mapRows<Repo>(this.db.prepare("SELECT * FROM repos WHERE status = 'active'").all());

    for (const repo of activeRepos) {
      try {
        const existing = this.db
          .prepare('SELECT relative_path, file_type FROM tracked_files WHERE repo_id = ?')
          .all(repo.id) as { relative_path: string; file_type: string }[];
        const existingPaths = new Set(existing.map((e) => e.relative_path));

        let newCount = 0;

        // Clean up tracked files whose PARENT path goes through a symlink (they can't sync properly)
        // But don't delete entries that ARE symlinks themselves
        for (const e of existing) {
          if (
            e.file_type !== 'symlink' &&
            (await parentPathHasSymlink(repo.localPath, e.relative_path))
          ) {
            this.db
              .prepare('DELETE FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
              .run(repo.id, e.relative_path);
            existingPaths.delete(e.relative_path);
          }
        }

        // Scan target repo for new files (with repo-specific patterns)
        const targetEntries = await scanRepoForAIFiles(repo.localPath, this.db, repo.id);
        for (const entry of targetEntries) {
          if (!existingPaths.has(entry.path)) {
            const fileId = uuid();
            this.db
              .prepare(
                'INSERT INTO tracked_files (id, repo_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                fileId,
                repo.id,
                entry.path,
                entry.isSymlink ? 'symlink' : 'file',
                'pending_to_store',
              );
            existingPaths.add(entry.path);
            newCount++;
          }
        }

        // Scan store folder for new files
        const storeFolderPath = path.join(
          config.storeReposPath,
          repo.storePath.replace(/^repos\//, ''),
        );
        const storeEntries = await scanRepoForAIFiles(storeFolderPath, this.db, repo.id);
        for (const entry of storeEntries) {
          if (!existingPaths.has(entry.path)) {
            const fileId = uuid();
            this.db
              .prepare(
                'INSERT INTO tracked_files (id, repo_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                fileId,
                repo.id,
                entry.path,
                entry.isSymlink ? 'symlink' : 'file',
                'pending_to_target',
              );
            existingPaths.add(entry.path);
            newCount++;
          }
        }

        if (newCount > 0) {
          console.log(`Found ${newCount} new file(s) in ${repo.name}`);
          this.broadcast({ type: 'files_changed', repoId: repo.id });
        }
      } catch (err) {
        console.error(`Error scanning repo ${repo.name} for new files:`, err);
      }
    }
  }

  async syncAllRepos(options?: { force?: boolean }): Promise<void> {
    const repos = mapRows<Repo>(
      this.db.prepare("SELECT * FROM repos WHERE status = 'active'").all(),
    );

    for (const repo of repos) {
      try {
        await this.syncRepo(repo.id, options);
      } catch (err) {
        console.error(`Error syncing repo ${repo.name}:`, err);
      }
    }
  }

  async syncAllServices(options?: { force?: boolean }): Promise<void> {
    const services = mapRows<ServiceConfig>(
      this.db.prepare("SELECT * FROM service_configs WHERE status = 'active'").all(),
    );

    for (const svc of services) {
      try {
        await this.syncService(svc.id, options);
      } catch (err) {
        console.error(`Error syncing service ${svc.name}:`, err);
      }
    }
  }

  /**
   * Suppress watcher-triggered syncs. Call before starting git pull
   * so watcher events from file changes during pull are ignored.
   */
  enterPullMode(): void {
    this.pullSyncInProgress = true;
  }

  /**
   * Release pull mode without running a sync pass.
   * Used when pull had no changes or failed.
   */
  leavePullMode(): void {
    this.watcher.clearStoreDebounceTimers();
    this.pullCompletedAt = Date.now();
    this.pullSyncInProgress = false;
  }

  /**
   * Run a full sync pass using a specific commit as the base reference.
   * Used after git pull to correctly detect which side changed:
   * the pre-pull HEAD is the correct base, not the post-pull HEAD.
   *
   * During this pass:
   * - Watcher-triggered syncs are suppressed (we handle all files here)
   * - Per-file auto-commits are suppressed (one batch commit at the end)
   */
  async syncAfterPull(prePullCommitHash: string): Promise<void> {
    this.baseCommitOverride = prePullCommitHash;
    this.pullSyncInProgress = true;
    try {
      await this.syncAllRepos();
      await this.syncAllServices();
    } finally {
      // Clear any pending store watcher debounce timers BEFORE releasing the flag.
      // git pull modifies store files on disk, causing chokidar to queue debounced
      // events. If those fire after we clear pullSyncInProgress, they'd run syncFile
      // with the post-pull HEAD as base — which incorrectly sees "only target changed"
      // and syncs the old target content back to the store, undoing the pull.
      this.watcher.clearStoreDebounceTimers();
      this.pullCompletedAt = Date.now();
      this.pullSyncInProgress = false;
      this.baseCommitOverride = null;
    }
    // Commit synchronously (not debounced) so HEAD is up-to-date before
    // we capture lastKnownHead. Using queueStoreCommit here would leave
    // lastKnownHead stale until the 2s debounce fires, causing
    // checkForExternalHeadChange to spuriously re-trigger syncAfterPull.
    await commitStoreChanges('Sync after pull');

    // Update tracked HEAD so subsequent syncs don't re-trigger this path
    this.lastKnownHead = await getHeadCommitHash();
  }

  private async scanAllServicesForNewFiles(services?: ServiceConfig[]): Promise<void> {
    const activeServices =
      services ??
      mapRows<ServiceConfig>(
        this.db.prepare("SELECT * FROM service_configs WHERE status = 'active'").all(),
      );

    for (const svc of activeServices) {
      try {
        const def = getServiceDefinition(svc.serviceType);
        if (!def) continue;

        const existing = this.db
          .prepare('SELECT relative_path, file_type FROM tracked_files WHERE service_config_id = ?')
          .all(svc.id) as { relative_path: string; file_type: string }[];
        const existingPaths = new Set(existing.map((e) => e.relative_path));

        let newCount = 0;

        // Clean up tracked files whose parent path goes through a symlink
        for (const e of existing) {
          if (
            e.file_type !== 'symlink' &&
            (await parentPathHasSymlink(svc.localPath, e.relative_path))
          ) {
            this.db
              .prepare(
                'DELETE FROM tracked_files WHERE service_config_id = ? AND relative_path = ?',
              )
              .run(svc.id, e.relative_path);
            existingPaths.delete(e.relative_path);
          }
        }

        // Scan target service folder for new files
        const patterns = getServiceEnabledPatterns(this.db, svc.id, def.patterns);
        const svcIgnorePatterns = expandIgnorePatterns(
          getServiceEnabledIgnorePatterns(this.db, svc.id),
        );
        const targetEntries = await scanServiceFiles(svc.localPath, patterns, svcIgnorePatterns);
        for (const entry of targetEntries) {
          if (!existingPaths.has(entry.path)) {
            const fileId = uuid();
            this.db
              .prepare(
                'INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                fileId,
                svc.id,
                entry.path,
                entry.isSymlink ? 'symlink' : 'file',
                'pending_to_store',
              );
            existingPaths.add(entry.path);
            newCount++;
          }
        }

        // Scan store folder for new files
        const storeBase = getStoreBasePath(serviceToSyncTarget(svc));
        const storeEntries = await scanServiceFiles(storeBase, patterns, svcIgnorePatterns);
        for (const entry of storeEntries) {
          if (!existingPaths.has(entry.path)) {
            const fileId = uuid();
            this.db
              .prepare(
                'INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
              )
              .run(
                fileId,
                svc.id,
                entry.path,
                entry.isSymlink ? 'symlink' : 'file',
                'pending_to_target',
              );
            existingPaths.add(entry.path);
            newCount++;
          }
        }

        if (newCount > 0) {
          console.log(`Found ${newCount} new file(s) in service ${svc.name}`);
          this.broadcast({ type: 'files_changed', serviceId: svc.id });
        }
      } catch (err) {
        console.error(`Error scanning service ${svc.name} for new files:`, err);
      }
    }
  }

  private async copyEntry(src: string, dest: string, fileType: 'file' | 'symlink'): Promise<void> {
    await ensureDir(path.dirname(dest));
    if (fileType === 'symlink') {
      const target = await fs.readlink(src);
      // Remove destination if exists (file or symlink)
      try {
        await fs.unlink(dest);
      } catch {
        // May not exist
      }
      await fs.symlink(target, dest);
    } else {
      await fs.copyFile(src, dest);
    }
  }

  private autoCommitStore(message: string): void {
    // During post-pull sync, skip per-file commits — a single batch commit
    // is made at the end of syncAfterPull() to avoid noisy commit history
    if (this.pullSyncInProgress) return;

    const autoCommit = this.db
      .prepare("SELECT value FROM settings WHERE key = 'auto_commit_store'")
      .get() as { value: string } | undefined;

    if (autoCommit?.value === 'true') {
      queueStoreCommit(message);
    }
  }

  private logSync(repoId: string, filePath: string, action: string, details: string): void {
    this.db
      .prepare(
        'INSERT INTO sync_log (id, repo_id, file_path, action, details) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uuid(), repoId, filePath, action, details);
  }
}
