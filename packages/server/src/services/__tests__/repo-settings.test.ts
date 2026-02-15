import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import picomatch from 'picomatch';
import { v4 as uuid } from 'uuid';
import { initSchema } from '../../db/schema.js';
import {
  expandIgnorePatterns,
  getEffectiveFilePatterns,
  getEffectiveIgnorePatterns,
  getRepoEnabledFilePatterns,
  getRepoIgnorePatterns,
  getRepoEffectiveSettings,
} from '../../db/index.js';
import { scanRepoForAIFiles } from '../repo-scanner.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let db: Database.Database;
const REPO_ID = 'repo-1';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-settings-test-'));
  db = new Database(':memory:');
  initSchema(db);

  // Insert a test repo
  db.prepare(
    "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
  ).run(REPO_ID, 'test-project', tmpDir, 'repos/test-project');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  db.close();
});

async function createFile(relativePath: string, content = 'test') {
  const fullPath = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf-8');
}

function addRepoSetting(repoId: string, key: string, value: string) {
  db.prepare('INSERT INTO repo_settings (id, repo_id, key, value) VALUES (?, ?, ?, ?)').run(
    uuid(),
    repoId,
    key,
    value,
  );
}

// ── getEffectiveFilePatterns ─────────────────────────────────────────────────

describe('getEffectiveFilePatterns', () => {
  it('returns all global patterns when no overrides exist', () => {
    const patterns = getEffectiveFilePatterns(db, REPO_ID);

    // All patterns should have source 'global'
    expect(patterns.every((p) => p.source === 'global')).toBe(true);
    // Should include default patterns
    expect(patterns.map((p) => p.pattern)).toContain('CLAUDE.md');
    expect(patterns.map((p) => p.pattern)).toContain('.cursor/**');
  });

  it('overrides a global pattern enabled state', () => {
    // Disable CLAUDE.md for this repo
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    const patterns = getEffectiveFilePatterns(db, REPO_ID);
    const claudePattern = patterns.find((p) => p.pattern === 'CLAUDE.md');

    expect(claudePattern).toBeDefined();
    expect(claudePattern!.enabled).toBe(false);
    expect(claudePattern!.source).toBe('global');
  });

  it('can re-enable a globally disabled pattern', () => {
    // First disable CLAUDE.md globally
    db.prepare("UPDATE file_patterns SET enabled = 0 WHERE pattern = 'CLAUDE.md'").run();

    // Then enable it locally for this repo
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'enabled');

    const patterns = getEffectiveFilePatterns(db, REPO_ID);
    const claudePattern = patterns.find((p) => p.pattern === 'CLAUDE.md');

    expect(claudePattern!.enabled).toBe(true);
  });

  it('adds local-only patterns', () => {
    addRepoSetting(REPO_ID, 'file_pattern_local:.custom-ai/**', 'enabled');

    const patterns = getEffectiveFilePatterns(db, REPO_ID);
    const customPattern = patterns.find((p) => p.pattern === '.custom-ai/**');

    expect(customPattern).toBeDefined();
    expect(customPattern!.enabled).toBe(true);
    expect(customPattern!.source).toBe('local');
  });

  it('supports disabled local-only patterns', () => {
    addRepoSetting(REPO_ID, 'file_pattern_local:.custom-ai/**', 'disabled');

    const patterns = getEffectiveFilePatterns(db, REPO_ID);
    const customPattern = patterns.find((p) => p.pattern === '.custom-ai/**');

    expect(customPattern).toBeDefined();
    expect(customPattern!.enabled).toBe(false);
    expect(customPattern!.source).toBe('local');
  });

  it('does not affect other repos', () => {
    const OTHER_REPO = 'repo-2';
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run(OTHER_REPO, 'other-project', '/tmp/other', 'repos/other-project');

    // Override for REPO_ID only
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    const patternsRepo1 = getEffectiveFilePatterns(db, REPO_ID);
    const patternsRepo2 = getEffectiveFilePatterns(db, OTHER_REPO);

    const claudeRepo1 = patternsRepo1.find((p) => p.pattern === 'CLAUDE.md');
    const claudeRepo2 = patternsRepo2.find((p) => p.pattern === 'CLAUDE.md');

    expect(claudeRepo1!.enabled).toBe(false);
    expect(claudeRepo2!.enabled).toBe(true); // No override for repo-2
  });
});

// ── getEffectiveIgnorePatterns ───────────────────────────────────────────────

