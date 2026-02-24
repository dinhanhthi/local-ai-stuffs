import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SyncEngine } from '../sync-engine.js';
import { initSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import {
  getDirectorySize,
  getFileSizes,
  getSyncBlockThreshold,
  DEFAULT_BLOCK_THRESHOLD_MB,
  MB,
} from '../size-calculator.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

vi.mock('../store-git.js', () => ({
  queueStoreCommit: vi.fn(),
  ensureStoreCommitted: vi.fn().mockResolvedValue([]),
  getCommittedContent: vi.fn(async () => null),
  getHeadCommitHash: vi.fn().mockResolvedValue('mock-head-hash'),
  gitMergeFile: vi.fn(async () => ({ content: '', hasConflicts: false })),
}));

vi.mock('../file-watcher.js', async () => {
  const { EventEmitter } = await import('node:events');
  class MockFileWatcherService extends EventEmitter {
    markSelfChange = vi.fn();
    startStoreWatcher = vi.fn().mockResolvedValue(undefined);
    startTargetWatcher = vi.fn().mockResolvedValue(undefined);
    stopTargetWatcher = vi.fn().mockResolvedValue(undefined);
    startServiceStoreWatcher = vi.fn().mockResolvedValue(undefined);
    startServiceTargetWatcher = vi.fn().mockResolvedValue(undefined);
    stopServiceTargetWatcher = vi.fn().mockResolvedValue(undefined);
    clearStoreDebounceTimers = vi.fn();
    stopAll = vi.fn().mockResolvedValue(undefined);
  }
  return { FileWatcherService: MockFileWatcherService };
});

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let storeReposPath: string;
let storeServicesPath: string;
let targetRepoPath: string;
let db: Database.Database;
let engine: SyncEngine;
let broadcastedEvents: unknown[];

const REPO_ID = 'repo-1';
const REPO_NAME = 'test-project';
const STORE_PATH = 'repos/test-project';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'size-threshold-test-'));
  storeReposPath = path.join(tmpDir, 'store', 'repos');
  storeServicesPath = path.join(tmpDir, 'store', 'services');
  targetRepoPath = path.join(tmpDir, 'target');
  await fs.mkdir(storeReposPath, { recursive: true });
  await fs.mkdir(path.join(storeReposPath, 'test-project'), { recursive: true });
  await fs.mkdir(storeServicesPath, { recursive: true });
  await fs.mkdir(targetRepoPath, { recursive: true });

  config.storePath = path.join(tmpDir, 'store');
  config.storeReposPath = storeReposPath;
  config.storeServicesPath = storeServicesPath;
  config.dataDir = path.join(tmpDir, 'store');

  db = new Database(':memory:');
  initSchema(db);

  db.prepare(
    "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
  ).run(REPO_ID, REPO_NAME, targetRepoPath, STORE_PATH);

  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_commit_store', 'true')",
  ).run();

  engine = new SyncEngine(db);
  broadcastedEvents = [];
  const mockClient = {
    send: (data: string) => {
      broadcastedEvents.push(JSON.parse(data));
    },
  };
  engine.registerWsClient(mockClient);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  db.close();
  vi.clearAllMocks();
});

// ── Size Calculator Tests ─────────────────────────────────────────────────

describe('getDirectorySize', () => {
  it('returns 0 for non-existent directory', async () => {
    const size = await getDirectorySize('/this/path/does/not/exist');
    expect(size).toBe(0);
  });

  it('returns 0 for empty directory', async () => {
    const emptyDir = path.join(tmpDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });
    const size = await getDirectorySize(emptyDir);
    expect(size).toBe(0);
  });

  it('sums file sizes recursively', async () => {
    const dir = path.join(tmpDir, 'sized');
    await fs.mkdir(path.join(dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello'); // 5 bytes
    await fs.writeFile(path.join(dir, 'sub', 'b.txt'), 'world!'); // 6 bytes
    const size = await getDirectorySize(dir);
    expect(size).toBe(11);
  });

  it('ignores symlinks', async () => {
    const dir = path.join(tmpDir, 'withlink');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'real.txt'), 'data'); // 4 bytes
    await fs.symlink(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    const size = await getDirectorySize(dir);
    expect(size).toBe(4); // only real file counted
  });
});

describe('getFileSizes', () => {
  it('returns sizes for existing files', async () => {
    const base = path.join(tmpDir, 'base');
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, 'a.md'), '12345'); // 5 bytes
    await fs.writeFile(path.join(base, 'b.md'), '12'); // 2 bytes

    const sizes = await getFileSizes(base, ['a.md', 'b.md']);
    expect(sizes.get('a.md')).toBe(5);
    expect(sizes.get('b.md')).toBe(2);
  });

  it('returns 0 for missing files', async () => {
    const base = path.join(tmpDir, 'base2');
    await fs.mkdir(base, { recursive: true });

    const sizes = await getFileSizes(base, ['missing.md']);
    expect(sizes.get('missing.md')).toBe(0);
  });
});

// ── getSyncBlockThreshold Tests ─────────────────────────────────────────────

