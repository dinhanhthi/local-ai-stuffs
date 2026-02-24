import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';
import { config } from '../../config.js';

import {
  readSyncSettingsFile,
  writeSyncSettingsFile,
  exportSettingsToFile,
  restoreSettingsFromFile,
  restoreOrMigrateSettings,
  syncSettingsUpdateGlobal,
  syncSettingsUpdateFilePatterns,
  syncSettingsUpdateIgnorePatterns,
  syncSettingsUpdateRepo,
  syncSettingsUpdateService,
  syncSettingsRemoveRepo,
  syncSettingsRemoveService,
  applyOverridesForRepo,
  applyOverridesForService,
} from '../sync-settings.js';
import type { SyncSettingsFile } from '../sync-settings.js';

let tmpDir: string;
let db: Database.Database;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sync-settings-test-'));
  config.storePath = tmpDir;

  db = new Database(':memory:');
  initSchema(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function syncSettingsPath(): string {
  return path.join(tmpDir, 'sync-settings.json');
}

function readJsonFile(): SyncSettingsFile {
  return JSON.parse(fsSync.readFileSync(syncSettingsPath(), 'utf-8'));
}

function insertRepo(id: string, storePath: string, localPath = '/tmp/repo'): void {
  db.prepare(
    "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
  ).run(id, storePath.replace('repos/', ''), localPath, storePath);
}

function insertService(id: string, storePath: string, localPath = '/tmp/service'): void {
  db.prepare(
    "INSERT INTO service_configs (id, service_type, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
  ).run(id, storePath.replace('services/', ''), 'Test Service', localPath, storePath);
}

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  readSyncSettingsFile / writeSyncSettingsFile                        ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('readSyncSettingsFile / writeSyncSettingsFile', () => {
  it('returns empty structure when file does not exist', () => {
    const data = readSyncSettingsFile();
    expect(data).toEqual({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });
  });

  it('reads a valid sync-settings.json', () => {
    const content: SyncSettingsFile = {
      settings: { size_warning_mb: '10' },
      filePatterns: [{ pattern: 'CLAUDE.md', enabled: true }],
      ignorePatterns: [{ pattern: '.DS_Store', enabled: true }],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(content), 'utf-8');

    const data = readSyncSettingsFile();
    expect(data.settings.size_warning_mb).toBe('10');
    expect(data.filePatterns).toHaveLength(1);
    expect(data.filePatterns[0].pattern).toBe('CLAUDE.md');
  });

  it('handles corrupt JSON gracefully', () => {
    fsSync.writeFileSync(syncSettingsPath(), '{ broken json!!!', 'utf-8');
    const data = readSyncSettingsFile();
    expect(data).toEqual({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });
  });

  it('handles missing fields gracefully', () => {
    fsSync.writeFileSync(
      syncSettingsPath(),
      JSON.stringify({ settings: { auto_sync: 'false' } }),
      'utf-8',
    );
    const data = readSyncSettingsFile();
    expect(data.settings.auto_sync).toBe('false');
    expect(data.filePatterns).toEqual([]);
    expect(data.ignorePatterns).toEqual([]);
    expect(data.repoOverrides).toEqual({});
    expect(data.serviceOverrides).toEqual({});
  });

  it('sorts keys when writing for stable git output', () => {
    const data: SyncSettingsFile = {
      settings: { zzz: '1', aaa: '2' },
      filePatterns: [
        { pattern: 'GEMINI.md', enabled: true },
        { pattern: 'CLAUDE.md', enabled: true },
      ],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    writeSyncSettingsFile(data);

    const written = readJsonFile();
    const settingsKeys = Object.keys(written.settings);
    expect(settingsKeys).toEqual(['aaa', 'zzz']);
    expect(written.filePatterns[0].pattern).toBe('CLAUDE.md');
    expect(written.filePatterns[1].pattern).toBe('GEMINI.md');
  });

  it('removes empty override entries when writing', () => {
    const data: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/has-content': { settings: { auto_sync: 'false' } },
        'repos/empty': {},
      },
      serviceOverrides: {
        'services/empty': {},
      },
    };
    writeSyncSettingsFile(data);

    const written = readJsonFile();
    expect(written.repoOverrides['repos/has-content']).toBeDefined();
    expect(written.repoOverrides['repos/empty']).toBeUndefined();
    expect(written.serviceOverrides['services/empty']).toBeUndefined();
  });

  it('removes override entries with only empty sub-objects', () => {
    const data: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/all-empty-subs': {
          settings: {},
          filePatternOverrides: {},
          filePatternLocal: {},
          ignorePatternOverrides: {},
          ignorePatternLocal: {},
        },
      },
      serviceOverrides: {},
    };
    writeSyncSettingsFile(data);

    const written = readJsonFile();
    expect(written.repoOverrides['repos/all-empty-subs']).toBeUndefined();
  });

  it('sorts repo/service override keys', () => {
    const data: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/zzz': { settings: { x: '1' } },
        'repos/aaa': { settings: { x: '1' } },
      },
      serviceOverrides: {},
    };
    writeSyncSettingsFile(data);

    const written = readJsonFile();
    const keys = Object.keys(written.repoOverrides);
    expect(keys).toEqual(['repos/aaa', 'repos/zzz']);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  exportSettingsToFile                                                ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('exportSettingsToFile', () => {
  it('exports global settings (only non-default values)', () => {
    // Change one setting from default
    db.prepare("UPDATE settings SET value = '10' WHERE key = 'size_warning_mb'").run();

    exportSettingsToFile(db);

    const data = readJsonFile();
    // size_warning_mb is changed from default '20' to '10'
    expect(data.settings.size_warning_mb).toBe('10');
    // Default values should NOT appear
    expect(data.settings.auto_sync).toBeUndefined();
    expect(data.settings.sync_interval_ms).toBeUndefined();
  });

  it('does not export schema_version', () => {
    exportSettingsToFile(db);
    const data = readJsonFile();
    expect(data.settings.schema_version).toBeUndefined();
  });

  it('exports file patterns', () => {
    exportSettingsToFile(db);
    const data = readJsonFile();
    // Default patterns should be exported
    expect(data.filePatterns.length).toBeGreaterThan(0);
    expect(data.filePatterns.find((p) => p.pattern === 'CLAUDE.md')).toBeDefined();
  });

  it('exports ignore patterns', () => {
    exportSettingsToFile(db);
    const data = readJsonFile();
    expect(data.ignorePatterns.length).toBeGreaterThan(0);
    expect(data.ignorePatterns.find((p) => p.pattern === '.DS_Store')).toBeDefined();
  });

  it('exports repo overrides', () => {
    insertRepo('r1', 'repos/my-project');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs1', 'r1', 'auto_sync', 'false')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs2', 'r1', 'file_pattern_override:.cursor/**', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs3', 'r1', 'file_pattern_local:custom-pattern', 'enabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs4', 'r1', 'ignore_pattern_override:.DS_Store', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs5', 'r1', 'ignore_pattern_local:*.log', 'enabled')",
    ).run();

    exportSettingsToFile(db);

    const data = readJsonFile();
    const repoEntry = data.repoOverrides['repos/my-project'];
    expect(repoEntry).toBeDefined();
    expect(repoEntry.settings).toEqual({ auto_sync: 'false' });
    expect(repoEntry.filePatternOverrides).toEqual({ '.cursor/**': 'disabled' });
    expect(repoEntry.filePatternLocal).toEqual({ 'custom-pattern': 'enabled' });
    expect(repoEntry.ignorePatternOverrides).toEqual({ '.DS_Store': 'disabled' });
    expect(repoEntry.ignorePatternLocal).toEqual({ '*.log': 'enabled' });
  });

  it('exports service overrides', () => {
    insertService('s1', 'services/claude-code');
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss1', 's1', 'service_pattern_default:commands/**', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss2', 's1', 'service_pattern_custom:my-scripts/**', 'enabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss3', 's1', 'service_ignore_override:.DS_Store', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss4', 's1', 'service_ignore_custom:*.tmp', 'enabled')",
    ).run();

    exportSettingsToFile(db);

    const data = readJsonFile();
    const svcEntry = data.serviceOverrides['services/claude-code'];
    expect(svcEntry).toBeDefined();
    expect(svcEntry.patternDefaults).toEqual({ 'commands/**': 'disabled' });
    expect(svcEntry.patternCustom).toEqual({ 'my-scripts/**': 'enabled' });
    expect(svcEntry.ignoreOverrides).toEqual({ '.DS_Store': 'disabled' });
    expect(svcEntry.ignoreCustom).toEqual({ '*.tmp': 'enabled' });
  });

  it('skips repos with no overrides', () => {
    insertRepo('r1', 'repos/no-overrides');

    exportSettingsToFile(db);

    const data = readJsonFile();
    expect(data.repoOverrides['repos/no-overrides']).toBeUndefined();
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  restoreSettingsFromFile                                             ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('restoreSettingsFromFile', () => {
  it('does nothing when file does not exist', () => {
    // Capture settings before
    const before = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync'").get() as {
      value: string;
    };

    restoreSettingsFromFile(db);

    const after = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync'").get() as {
      value: string;
    };
    expect(after.value).toBe(before.value);
  });

  it('restores global settings', () => {
    const fileData: SyncSettingsFile = {
      settings: { size_warning_mb: '5', auto_sync: 'false' },
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const sizeWarning = db
      .prepare("SELECT value FROM settings WHERE key = 'size_warning_mb'")
      .get() as { value: string };
    expect(sizeWarning.value).toBe('5');

    const autoSync = db.prepare("SELECT value FROM settings WHERE key = 'auto_sync'").get() as {
      value: string;
    };
    expect(autoSync.value).toBe('false');
  });

  it('does not restore schema_version', () => {
    const fileData: SyncSettingsFile = {
      settings: { schema_version: '999' },
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(row.value).not.toBe('999');
  });

  it('restores file patterns (replaces all)', () => {
    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [
        { pattern: 'CUSTOM.md', enabled: true },
        { pattern: 'OTHER.md', enabled: false },
      ],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const patterns = db
      .prepare('SELECT pattern, enabled FROM file_patterns ORDER BY pattern')
      .all() as {
      pattern: string;
      enabled: number;
    }[];
    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toEqual({ pattern: 'CUSTOM.md', enabled: 1 });
    expect(patterns[1]).toEqual({ pattern: 'OTHER.md', enabled: 0 });
  });

  it('restores ignore patterns (replaces all)', () => {
    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [{ pattern: '*.log', enabled: true }],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const patterns = db
      .prepare('SELECT pattern, enabled FROM ignore_patterns ORDER BY pattern')
      .all() as {
      pattern: string;
      enabled: number;
    }[];
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toEqual({ pattern: '*.log', enabled: 1 });
  });

  it('keeps default patterns when file has empty arrays', () => {
    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    const beforeCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM file_patterns').get() as { cnt: number }
    ).cnt;

    restoreSettingsFromFile(db);

    const afterCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM file_patterns').get() as { cnt: number }
    ).cnt;
    // Empty arrays don't trigger replacement
    expect(afterCount).toBe(beforeCount);
  });

  it('restores repo overrides for linked repos', () => {
    insertRepo('r1', 'repos/my-project');

    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/my-project': {
          settings: { auto_sync: 'false' },
          filePatternOverrides: { '.cursor/**': 'disabled' },
          filePatternLocal: { 'custom-file': 'enabled' },
          ignorePatternOverrides: { '.DS_Store': 'disabled' },
          ignorePatternLocal: { '*.log': 'enabled' },
        },
      },
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const rows = db
      .prepare('SELECT key, value FROM repo_settings WHERE repo_id = ? ORDER BY key')
      .all('r1') as { key: string; value: string }[];

    expect(rows).toEqual([
      { key: 'auto_sync', value: 'false' },
      { key: 'file_pattern_local:custom-file', value: 'enabled' },
      { key: 'file_pattern_override:.cursor/**', value: 'disabled' },
      { key: 'ignore_pattern_local:*.log', value: 'enabled' },
      { key: 'ignore_pattern_override:.DS_Store', value: 'disabled' },
    ]);
  });

  it('skips repo overrides for repos not linked on this machine', () => {
    // No repo inserted — simulating not linked
    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/unlinked-project': {
          settings: { auto_sync: 'false' },
        },
      },
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    // Should not throw and should not insert anything
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM repo_settings').get() as { cnt: number })
      .cnt;
    expect(count).toBe(0);
  });

  it('restores service overrides for linked services', () => {
    insertService('s1', 'services/claude-code');

    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/claude-code': {
          patternDefaults: { 'commands/**': 'disabled' },
          patternCustom: { 'my-scripts/**': 'enabled' },
          ignoreOverrides: { '.DS_Store': 'disabled' },
          ignoreCustom: { '*.tmp': 'enabled' },
        },
      },
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const rows = db
      .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ? ORDER BY key')
      .all('s1') as { key: string; value: string }[];

    expect(rows).toEqual([
      { key: 'service_ignore_custom:*.tmp', value: 'enabled' },
      { key: 'service_ignore_override:.DS_Store', value: 'disabled' },
      { key: 'service_pattern_custom:my-scripts/**', value: 'enabled' },
      { key: 'service_pattern_default:commands/**', value: 'disabled' },
    ]);
  });

  it('skips service overrides for services not linked on this machine', () => {
    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/unlinked': {
          patternDefaults: { 'x/**': 'disabled' },
        },
      },
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM service_settings').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it('clears existing overrides before applying new ones', () => {
    insertRepo('r1', 'repos/my-project');

    // Pre-existing override
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('old1', 'r1', 'old_key', 'old_value')",
    ).run();

    const fileData: SyncSettingsFile = {
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/my-project': {
          settings: { new_key: 'new_value' },
        },
      },
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreSettingsFromFile(db);

    const rows = db.prepare('SELECT key, value FROM repo_settings WHERE repo_id = ?').all('r1') as {
      key: string;
      value: string;
    }[];
    expect(rows).toEqual([{ key: 'new_key', value: 'new_value' }]);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  restoreOrMigrateSettings                                           ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('restoreOrMigrateSettings', () => {
  it('exports to file when sync-settings.json does not exist (migration)', () => {
    // Modify a setting so we can verify export
    db.prepare("UPDATE settings SET value = '999' WHERE key = 'size_warning_mb'").run();

    restoreOrMigrateSettings(db);

    expect(fsSync.existsSync(syncSettingsPath())).toBe(true);
    const data = readJsonFile();
    expect(data.settings.size_warning_mb).toBe('999');
  });

  it('restores from file when sync-settings.json exists', () => {
    const fileData: SyncSettingsFile = {
      settings: { size_warning_mb: '5' },
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    fsSync.writeFileSync(syncSettingsPath(), JSON.stringify(fileData), 'utf-8');

    restoreOrMigrateSettings(db);

    const row = db.prepare("SELECT value FROM settings WHERE key = 'size_warning_mb'").get() as {
      value: string;
    };
    expect(row.value).toBe('5');
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Granular updates                                                    ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('syncSettingsUpdateGlobal', () => {
  it('updates only the settings section of existing file', () => {
    // Create initial file with some data
    const initial: SyncSettingsFile = {
      settings: {},
      filePatterns: [{ pattern: 'KEEP.md', enabled: true }],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    };
    writeSyncSettingsFile(initial);

    // Change a global setting in DB
    db.prepare("UPDATE settings SET value = '3' WHERE key = 'size_warning_mb'").run();

    syncSettingsUpdateGlobal(db);

    const data = readJsonFile();
    expect(data.settings.size_warning_mb).toBe('3');
    // Other sections preserved
    expect(data.filePatterns).toHaveLength(1);
    expect(data.filePatterns[0].pattern).toBe('KEEP.md');
  });
});

describe('syncSettingsUpdateFilePatterns', () => {
  it('updates the filePatterns section from DB', () => {
    writeSyncSettingsFile({
      settings: { keep: 'me' },
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateFilePatterns(db);

    const data = readJsonFile();
    // Should reflect the DB patterns (seeded defaults)
    expect(data.filePatterns.length).toBeGreaterThan(0);
    expect(data.filePatterns.find((p) => p.pattern === 'CLAUDE.md')).toBeDefined();
    // Other sections preserved
    expect(data.settings.keep).toBe('me');
  });
});

describe('syncSettingsUpdateIgnorePatterns', () => {
  it('updates the ignorePatterns section from DB', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateIgnorePatterns(db);

    const data = readJsonFile();
    expect(data.ignorePatterns.length).toBeGreaterThan(0);
    expect(data.ignorePatterns.find((p) => p.pattern === '.DS_Store')).toBeDefined();
  });
});

describe('syncSettingsUpdateRepo', () => {
  it('updates a specific repo override in the file', () => {
    insertRepo('r1', 'repos/project-a');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs1', 'r1', 'auto_sync', 'false')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateRepo(db, 'repos/project-a');

    const data = readJsonFile();
    expect(data.repoOverrides['repos/project-a']).toBeDefined();
    expect(data.repoOverrides['repos/project-a'].settings).toEqual({ auto_sync: 'false' });
  });

  it('removes repo override when repo has no settings', () => {
    insertRepo('r1', 'repos/project-a');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/project-a': { settings: { old: 'value' } },
      },
      serviceOverrides: {},
    });

    syncSettingsUpdateRepo(db, 'repos/project-a');

    const data = readJsonFile();
    expect(data.repoOverrides['repos/project-a']).toBeUndefined();
  });

  it('is a no-op when repo does not exist in DB', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateRepo(db, 'repos/nonexistent');

    const data = readJsonFile();
    expect(data.repoOverrides).toEqual({});
  });

  it('preserves other repos when updating one', () => {
    insertRepo('r1', 'repos/project-a');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs1', 'r1', 'auto_sync', 'false')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/project-b': { settings: { keep: 'this' } },
      },
      serviceOverrides: {},
    });

    syncSettingsUpdateRepo(db, 'repos/project-a');

    const data = readJsonFile();
    expect(data.repoOverrides['repos/project-a']).toBeDefined();
    expect(data.repoOverrides['repos/project-b']).toBeDefined();
    expect(data.repoOverrides['repos/project-b'].settings).toEqual({ keep: 'this' });
  });

  it('correctly categorizes all override key types', () => {
    insertRepo('r1', 'repos/full');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('a', 'r1', 'file_pattern_override:CLAUDE.md', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('b', 'r1', 'file_pattern_local:custom', 'enabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('c', 'r1', 'ignore_pattern_override:.env', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('d', 'r1', 'ignore_pattern_local:*.bak', 'enabled')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('e', 'r1', 'sync_interval_ms', '10000')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateRepo(db, 'repos/full');

    const data = readJsonFile();
    const entry = data.repoOverrides['repos/full'];
    expect(entry.settings).toEqual({ sync_interval_ms: '10000' });
    expect(entry.filePatternOverrides).toEqual({ 'CLAUDE.md': 'disabled' });
    expect(entry.filePatternLocal).toEqual({ custom: 'enabled' });
    expect(entry.ignorePatternOverrides).toEqual({ '.env': 'disabled' });
    expect(entry.ignorePatternLocal).toEqual({ '*.bak': 'enabled' });
  });
});

describe('syncSettingsUpdateService', () => {
  it('updates a specific service override in the file', () => {
    insertService('s1', 'services/claude-code');
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss1', 's1', 'service_pattern_custom:scripts/**', 'enabled')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateService(db, 'services/claude-code');

    const data = readJsonFile();
    expect(data.serviceOverrides['services/claude-code']).toBeDefined();
    expect(data.serviceOverrides['services/claude-code'].patternCustom).toEqual({
      'scripts/**': 'enabled',
    });
  });

  it('removes service override when service has no settings', () => {
    insertService('s1', 'services/claude-code');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/claude-code': { patternDefaults: { old: 'value' } },
      },
    });

    syncSettingsUpdateService(db, 'services/claude-code');

    const data = readJsonFile();
    expect(data.serviceOverrides['services/claude-code']).toBeUndefined();
  });

  it('is a no-op when service does not exist in DB', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateService(db, 'services/nonexistent');

    const data = readJsonFile();
    expect(data.serviceOverrides).toEqual({});
  });

  it('correctly categorizes all service override key types', () => {
    insertService('s1', 'services/claude-code');
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('a', 's1', 'service_pattern_default:commands/**', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('b', 's1', 'service_pattern_custom:my-scripts/**', 'enabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('c', 's1', 'service_ignore_override:.DS_Store', 'disabled')",
    ).run();
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('d', 's1', 'service_ignore_custom:*.tmp', 'enabled')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsUpdateService(db, 'services/claude-code');

    const data = readJsonFile();
    const entry = data.serviceOverrides['services/claude-code'];
    expect(entry.patternDefaults).toEqual({ 'commands/**': 'disabled' });
    expect(entry.patternCustom).toEqual({ 'my-scripts/**': 'enabled' });
    expect(entry.ignoreOverrides).toEqual({ '.DS_Store': 'disabled' });
    expect(entry.ignoreCustom).toEqual({ '*.tmp': 'enabled' });
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  syncSettingsRemoveRepo / syncSettingsRemoveService                  ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('syncSettingsRemoveRepo', () => {
  it('removes repo entry from file', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/to-remove': { settings: { x: '1' } },
        'repos/to-keep': { settings: { y: '2' } },
      },
      serviceOverrides: {},
    });

    syncSettingsRemoveRepo('repos/to-remove');

    const data = readJsonFile();
    expect(data.repoOverrides['repos/to-remove']).toBeUndefined();
    expect(data.repoOverrides['repos/to-keep']).toBeDefined();
  });

  it('is a no-op when repo does not exist in file', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    syncSettingsRemoveRepo('repos/nonexistent');

    const data = readJsonFile();
    expect(data.repoOverrides).toEqual({});
  });
});

describe('syncSettingsRemoveService', () => {
  it('removes service entry from file', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/to-remove': { patternDefaults: { x: '1' } },
        'services/to-keep': { patternDefaults: { y: '2' } },
      },
    });

    syncSettingsRemoveService('services/to-remove');

    const data = readJsonFile();
    expect(data.serviceOverrides['services/to-remove']).toBeUndefined();
    expect(data.serviceOverrides['services/to-keep']).toBeDefined();
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Deferred overrides (applyOverridesForRepo / applyOverridesForService)║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('applyOverridesForRepo', () => {
  it('applies overrides from file to DB when repo is linked', () => {
    insertRepo('r1', 'repos/my-project');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/my-project': {
          settings: { auto_sync: 'false' },
          filePatternLocal: { 'custom-file': 'enabled' },
        },
      },
      serviceOverrides: {},
    });

    applyOverridesForRepo(db, 'repos/my-project');

    const rows = db
      .prepare('SELECT key, value FROM repo_settings WHERE repo_id = ? ORDER BY key')
      .all('r1') as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'auto_sync', value: 'false' },
      { key: 'file_pattern_local:custom-file', value: 'enabled' },
    ]);
  });

  it('is a no-op when no overrides exist for this repo', () => {
    insertRepo('r1', 'repos/my-project');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    applyOverridesForRepo(db, 'repos/my-project');

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM repo_settings').get() as { cnt: number })
      .cnt;
    expect(count).toBe(0);
  });

  it('is a no-op when repo is not linked (not in DB)', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/unlinked': { settings: { x: '1' } },
      },
      serviceOverrides: {},
    });

    // Should not throw
    applyOverridesForRepo(db, 'repos/unlinked');

    const count = (db.prepare('SELECT COUNT(*) as cnt FROM repo_settings').get() as { cnt: number })
      .cnt;
    expect(count).toBe(0);
  });

  it('replaces existing overrides when applying', () => {
    insertRepo('r1', 'repos/my-project');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('old', 'r1', 'old_key', 'old_value')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {
        'repos/my-project': { settings: { new_key: 'new_value' } },
      },
      serviceOverrides: {},
    });

    applyOverridesForRepo(db, 'repos/my-project');

    const rows = db.prepare('SELECT key, value FROM repo_settings WHERE repo_id = ?').all('r1') as {
      key: string;
      value: string;
    }[];
    expect(rows).toEqual([{ key: 'new_key', value: 'new_value' }]);
  });
});

describe('applyOverridesForService', () => {
  it('applies overrides from file to DB when service is linked', () => {
    insertService('s1', 'services/claude-code');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/claude-code': {
          patternDefaults: { 'commands/**': 'disabled' },
          patternCustom: { 'my-scripts/**': 'enabled' },
        },
      },
    });

    applyOverridesForService(db, 'services/claude-code');

    const rows = db
      .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ? ORDER BY key')
      .all('s1') as { key: string; value: string }[];
    expect(rows).toEqual([
      { key: 'service_pattern_custom:my-scripts/**', value: 'enabled' },
      { key: 'service_pattern_default:commands/**', value: 'disabled' },
    ]);
  });

  it('is a no-op when no overrides exist for this service', () => {
    insertService('s1', 'services/claude-code');

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {},
    });

    applyOverridesForService(db, 'services/claude-code');

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM service_settings').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it('is a no-op when service is not linked (not in DB)', () => {
    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/unlinked': { patternDefaults: { x: '1' } },
      },
    });

    applyOverridesForService(db, 'services/unlinked');

    const count = (
      db.prepare('SELECT COUNT(*) as cnt FROM service_settings').get() as { cnt: number }
    ).cnt;
    expect(count).toBe(0);
  });

  it('replaces existing overrides when applying', () => {
    insertService('s1', 'services/claude-code');
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('old', 's1', 'service_pattern_custom:old', 'enabled')",
    ).run();

    writeSyncSettingsFile({
      settings: {},
      filePatterns: [],
      ignorePatterns: [],
      repoOverrides: {},
      serviceOverrides: {
        'services/claude-code': {
          patternCustom: { new: 'enabled' },
        },
      },
    });

    applyOverridesForService(db, 'services/claude-code');

    const rows = db
      .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ?')
      .all('s1') as { key: string; value: string }[];
    expect(rows).toEqual([{ key: 'service_pattern_custom:new', value: 'enabled' }]);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Round-trip: export → restore                                       ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('round-trip: export then restore', () => {
  it('preserves all settings through export → fresh DB → restore', () => {
    // Setup: non-default global setting + repo with overrides + service with overrides
    db.prepare("UPDATE settings SET value = '7' WHERE key = 'size_warning_mb'").run();

    insertRepo('r1', 'repos/my-project');
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs1', 'r1', 'auto_sync', 'false')",
    ).run();
    db.prepare(
      "INSERT INTO repo_settings (id, repo_id, key, value) VALUES ('rs2', 'r1', 'file_pattern_local:custom', 'enabled')",
    ).run();

    insertService('s1', 'services/claude-code');
    db.prepare(
      "INSERT INTO service_settings (id, service_config_id, key, value) VALUES ('ss1', 's1', 'service_pattern_custom:scripts/**', 'enabled')",
    ).run();

    // Add a custom file pattern
    db.prepare(
      "INSERT INTO file_patterns (id, pattern, enabled) VALUES ('fp1', 'CUSTOM.md', 1)",
    ).run();

    // Export
    exportSettingsToFile(db);

    // Create a fresh DB (simulating new machine)
    const db2 = new Database(':memory:');
    initSchema(db2);

    // Insert same repos/services (simulating linking)
    insertRepoInDb(db2, 'r1', 'repos/my-project');
    insertServiceInDb(db2, 's1', 'services/claude-code');

    // Restore
    restoreSettingsFromFile(db2);

    // Verify global settings
    const sizeWarning = db2
      .prepare("SELECT value FROM settings WHERE key = 'size_warning_mb'")
      .get() as { value: string };
    expect(sizeWarning.value).toBe('7');

    // Verify file patterns include custom
    const patterns = db2.prepare('SELECT pattern FROM file_patterns ORDER BY pattern').all() as {
      pattern: string;
    }[];
    expect(patterns.find((p) => p.pattern === 'CUSTOM.md')).toBeDefined();
    expect(patterns.find((p) => p.pattern === 'CLAUDE.md')).toBeDefined();

    // Verify repo overrides
    const repoSettings = db2
      .prepare('SELECT key, value FROM repo_settings WHERE repo_id = ? ORDER BY key')
      .all('r1') as { key: string; value: string }[];
    expect(repoSettings).toEqual([
      { key: 'auto_sync', value: 'false' },
      { key: 'file_pattern_local:custom', value: 'enabled' },
    ]);

    // Verify service overrides
    const serviceSettings = db2
      .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ? ORDER BY key')
      .all('s1') as { key: string; value: string }[];
    expect(serviceSettings).toEqual([
      { key: 'service_pattern_custom:scripts/**', value: 'enabled' },
    ]);

    db2.close();
  });
});

// Helper functions for round-trip test (operate on a specific DB)
function insertRepoInDb(
  database: Database.Database,
  id: string,
  storePath: string,
  localPath = '/tmp/repo',
): void {
  database
    .prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    )
    .run(id, storePath.replace('repos/', ''), localPath, storePath);
}

function insertServiceInDb(
  database: Database.Database,
  id: string,
  storePath: string,
  localPath = '/tmp/service',
): void {
  database
    .prepare(
      "INSERT INTO service_configs (id, service_type, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
    )
    .run(id, storePath.replace('services/', ''), 'Test Service', localPath, storePath);
}
