import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SyncEngine } from '../sync-engine.js';
import { initSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import type { TrackedFile, SyncTarget } from '../../types/index.js';
import { contentChecksum } from '../checksum.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock store-git module: control what "base" version git returns
// and prevent actual git commit/init operations
let mockBaseContent: string | null = null;

vi.mock('../store-git.js', () => ({
  queueStoreCommit: vi.fn(),
  ensureStoreCommitted: vi.fn().mockResolvedValue(undefined),
  getCommittedContent: vi.fn(async () => mockBaseContent),
  gitMergeFile: vi.fn(async (base: string, store: string, target: string) => {
    // Use real git merge-file via child_process
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-merge-'));
    const basePath = path.join(tmpDir, 'base');
    const storePath = path.join(tmpDir, 'store');
    const targetPath = path.join(tmpDir, 'target');

    try {
      await Promise.all([
        fs.writeFile(basePath, base, 'utf-8'),
        fs.writeFile(storePath, store, 'utf-8'),
        fs.writeFile(targetPath, target, 'utf-8'),
      ]);

      try {
        const { stdout } = await execFileAsync('git', [
          'merge-file',
          '--stdout',
          '-L',
          'store',
          '-L',
          'base',
          '-L',
          'target',
          storePath,
          basePath,
          targetPath,
        ]);
        return { content: stdout, hasConflicts: false };
      } catch (err: unknown) {
        const execErr = err as { code?: number; stdout?: string };
        if (execErr.code && execErr.code > 0 && execErr.stdout !== undefined) {
          return { content: execErr.stdout, hasConflicts: true };
        }
        throw err;
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }),
}));

// Mock file-watcher to avoid starting real chokidar watchers
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
    stopAll = vi.fn().mockResolvedValue(undefined);
  }
  return { FileWatcherService: MockFileWatcherService };
});

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let storeReposPath: string;
let targetRepoPath: string;
let db: Database.Database;
let engine: SyncEngine;
let broadcastedEvents: unknown[];

const REPO_ID = 'repo-1';
const REPO_NAME = 'test-project';
const STORE_PATH = 'repos/test-project';
const FILE_PATH = 'CLAUDE.md';