describe('getSyncBlockThreshold', () => {
  it('returns default 100 MB when no setting exists', () => {
    // Remove the setting if seeded
    db.prepare("DELETE FROM settings WHERE key = 'size_blocked_mb'").run();
    const threshold = getSyncBlockThreshold(db);
    expect(threshold).toBe(DEFAULT_BLOCK_THRESHOLD_MB * MB);
  });

  it('reads custom threshold from DB settings', () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '50')",
    ).run();
    const threshold = getSyncBlockThreshold(db);
    expect(threshold).toBe(50 * MB);
  });

  it('falls back to default for invalid values', () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '0')",
    ).run();
    const threshold = getSyncBlockThreshold(db);
    expect(threshold).toBe(DEFAULT_BLOCK_THRESHOLD_MB * MB);
  });

  it('falls back to default for negative values', () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '-10')",
    ).run();
    const threshold = getSyncBlockThreshold(db);
    expect(threshold).toBe(DEFAULT_BLOCK_THRESHOLD_MB * MB);
  });

  it('handles non-numeric values gracefully', () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', 'abc')",
    ).run();
    const threshold = getSyncBlockThreshold(db);
    expect(threshold).toBe(DEFAULT_BLOCK_THRESHOLD_MB * MB); // NaN > 0 is false → default
  });
});

// ── Default settings seeding ────────────────────────────────────────────────

describe('Default size threshold settings', () => {
  it('seeds default size_warning_mb setting', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'size_warning_mb'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe('20');
  });

  it('seeds default size_danger_mb setting', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'size_danger_mb'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe('50');
  });

  it('seeds default size_blocked_mb setting', () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'size_blocked_mb'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe('100');
  });
});

// ── Sync blocking with custom thresholds ────────────────────────────────────

describe('SyncEngine respects custom block threshold', () => {
  async function writeStoreFile(content: string, relativePath = 'CLAUDE.md') {
    const fullPath = path.join(storeReposPath, 'test-project', relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  async function writeTargetFile(content: string, relativePath = 'CLAUDE.md') {
    const fullPath = path.join(targetRepoPath, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
  }

  it('blocks sync when store size exceeds default threshold', async () => {
    // Write a large file (> 100 MB equivalent — we lower threshold instead)
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '0.00001')",
    ).run();
    // 0.00001 MB ≈ 10 bytes — any real file will exceed this

    await writeStoreFile('Some file content that will exceed the tiny threshold');
    await writeTargetFile('Some file content that will exceed the tiny threshold');

    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES ('tf-1', ?, ?, 'synced')",
    ).run(REPO_ID, 'CLAUDE.md');

    const result = await engine.syncRepo(REPO_ID);
    expect(result).toEqual({ synced: 0, conflicts: 0, errors: 0 });

    // Should broadcast sync_blocked event
    const blockedEvents = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'sync_blocked',
    );
    expect(blockedEvents).toHaveLength(1);
    expect((blockedEvents[0] as { repoId: string }).repoId).toBe(REPO_ID);
  });

  it('allows sync when store size is below threshold', async () => {
    // Set a high threshold (999 MB)
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '999')",
    ).run();

    await writeStoreFile('Small content');
    await writeTargetFile('Small content');

    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status) VALUES ('tf-1', ?, ?, 'abc', 'abc', 'synced')",
    ).run(REPO_ID, 'CLAUDE.md');

    const _result = await engine.syncRepo(REPO_ID);
    // Should not be blocked
    const blockedEvents = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'sync_blocked',
    );
    expect(blockedEvents).toHaveLength(0);
  });

  it('uses updated threshold after setting change', async () => {
    await writeStoreFile('Test content');
    await writeTargetFile('Test content');

    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES ('tf-1', ?, ?, 'synced')",
    ).run(REPO_ID, 'CLAUDE.md');

    // First: high threshold — sync works
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '999')",
    ).run();
    const _result1 = await engine.syncRepo(REPO_ID);
    const blocked1 = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'sync_blocked',
    );
    expect(blocked1).toHaveLength(0);

    // Second: tiny threshold — sync blocked
    broadcastedEvents = [];
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '0.00001')",
    ).run();
    const result2 = await engine.syncRepo(REPO_ID);
    expect(result2).toEqual({ synced: 0, conflicts: 0, errors: 0 });

    const blocked2 = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'sync_blocked',
    );
    expect(blocked2).toHaveLength(1);
  });

  it('broadcast message includes dynamic limit in reason', async () => {
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('size_blocked_mb', '0.00001')",
    ).run();

    await writeStoreFile('Content that is long enough to exceed the tiny threshold value');
    await writeTargetFile('Content that is long enough to exceed the tiny threshold value');

    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES ('tf-1', ?, ?, 'synced')",
    ).run(REPO_ID, 'CLAUDE.md');

    await engine.syncRepo(REPO_ID);

    const blockedEvent = broadcastedEvents.find(
      (e: unknown) => (e as { type: string }).type === 'sync_blocked',
    ) as { reason: string } | undefined;
    expect(blockedEvent).toBeDefined();
    // Reason should NOT say "100 MB" — it should use the custom limit
    expect(blockedEvent!.reason).not.toContain('100 MB');
  });
});
