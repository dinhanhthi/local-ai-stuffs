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
  getCommittedContent,
  getCommittedContentAt,
  ensureStoreCommitted,
  gitMergeFile,
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

export class SyncEngine {
  private db: Database.Database;
  private watcher: FileWatcherService;
  private pollingTimer: NodeJS.Timeout | null = null;
  private wsClients: Set<{ send: (data: string) => void }> = new Set();
  private ignoreMatcherCache = new Map<string, picomatch.Matcher>();
  private lastLogCleanup = 0;
  private sizeBlockLoggedAt = new Map<string, number>();
  private baseCommitOverride: string | null = null;

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
        await this.scanAllReposForNewFiles();
        await this.scanAllServicesForNewFiles();
        await this.syncAllRepos();
        await this.syncAllServices();
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

  private async handleStoreChange(storeRelative: string): Promise<void> {
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
      // Already in sync — update checksums/mtime and clear any stale conflicts
      const checksum = contentChecksum(storeContent);
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
      // Commit store so git base stays current
      if (changed) {
        this.autoCommitStore(`Sync ${trackedFile.relativePath}`);
      }
      return;
    }

    // Files differ — use git 3-way merge to determine direction
    // Ensure store git is committed so HEAD reflects latest state
    // (prevents false conflicts when a prior autoCommitStore silently failed)
    await ensureStoreCommitted();
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
   * Run a full sync pass using a specific commit as the base reference.
   * Used after git pull to correctly detect which side changed:
   * the pre-pull HEAD is the correct base, not the post-pull HEAD.
   */
  async syncAfterPull(prePullCommitHash: string): Promise<void> {
    this.baseCommitOverride = prePullCommitHash;
    try {
      await this.syncAllRepos();
      await this.syncAllServices();
    } finally {
      this.baseCommitOverride = null;
    }
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