function makeTrackedFile(overrides: Partial<TrackedFile> = {}): TrackedFile {
  return {
    id: 'tf-1',
    repoId: REPO_ID,
    serviceConfigId: null,
    relativePath: FILE_PATH,
    fileType: 'file',
    storeChecksum: null,
    targetChecksum: null,
    storeMtime: null,
    targetMtime: null,
    syncStatus: 'synced',
    lastSyncedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRepo(): SyncTarget {
  return {
    id: REPO_ID,
    name: REPO_NAME,
    localPath: targetRepoPath,
    storePath: STORE_PATH,
    status: 'active',
    type: 'repo',
  };
}

async function writeStoreFile(content: string, relativePath = FILE_PATH) {
  const fullPath = path.join(storeReposPath, 'test-project', relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function writeTargetFile(content: string, relativePath = FILE_PATH) {
  const fullPath = path.join(targetRepoPath, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

async function readStoreFile(relativePath = FILE_PATH) {
  return fs.readFile(path.join(storeReposPath, 'test-project', relativePath), 'utf-8');
}

async function readTargetFile(relativePath = FILE_PATH) {
  return fs.readFile(path.join(targetRepoPath, relativePath), 'utf-8');
}

function getTrackedFile(): TrackedFile | undefined {
  const row = db.prepare('SELECT * FROM tracked_files WHERE id = ?').get('tf-1') as
    | Record<string, unknown>
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    repoId: row.repo_id as string | null,
    serviceConfigId: row.service_config_id as string | null,
    relativePath: row.relative_path as string,
    fileType: (row.file_type as 'file' | 'symlink') || 'file',
    storeChecksum: row.store_checksum as string | null,
    targetChecksum: row.target_checksum as string | null,
    storeMtime: row.store_mtime as string | null,
    targetMtime: row.target_mtime as string | null,
    syncStatus: row.sync_status as TrackedFile['syncStatus'],
    lastSyncedAt: row.last_synced_at as string | null,
    createdAt: row.created_at as string,
  };
}

function getConflicts() {
  return db.prepare("SELECT * FROM conflicts WHERE status = 'pending'").all() as Record<
    string,
    unknown
  >[];
}

function setBase(content: string | null) {
  mockBaseContent = content;
}

// ── Setup / Teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  // Create temp directories
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-test-'));
  storeReposPath = path.join(tmpDir, 'store', 'repos');
  targetRepoPath = path.join(tmpDir, 'target');
  await fs.mkdir(storeReposPath, { recursive: true });
  await fs.mkdir(path.join(storeReposPath, 'test-project'), { recursive: true });
  await fs.mkdir(targetRepoPath, { recursive: true });

  // Override config to use temp paths
  config.storePath = path.join(tmpDir, 'store');
  config.storeReposPath = storeReposPath;
  config.storeServicesPath = path.join(tmpDir, 'store', 'services');
  config.dataDir = path.join(tmpDir, 'store');

  // Set up in-memory DB
  db = new Database(':memory:');
  initSchema(db);

  // Insert test repo
  db.prepare(
    "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
  ).run(REPO_ID, REPO_NAME, targetRepoPath, STORE_PATH);

  // Insert settings
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('auto_commit_store', 'true')",
  ).run();

  // Reset mock base
  mockBaseContent = null;

  // Create engine and capture broadcasts
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SyncEngine.syncFile — Git-based 3-way merge', () => {
  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 1: Store modified, target untouched                       ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 1: syncs store→target when only store changed', async () => {
    setBase('Hello World');
    await writeStoreFile('Hello World\nNew line');
    await writeTargetFile('Hello World');

    const tf = makeTrackedFile({
      storeChecksum: contentChecksum('Hello World'),
      targetChecksum: contentChecksum('Hello World'),
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await readTargetFile();
    expect(targetContent).toBe('Hello World\nNew line');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 2: Target modified, store untouched                       ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 2: syncs target→store when only target changed', async () => {
    setBase('Hello World');
    await writeStoreFile('Hello World');
    await writeTargetFile('Hello World\nEdited in project');

    const tf = makeTrackedFile({
      storeChecksum: contentChecksum('Hello World'),
      targetChecksum: contentChecksum('Hello World'),
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const storeContent = await readStoreFile();
    expect(storeContent).toBe('Hello World\nEdited in project');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 3: Both modified, no overlap → auto-merge                 ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 3: auto-merges when both sides changed non-overlapping regions', async () => {
    setBase('Line 1\nLine 2\nLine 3\n');
    await writeStoreFile('Line 0\nLine 1\nLine 2\nLine 3\n');
    await writeTargetFile('Line 1\nLine 2\nLine 3\nLine 4\n');

    const tf = makeTrackedFile({
      storeChecksum: contentChecksum('Line 1\nLine 2\nLine 3\n'),
      targetChecksum: contentChecksum('Line 1\nLine 2\nLine 3\n'),
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const storeContent = await readStoreFile();
    const targetContent = await readTargetFile();
    expect(storeContent).toBe('Line 0\nLine 1\nLine 2\nLine 3\nLine 4\n');
    expect(targetContent).toBe(storeContent);

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);

    // Check sync_log for auto_merged action
    const logEntry = db.prepare("SELECT * FROM sync_log WHERE action = 'auto_merged'").get();
    expect(logEntry).toBeTruthy();
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 4: Both modified, overlapping → true conflict             ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 4: creates conflict when both sides changed overlapping regions', async () => {
    setBase('greeting = hello\n');
    await writeStoreFile('greeting = bonjour\n');
    await writeTargetFile('greeting = hola\n');

    const tf = makeTrackedFile({
      storeChecksum: contentChecksum('greeting = hello\n'),
      targetChecksum: contentChecksum('greeting = hello\n'),
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('conflict');

    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].base_content).toBe('greeting = hello\n');
    expect(conflicts[0].merged_content).toContain('<<<<<<<');
    expect(conflicts[0].merged_content).toContain('bonjour');
    expect(conflicts[0].merged_content).toContain('hola');
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 5: New file in store, target doesn't exist                ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 5: copies new store file to target', async () => {
    setBase(null); // no git history
    await writeStoreFile('New file content');
    // Target doesn't exist

    const tf = makeTrackedFile({ syncStatus: 'pending_to_target' });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES (?, ?, ?, 'pending_to_target')",
    ).run(tf.id, tf.repoId, tf.relativePath);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await readTargetFile();
    expect(targetContent).toBe('New file content');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 6: THE ORIGINAL BUG — New file created, synced, then      ║
  // ║  store modified                                                      ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 6: syncs without conflict when store modified after initial sync', async () => {
    // Step 1: Initial sync created an empty file in both sides
    setBase(''); // git committed the empty content after first sync
    await writeStoreFile('New content added');
    await writeTargetFile(''); // untouched since initial sync

    const emptyChecksum = contentChecksum('');
    const tf = makeTrackedFile({
      storeChecksum: emptyChecksum,
      targetChecksum: emptyChecksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    // Target should receive the new content — NO conflict
    const targetContent = await readTargetFile();
    expect(targetContent).toBe('New content added');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 7: File deleted from target (previously synced)           ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 7: creates delete conflict when target removed', async () => {
    await writeStoreFile('Some content');
    // Target file doesn't exist (was deleted)

    const checksum = contentChecksum('Some content');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('missing_in_target');

    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(1);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 8: File deleted from store (previously synced)            ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 8: creates delete conflict when store removed', async () => {
    // Store file doesn't exist (was deleted)
    await writeTargetFile('Some content');

    const checksum = contentChecksum('Some content');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('missing_in_store');

    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(1);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 9: Both identical but different from DB checksum          ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 9: marks synced when both sides are identical', async () => {
    await writeStoreFile('New content');
    await writeTargetFile('New content');

    const oldChecksum = contentChecksum('Old content');
    const tf = makeTrackedFile({
      storeChecksum: oldChecksum,
      targetChecksum: oldChecksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(updated.storeChecksum).toBe(contentChecksum('New content'));
    expect(updated.targetChecksum).toBe(contentChecksum('New content'));
    expect(getConflicts()).toHaveLength(0);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 10: Both deleted                                          ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 10: removes tracking when both files are deleted', async () => {
    // Neither store nor target file exists
    const tf = makeTrackedFile({
      storeChecksum: contentChecksum('Some content'),
      targetChecksum: contentChecksum('Some content'),
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile();
    expect(updated).toBeUndefined(); // tracking record removed
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 11: First-ever sync, no git history                       ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 11: falls back to checksum-based detection when no git history', async () => {
    setBase(null); // no git history
    await writeStoreFile('Template content');
    await writeTargetFile('Existing project content');

    // No prior checksums — both are new
    const tf = makeTrackedFile();
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES (?, ?, ?, 'pending_to_target')",
    ).run(tf.id, tf.repoId, tf.relativePath);

    await engine.syncFile(tf, makeRepo());

    // Store wins for first sync when both changed (fallback behavior)
    const targetContent = await readTargetFile();
    expect(targetContent).toBe('Template content');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 12: Multiple rapid edits in store before sync             ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 12: syncs latest store version after multiple edits', async () => {
    setBase('Version 1');
    await writeStoreFile('Version 4'); // edited 3 times
    await writeTargetFile('Version 1'); // untouched

    const checksum = contentChecksum('Version 1');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await readTargetFile();
    expect(targetContent).toBe('Version 4');
    expect(getConflicts()).toHaveLength(0);
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Additional edge cases                                              ║
  // ╚═══════════════════════════════════════════════════════════════════════╝

  it('Edge case: new file in target, store does not exist', async () => {
    setBase(null);
    // Store doesn't exist
    await writeTargetFile('Brand new file in target');

    const tf = makeTrackedFile({ syncStatus: 'pending_to_store' });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES (?, ?, ?, 'pending_to_store')",
    ).run(tf.id, tf.repoId, tf.relativePath);

    await engine.syncFile(tf, makeRepo());

    const storeContent = await readStoreFile();
    expect(storeContent).toBe('Brand new file in target');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
  });

  it('Edge case: auto-merge with additions in different parts of the file', async () => {
    const base = [
      '# CLAUDE.md',
      '',
      '## Section A',
      'Content A',
      '',
      '## Section B',
      'Content B',
      '',
      '## Section C',
      'Content C',
      '',
    ].join('\n');

    const store = [
      '# CLAUDE.md',
      '',
      '## Section A',
      'Content A - updated in store',
      '',
      '## Section B',
      'Content B',
      '',
      '## Section C',
      'Content C',
      '',
    ].join('\n');

    const target = [
      '# CLAUDE.md',
      '',
      '## Section A',
      'Content A',
      '',
      '## Section B',
      'Content B',
      '',
      '## Section C',
      'Content C - updated in target',
      '',
    ].join('\n');

    setBase(base);
    await writeStoreFile(store);
    await writeTargetFile(target);

    const checksum = contentChecksum(base);
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const result = await readStoreFile();
    expect(result).toContain('Content A - updated in store');
    expect(result).toContain('Content C - updated in target');
    expect(result).not.toContain('<<<<<<<');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);
  });

  it('Edge case: existing conflict is not duplicated on re-sync', async () => {
    setBase('greeting = hello\n');
    await writeStoreFile('greeting = bonjour\n');
    await writeTargetFile('greeting = hola\n');

    const checksum = contentChecksum('greeting = hello\n');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    // First sync — creates conflict
    await engine.syncFile(tf, makeRepo());
    expect(getConflicts()).toHaveLength(1);

    // Second sync — should NOT create another conflict
    const updatedTf = getTrackedFile()!;
    await engine.syncFile(updatedTf, makeRepo());
    expect(getConflicts()).toHaveLength(1); // still just one

    // Check we got a conflict_updated event on second sync
    const updateEvents = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'conflict_updated',
    );
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('Edge case: auto-clear conflict when files become identical', async () => {
    // Set up a pending conflict first
    const checksum = contentChecksum('content');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'conflict',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'conflict', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    db.prepare(
      "INSERT INTO conflicts (id, tracked_file_id, store_content, target_content, store_checksum, target_checksum, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')",
    ).run('c-1', tf.id, 'old-store', 'old-target', checksum, checksum);

    // Now both files are identical
    await writeStoreFile('resolved content');
    await writeTargetFile('resolved content');

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');

    // Conflict should be auto-resolved
    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(0);

    const resolvedConflict = db
      .prepare('SELECT * FROM conflicts WHERE id = ?')
      .get('c-1') as Record<string, unknown>;
    expect(resolvedConflict.status).toBe('resolved_auto');
  });

  it('Edge case: store file with content, target empty, never synced → copy store to target', async () => {
    setBase(null);
    await writeStoreFile('Meaningful content');
    // Target doesn't exist

    const tf = makeTrackedFile({ syncStatus: 'pending_to_target' });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES (?, ?, ?, 'pending_to_target')",
    ).run(tf.id, tf.repoId, tf.relativePath);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await readTargetFile();
    expect(targetContent).toBe('Meaningful content');
  });

  it('Edge case: both files changed to same content independently → synced (fast path)', async () => {
    await writeStoreFile('Same new content');
    await writeTargetFile('Same new content');

    const oldChecksum = contentChecksum('Old content');
    const tf = makeTrackedFile({
      storeChecksum: oldChecksum,
      targetChecksum: oldChecksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);
    // Should NOT even call getCommittedContent (fast path)
    const { getCommittedContent: mockGCC } = await import('../store-git.js');
    expect(mockGCC).not.toHaveBeenCalled();
  });

  it('Edge case: nested file path (e.g., .cursor/settings.json)', async () => {
    const nestedPath = '.cursor/settings.json';
    setBase('{"old": true}');
    await writeStoreFile('{"new": true}', nestedPath);
    await writeTargetFile('{"old": true}', nestedPath);

    const checksum = contentChecksum('{"old": true}');
    const tf = makeTrackedFile({
      relativePath: nestedPath,
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, nestedPath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await fs.readFile(path.join(targetRepoPath, nestedPath), 'utf-8');
    expect(targetContent).toBe('{"new": true}');
    expect(getConflicts()).toHaveLength(0);
  });

  it('Edge case: large multi-section auto-merge', async () => {
    const sections = Array.from({ length: 10 }, (_, i) => `## Section ${i}\nContent ${i}\n`);
    const base = sections.join('\n');

    // Store modifies section 2
    const storeSections = [...sections];
    storeSections[2] = '## Section 2\nModified in store\n';
    const store = storeSections.join('\n');

    // Target modifies section 8
    const targetSections = [...sections];
    targetSections[8] = '## Section 8\nModified in target\n';
    const target = targetSections.join('\n');

    setBase(base);
    await writeStoreFile(store);
    await writeTargetFile(target);

    const checksum = contentChecksum(base);
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const result = await readStoreFile();
    expect(result).toContain('Modified in store');
    expect(result).toContain('Modified in target');
    expect(result).not.toContain('<<<<<<<');

    const updated = getTrackedFile()!;
    expect(updated.syncStatus).toBe('synced');
  });

  it('Edge case: conflict includes base_content and merged_content', async () => {
    setBase('line = original\n');
    await writeStoreFile('line = from store\n');
    await writeTargetFile('line = from target\n');

    const checksum = contentChecksum('line = original\n');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    await engine.syncFile(tf, makeRepo());

    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(1);

    const conflict = conflicts[0];
    // base_content should be the git base
    expect(conflict.base_content).toBe('line = original\n');
    // merged_content should have conflict markers
    expect(conflict.merged_content).toContain('<<<<<<<');
    expect(conflict.merged_content).toContain('from store');
    expect(conflict.merged_content).toContain('from target');
    // store/target content should be captured
    expect(conflict.store_content).toBe('line = from store\n');
    expect(conflict.target_content).toBe('line = from target\n');
  });

  it('Edge case: WebSocket broadcasts correct event types', async () => {
    setBase('Hello World');
    await writeStoreFile('Hello World - updated');
    await writeTargetFile('Hello World');

    const checksum = contentChecksum('Hello World');
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    broadcastedEvents = [];
    await engine.syncFile(tf, makeRepo());

    const syncEvents = broadcastedEvents.filter(
      (e: unknown) => (e as { type: string }).type === 'sync_status',
    );
    expect(syncEvents).toHaveLength(1);
    expect((syncEvents[0] as { status: string }).status).toBe('synced');
  });

  // ╔═══════════════════════════════════════════════════════════════════════╗
  // ║  Scenario 13: Store delete → target modify → store recreate         ║
  // ║  (step-by-step, watcher fires after each change)                    ║
  // ╚═══════════════════════════════════════════════════════════════════════╝
  it('Scenario 13a: store delete then recreate (step-by-step sync)', async () => {
    const originalContent = 'Original content';
    const checksum = contentChecksum(originalContent);

    // Step 0: Both synced with "Original content"
    await writeStoreFile(originalContent);
    await writeTargetFile(originalContent);
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    // Step 1: Store removes file.md → sync fires
    await fs.unlink(path.join(storeReposPath, 'test-project', FILE_PATH));
    let currentTf = getTrackedFile()!;
    await engine.syncFile(currentTf, makeRepo());

    // Should create a delete-vs-exists conflict (missing_in_store)
    currentTf = getTrackedFile()!;
    expect(currentTf.syncStatus).toBe('missing_in_store');
    expect(getConflicts()).toHaveLength(1);

    // Step 2: Target modifies file.md → sync fires, but conflict already exists
    await writeTargetFile('Modified in target');
    currentTf = getTrackedFile()!;
    // syncFile won't re-enter "both exist" because store doesn't exist yet
    // It hits !storeExists && targetExists with storeDeleted=true, but conflict already exists
    await engine.syncFile(currentTf, makeRepo());
    expect(getConflicts()).toHaveLength(1); // still one conflict, not duplicated

    // Step 3: Store adds a NEW file.md with new content → sync fires
    await writeStoreFile('Brand new store content');
    currentTf = getTrackedFile()!;
    // Now both exist again — enters "Both exist" branch
    // git base might be the old version or null depending on store git state
    setBase(originalContent); // git would have the last committed version
    await engine.syncFile(currentTf, makeRepo());

    // Both files differ from base → attempts 3-way merge
    // "Brand new store content" vs "Modified in target" with base "Original content"
    // These are completely different — git merge-file will produce a conflict
    currentTf = getTrackedFile()!;

    // BUG FIX: sync_status must be updated from 'missing_in_store' to 'conflict'
    // so the sidebar shows "Conflict" instead of "Store Removed"
    expect(currentTf.syncStatus).toBe('conflict');

    // The old pending conflict is reused (not duplicated) with updated content
    const conflicts = getConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].store_content).toBe('Brand new store content');
    expect(conflicts[0].target_content).toBe('Modified in target');
    expect(conflicts[0].base_content).toBe(originalContent);
  });

  it('Scenario 13b: store delete + target modify + store recreate (all before sync)', async () => {
    const originalContent = 'Original content';
    const checksum = contentChecksum(originalContent);

    // Initial synced state
    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    // All changes happen before sync runs:
    // Store: deleted then recreated with new content
    // Target: modified
    await writeStoreFile('Brand new store content');
    await writeTargetFile('Modified in target');
    setBase(originalContent);

    await engine.syncFile(tf, makeRepo());

    // Both exist, both differ from base → 3-way merge attempted
    // "Brand new store content" vs "Modified in target" (base: "Original content")
    // These are completely unrelated changes — git merge-file will have conflicts
    const currentTf = getTrackedFile()!;
    const conflicts = getConflicts();

    // Since the content is completely different, it should be a conflict
    expect(currentTf.syncStatus).toBe('conflict');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].base_content).toBe(originalContent);
    expect(conflicts[0].store_content).toBe('Brand new store content');
    expect(conflicts[0].target_content).toBe('Modified in target');
  });

  it('Scenario 13c: store delete + recreate with compatible changes → auto-merge', async () => {
    const originalContent = 'Line 1\nLine 2\nLine 3\n';
    const checksum = contentChecksum(originalContent);

    const tf = makeTrackedFile({
      storeChecksum: checksum,
      targetChecksum: checksum,
      lastSyncedAt: new Date().toISOString(),
      syncStatus: 'synced',
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, sync_status, last_synced_at) VALUES (?, ?, ?, ?, ?, 'synced', ?)",
    ).run(tf.id, tf.repoId, tf.relativePath, tf.storeChecksum, tf.targetChecksum, tf.lastSyncedAt);

    // Store deleted then recreated with a change at the top
    // Target modified at the bottom
    await writeStoreFile('Line 0\nLine 1\nLine 2\nLine 3\n');
    await writeTargetFile('Line 1\nLine 2\nLine 3\nLine 4\n');
    setBase(originalContent);

    await engine.syncFile(tf, makeRepo());

    // Non-overlapping changes → auto-merge should succeed
    const currentTf = getTrackedFile()!;
    expect(currentTf.syncStatus).toBe('synced');
    expect(getConflicts()).toHaveLength(0);

    const storeResult = await readStoreFile();
    const targetResult = await readTargetFile();
    expect(storeResult).toBe('Line 0\nLine 1\nLine 2\nLine 3\nLine 4\n');
    expect(targetResult).toBe(storeResult);
  });

  it('Edge case: delete target when not previously synced → copy store to target', async () => {
    await writeStoreFile('Store content');
    // Target doesn't exist and never synced

    const tf = makeTrackedFile({
      storeChecksum: null,
      targetChecksum: null,
      lastSyncedAt: null,
    });
    db.prepare(
      "INSERT INTO tracked_files (id, repo_id, relative_path, sync_status) VALUES (?, ?, ?, 'pending_to_target')",
    ).run(tf.id, tf.repoId, tf.relativePath);

    await engine.syncFile(tf, makeRepo());

    const targetContent = await readTargetFile();
    expect(targetContent).toBe('Store content');
    expect(getConflicts()).toHaveLength(0);
  });
});