describe('getEffectiveIgnorePatterns', () => {
  it('returns all global ignore patterns when no overrides exist', () => {
    const patterns = getEffectiveIgnorePatterns(db, REPO_ID);

    expect(patterns.every((p) => p.source === 'global')).toBe(true);
    expect(patterns.map((p) => p.pattern)).toContain('.DS_Store');
    expect(patterns.map((p) => p.pattern)).toContain('node_modules/**');
  });

  it('overrides a global ignore pattern', () => {
    // Enable node_modules tracking for this repo (disable the ignore)
    addRepoSetting(REPO_ID, 'ignore_pattern_override:node_modules/**', 'disabled');

    const patterns = getEffectiveIgnorePatterns(db, REPO_ID);
    const nodeModules = patterns.find((p) => p.pattern === 'node_modules/**');

    expect(nodeModules!.enabled).toBe(false);
  });

  it('adds local-only ignore patterns', () => {
    addRepoSetting(REPO_ID, 'ignore_pattern_local:dist/**', 'enabled');

    const patterns = getEffectiveIgnorePatterns(db, REPO_ID);
    const distPattern = patterns.find((p) => p.pattern === 'dist/**');

    expect(distPattern).toBeDefined();
    expect(distPattern!.enabled).toBe(true);
    expect(distPattern!.source).toBe('local');
  });
});

// ── getRepoEnabledFilePatterns ───────────────────────────────────────────────

describe('getRepoEnabledFilePatterns', () => {
  it('returns only enabled patterns', () => {
    // Disable CLAUDE.md for this repo
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');
    // Add a local enabled pattern
    addRepoSetting(REPO_ID, 'file_pattern_local:.my-tool/**', 'enabled');
    // Add a local disabled pattern
    addRepoSetting(REPO_ID, 'file_pattern_local:.other-tool/**', 'disabled');

    const enabled = getRepoEnabledFilePatterns(db, REPO_ID);

    expect(enabled).not.toContain('CLAUDE.md');
    expect(enabled).toContain('.my-tool/**');
    expect(enabled).not.toContain('.other-tool/**');
    // Other global patterns should still be there
    expect(enabled).toContain('.cursor/**');
  });
});

// ── getRepoIgnorePatterns ────────────────────────────────────────────────────

describe('getRepoIgnorePatterns', () => {
  it('returns only enabled ignore patterns', () => {
    addRepoSetting(REPO_ID, 'ignore_pattern_override:.DS_Store', 'disabled');
    addRepoSetting(REPO_ID, 'ignore_pattern_local:build/**', 'enabled');

    const enabled = getRepoIgnorePatterns(db, REPO_ID);

    expect(enabled).not.toContain('.DS_Store');
    expect(enabled).toContain('build/**');
    expect(enabled).toContain('node_modules/**'); // Global still active
  });
});

// ── getRepoEffectiveSettings ─────────────────────────────────────────────────

describe('getRepoEffectiveSettings', () => {
  it('returns global settings when no overrides exist', () => {
    const settings = getRepoEffectiveSettings(db, REPO_ID);

    expect(settings.auto_sync).toEqual({ value: 'true', source: 'global' });
    expect(settings.sync_interval_ms).toEqual({ value: '5000', source: 'global' });
    expect(settings.auto_commit_store).toEqual({ value: 'true', source: 'global' });
  });

  it('returns local override when set', () => {
    addRepoSetting(REPO_ID, 'sync_interval_ms', '10000');

    const settings = getRepoEffectiveSettings(db, REPO_ID);

    expect(settings.sync_interval_ms).toEqual({ value: '10000', source: 'local' });
    // Other settings remain global
    expect(settings.auto_sync).toEqual({ value: 'true', source: 'global' });
  });

  it('can override boolean settings', () => {
    addRepoSetting(REPO_ID, 'auto_sync', 'false');
    addRepoSetting(REPO_ID, 'auto_commit_store', 'false');

    const settings = getRepoEffectiveSettings(db, REPO_ID);

    expect(settings.auto_sync).toEqual({ value: 'false', source: 'local' });
    expect(settings.auto_commit_store).toEqual({ value: 'false', source: 'local' });
  });

  it('excludes schema_version from results', () => {
    const settings = getRepoEffectiveSettings(db, REPO_ID);
    expect(settings).not.toHaveProperty('schema_version');
  });

  it('does not affect other repos', () => {
    const OTHER_REPO = 'repo-2';
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run(OTHER_REPO, 'other-project', '/tmp/other', 'repos/other-project');

    addRepoSetting(REPO_ID, 'sync_interval_ms', '10000');

    const settingsRepo1 = getRepoEffectiveSettings(db, REPO_ID);
    const settingsRepo2 = getRepoEffectiveSettings(db, OTHER_REPO);

    expect(settingsRepo1.sync_interval_ms).toEqual({ value: '10000', source: 'local' });
    expect(settingsRepo2.sync_interval_ms).toEqual({ value: '5000', source: 'global' });
  });
});

// ── Local overrides work with pattern matching ───────────────────────────────

