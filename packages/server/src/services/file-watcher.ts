import { watch, type FSWatcher } from 'chokidar';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import {
  expandIgnorePatterns,
  getIgnorePatterns,
  getRepoEnabledFilePatterns,
  getRepoIgnorePatterns,
} from '../db/index.js';
import { EventEmitter } from 'node:events';

export interface WatcherEvents {
  storeChange: (relativePath: string) => void;
  targetChange: (repoId: string, relativePath: string) => void;
  serviceStoreChange: (relativePath: string) => void;
  serviceTargetChange: (serviceId: string, relativePath: string) => void;
}

export class FileWatcherService extends EventEmitter {
  private storeWatcher: FSWatcher | null = null;
  private serviceStoreWatcher: FSWatcher | null = null;
  private targetWatchers = new Map<string, FSWatcher>();
  private serviceTargetWatchers = new Map<string, FSWatcher>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private selfChanges = new Map<string, number>(); // path -> expiry timestamp
  private selfChangesCleanupTimer: NodeJS.Timeout | null = null;
  private db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
    // Periodically clean up expired selfChanges entries to prevent memory leaks
    this.selfChangesCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, expiry] of this.selfChanges) {
        if (now > expiry) this.selfChanges.delete(key);
      }
    }, 60_000);
  }

  /**
   * Mark a path as a self-change (written by sync engine).
   * File watcher will ignore events for this path until TTL expires.
   */
  markSelfChange(absolutePath: string): void {
    this.selfChanges.set(absolutePath, Date.now() + config.selfChangeGuardTtlMs);
  }

  private isSelfChange(absolutePath: string): boolean {
    const expiry = this.selfChanges.get(absolutePath);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.selfChanges.delete(absolutePath);
      return false;
    }
    return true;
  }

  /**
   * Clear all pending debounce timers for store-related changes.
   * Used after syncAfterPull to prevent stale watcher events from
   * firing with incorrect base references.
   */
  clearStoreDebounceTimers(): void {
    this.clearDebounceTimersForPrefix('store:');
    this.clearDebounceTimersForPrefix('serviceStore:');
  }

  private clearDebounceTimersForPrefix(prefix: string): void {
    for (const [key, timer] of this.debounceTimers) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
    }
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        fn();
      }, config.watchDebounceMs),
    );
  }

  async startStoreWatcher(): Promise<void> {
    if (this.storeWatcher) return;

    const patterns = this.getEnabledPatterns();
    const ignorePatterns = expandIgnorePatterns(getIgnorePatterns(this.db));
    const watchGlobs = patterns.map((p) => `${config.storeReposPath}/**/${p}`);

    this.storeWatcher = watch(watchGlobs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
      ignored: ignorePatterns,
    });

    this.storeWatcher.on('all', (event, filePath) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
      if (this.isSelfChange(filePath)) return;

      // Extract the relative path within store/repos/
      const relative = filePath.slice(config.storeReposPath.length + 1);
      this.debounce(`store:${relative}`, () => {
        this.emit('storeChange', relative);
      });
    });
  }

  async startTargetWatcher(repoId: string, repoPath: string): Promise<void> {
    if (this.targetWatchers.has(repoId)) return;

    const patterns = getRepoEnabledFilePatterns(this.db, repoId);
    const ignorePatterns = expandIgnorePatterns(getRepoIgnorePatterns(this.db, repoId));
    const watchGlobs = patterns.map((p) => `${repoPath}/${p}`);

    const watcher = watch(watchGlobs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
      ignored: ignorePatterns,
      followSymlinks: false,
    });

    watcher.on('all', (event, filePath) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
      if (this.isSelfChange(filePath)) return;

      const relative = filePath.slice(repoPath.length + 1);
      this.debounce(`target:${repoId}:${relative}`, () => {
        this.emit('targetChange', repoId, relative);
      });
    });

    this.targetWatchers.set(repoId, watcher);
  }

  async stopTargetWatcher(repoId: string): Promise<void> {
    const watcher = this.targetWatchers.get(repoId);
    if (watcher) {
      await watcher.close();
      this.targetWatchers.delete(repoId);
      this.clearDebounceTimersForPrefix(`target:${repoId}:`);
    }
  }

  async startServiceStoreWatcher(): Promise<void> {
    if (this.serviceStoreWatcher) return;
    if (!config.storeServicesPath) return;

    // Watch everything under services/ directory
    this.serviceStoreWatcher = watch(`${config.storeServicesPath}/**/*`, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
      ignored: ['.DS_Store', '**/.DS_Store'],
    });

    this.serviceStoreWatcher.on('all', (event, filePath) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
      if (this.isSelfChange(filePath)) return;

      const relative = filePath.slice(config.storeServicesPath.length + 1);
      this.debounce(`serviceStore:${relative}`, () => {
        this.emit('serviceStoreChange', relative);
      });
    });
  }

  async startServiceTargetWatcher(
    serviceId: string,
    servicePath: string,
    patterns: string[],
    ignorePatterns: string[] = [],
  ): Promise<void> {
    if (this.serviceTargetWatchers.has(serviceId)) return;

    const watchGlobs = patterns.map((p) => `${servicePath}/${p}`);

    const watcher = watch(watchGlobs, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200 },
      ignored: ['.DS_Store', '**/.DS_Store', ...ignorePatterns],
      followSymlinks: false,
    });

    watcher.on('all', (event, filePath) => {
      if (event !== 'add' && event !== 'change' && event !== 'unlink') return;
      if (this.isSelfChange(filePath)) return;

      const relative = filePath.slice(servicePath.length + 1);
      this.debounce(`serviceTarget:${serviceId}:${relative}`, () => {
        this.emit('serviceTargetChange', serviceId, relative);
      });
    });

    this.serviceTargetWatchers.set(serviceId, watcher);
  }

  async stopServiceTargetWatcher(serviceId: string): Promise<void> {
    const watcher = this.serviceTargetWatchers.get(serviceId);
    if (watcher) {
      await watcher.close();
      this.serviceTargetWatchers.delete(serviceId);
      this.clearDebounceTimersForPrefix(`serviceTarget:${serviceId}:`);
    }
  }

  async stopAll(): Promise<void> {
    if (this.selfChangesCleanupTimer) {
      clearInterval(this.selfChangesCleanupTimer);
      this.selfChangesCleanupTimer = null;
    }

    if (this.storeWatcher) {
      await this.storeWatcher.close();
      this.storeWatcher = null;
    }

    if (this.serviceStoreWatcher) {
      await this.serviceStoreWatcher.close();
      this.serviceStoreWatcher = null;
    }

    for (const [, watcher] of this.targetWatchers) {
      await watcher.close();
    }
    this.targetWatchers.clear();

    for (const [, watcher] of this.serviceTargetWatchers) {
      await watcher.close();
    }
    this.serviceTargetWatchers.clear();

    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.selfChanges.clear();
  }

  private getEnabledPatterns(): string[] {
    const rows = this.db.prepare('SELECT pattern FROM file_patterns WHERE enabled = 1').all() as {
      pattern: string;
    }[];
    return rows.map((r) => r.pattern);
  }
}