describe('local overrides affect pattern matching', () => {
  it('locally disabled ignore pattern allows files through', () => {
    // Disable .DS_Store ignore for this repo
    addRepoSetting(REPO_ID, 'ignore_pattern_override:.DS_Store', 'disabled');

    const ignorePatterns = getRepoIgnorePatterns(db, REPO_ID);
    const expanded = expandIgnorePatterns(ignorePatterns);
    const matcher = picomatch(expanded, { dot: true });

    // .DS_Store should NOT be ignored now
    expect(matcher('.DS_Store')).toBe(false);
    expect(matcher('.cursor/.DS_Store')).toBe(false);

    // Other patterns should still work
    expect(matcher('node_modules/foo.js')).toBe(true);
    expect(matcher('__pycache__/module.pyc')).toBe(true);
  });

  it('local-only ignore pattern blocks files', () => {
    addRepoSetting(REPO_ID, 'ignore_pattern_local:build/**', 'enabled');

    const ignorePatterns = getRepoIgnorePatterns(db, REPO_ID);
    const expanded = expandIgnorePatterns(ignorePatterns);
    const matcher = picomatch(expanded, { dot: true });

    expect(matcher('build/output.js')).toBe(true);
    expect(matcher('src/build/output.js')).toBe(true);
  });

  it('locally disabled file pattern excludes files from scanning', () => {
    // Disable CLAUDE.md pattern for this repo
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    const patterns = getRepoEnabledFilePatterns(db, REPO_ID);

    expect(patterns).not.toContain('CLAUDE.md');
    expect(patterns).toContain('.cursor/**');
  });

  it('local-only file pattern includes extra files in scanning', () => {
    addRepoSetting(REPO_ID, 'file_pattern_local:.my-ai-config/**', 'enabled');

    const patterns = getRepoEnabledFilePatterns(db, REPO_ID);

    expect(patterns).toContain('.my-ai-config/**');
    expect(patterns).toContain('CLAUDE.md'); // Global still active
  });
});

// ── scanRepoForAIFiles respects repo-specific patterns ───────────────────────

describe('scanRepoForAIFiles with repo-specific patterns', () => {
  it('excludes files when their file pattern is locally disabled', async () => {
    await createFile('CLAUDE.md', 'claude content');
    await createFile('.cursor/rules', 'cursor rules');

    // Disable CLAUDE.md pattern for this repo
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    const results = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    const paths = results.map((r) => r.path);

    expect(paths).not.toContain('CLAUDE.md');
    expect(paths).toContain('.cursor/rules');
  });

  it('includes files matching local-only file patterns', async () => {
    await createFile('.my-tool/config.json', '{}');
    await createFile('CLAUDE.md', 'claude content');

    addRepoSetting(REPO_ID, 'file_pattern_local:.my-tool/**', 'enabled');

    const results = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    const paths = results.map((r) => r.path);

    expect(paths).toContain('.my-tool/config.json');
    expect(paths).toContain('CLAUDE.md');
  });

  it('respects locally disabled ignore patterns', async () => {
    await createFile('.cursor/rules', 'rules');
    await createFile('.cursor/.DS_Store', 'mac junk');

    // Without override, .DS_Store is ignored
    const resultsBefore = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    expect(resultsBefore.map((r) => r.path)).not.toContain('.cursor/.DS_Store');

    // Disable the .DS_Store ignore pattern for this repo
    addRepoSetting(REPO_ID, 'ignore_pattern_override:.DS_Store', 'disabled');

    const resultsAfter = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    expect(resultsAfter.map((r) => r.path)).toContain('.cursor/.DS_Store');
  });

  it('respects local-only ignore patterns', async () => {
    await createFile('.cursor/rules', 'rules');
    await createFile('.cursor/build/output.js', 'built');

    // Without local ignore, build files are tracked
    addRepoSetting(REPO_ID, 'file_pattern_local:.cursor/build/**', 'enabled');
    const resultsBefore = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    expect(resultsBefore.map((r) => r.path)).toContain('.cursor/build/output.js');

    // Add local ignore pattern
    addRepoSetting(REPO_ID, 'ignore_pattern_local:.cursor/build/**', 'enabled');

    const resultsAfter = await scanRepoForAIFiles(tmpDir, db, REPO_ID);
    expect(resultsAfter.map((r) => r.path)).not.toContain('.cursor/build/output.js');
    expect(resultsAfter.map((r) => r.path)).toContain('.cursor/rules');
  });

  it('without repoId falls back to global patterns (backward compatible)', async () => {
    await createFile('CLAUDE.md', 'claude content');
    await createFile('.cursor/rules', 'cursor rules');

    // Add an override that should NOT apply when scanning without repoId
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    // Without repoId, global patterns apply — CLAUDE.md should be included
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('.cursor/rules');
  });
});

// ── repo_settings table cascade delete ───────────────────────────────────────

describe('repo_settings cascade delete', () => {
  it('deletes repo settings when repo is deleted', () => {
    addRepoSetting(REPO_ID, 'sync_interval_ms', '10000');
    addRepoSetting(REPO_ID, 'file_pattern_override:CLAUDE.md', 'disabled');

    // Verify settings exist
    const before = db
      .prepare('SELECT COUNT(*) as count FROM repo_settings WHERE repo_id = ?')
      .get(REPO_ID) as { count: number };
    expect(before.count).toBe(2);

    // Delete the repo
    db.prepare('DELETE FROM repos WHERE id = ?').run(REPO_ID);

    // Settings should be cascaded
    const after = db
      .prepare('SELECT COUNT(*) as count FROM repo_settings WHERE repo_id = ?')
      .get(REPO_ID) as { count: number };
    expect(after.count).toBe(0);
  });
});
