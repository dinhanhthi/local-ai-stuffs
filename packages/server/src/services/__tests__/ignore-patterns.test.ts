import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import picomatch from 'picomatch';
import { initSchema } from '../../db/schema.js';
import { expandIgnorePatterns, getIgnorePatterns } from '../../db/index.js';
import { scanRepoForAIFiles } from '../repo-scanner.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;
let db: Database.Database;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ignore-test-'));
  db = new Database(':memory:');
  initSchema(db);
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

// ── expandIgnorePatterns unit tests ──────────────────────────────────────────

describe('expandIgnorePatterns', () => {
  it('adds **/ prefix to simple filename patterns', () => {
    const result = expandIgnorePatterns(['.DS_Store', 'Thumbs.db']);
    expect(result).toEqual(['.DS_Store', '**/.DS_Store', 'Thumbs.db', '**/Thumbs.db']);
  });

  it('adds **/ prefix to directory patterns with slash', () => {
    const result = expandIgnorePatterns(['__pycache__/**']);
    expect(result).toEqual(['__pycache__/**', '**/__pycache__/**']);
  });

  it('does not double-prefix patterns already starting with **/', () => {
    const result = expandIgnorePatterns(['**/node_modules/**']);
    expect(result).toEqual(['**/node_modules/**']);
  });

  it('handles glob wildcards in filenames', () => {
    const result = expandIgnorePatterns(['*.swp', '*.swo']);
    expect(result).toEqual(['*.swp', '**/*.swp', '*.swo', '**/*.swo']);
  });

  it('returns empty array for empty input', () => {
    expect(expandIgnorePatterns([])).toEqual([]);
  });

  it('handles mixed patterns correctly', () => {
    const result = expandIgnorePatterns([
      '.DS_Store',
      '__pycache__/**',
      '**/already-prefixed',
      '*.swp',
      '.git/**',
    ]);
    expect(result).toEqual([
      '.DS_Store',
      '**/.DS_Store',
      '__pycache__/**',
      '**/__pycache__/**',
      '**/already-prefixed',
      '*.swp',
      '**/*.swp',
      '.git/**',
      '**/.git/**',
    ]);
  });
});

// ── Expanded patterns actually match correctly with picomatch ────────────────

describe('expanded patterns matching with picomatch', () => {
  it('matches .DS_Store at root level', () => {
    const expanded = expandIgnorePatterns(['.DS_Store']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('.DS_Store')).toBe(true);
  });

  it('matches .DS_Store nested inside directories', () => {
    const expanded = expandIgnorePatterns(['.DS_Store']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('.cursor/.DS_Store')).toBe(true);
    expect(matcher('deep/nested/dir/.DS_Store')).toBe(true);
  });

  it('matches __pycache__/** at root level', () => {
    const expanded = expandIgnorePatterns(['__pycache__/**']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('__pycache__/module.cpython-39.pyc')).toBe(true);
  });

  it('matches __pycache__/** nested inside directories', () => {
    const expanded = expandIgnorePatterns(['__pycache__/**']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('.cursor/__pycache__/module.cpython-39.pyc')).toBe(true);
    expect(matcher('src/utils/__pycache__/helper.pyc')).toBe(true);
  });

  it('matches .git/** at root and nested', () => {
    const expanded = expandIgnorePatterns(['.git/**']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('.git/config')).toBe(true);
    expect(matcher('.git/refs/heads/main')).toBe(true);
    expect(matcher('submodule/.git/config')).toBe(true);
  });

  it('matches wildcard patterns at any depth', () => {
    const expanded = expandIgnorePatterns(['*.swp']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('file.swp')).toBe(true);
    expect(matcher('.cursor/file.swp')).toBe(true);
    expect(matcher('deep/nested/file.swp')).toBe(true);
  });

  it('does not match unrelated files', () => {
    const expanded = expandIgnorePatterns(['.DS_Store', '__pycache__/**', '*.swp']);
    const matcher = picomatch(expanded, { dot: true });
    expect(matcher('CLAUDE.md')).toBe(false);
    expect(matcher('.cursor/rules')).toBe(false);
    expect(matcher('src/index.ts')).toBe(false);
  });
});

// ── Repo scanner respects ignore patterns ────────────────────────────────────

describe('scanRepoForAIFiles with ignore patterns', () => {
  it('excludes .DS_Store nested inside watched directories', async () => {
    await createFile('.cursor/rules', 'rules content');
    await createFile('.cursor/.DS_Store', 'mac junk');
    await createFile('CLAUDE.md', 'claude');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    expect(paths).toContain('.cursor/rules');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('.cursor/.DS_Store');
  });

  it('excludes __pycache__ nested inside watched directories', async () => {
    await createFile('.cursor/rules', 'rules content');
    await createFile('.cursor/__pycache__/cached.pyc', 'cached');
    await createFile('CLAUDE.md', 'claude');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    expect(paths).toContain('.cursor/rules');
    expect(paths).toContain('CLAUDE.md');
    expect(paths).not.toContain('.cursor/__pycache__/cached.pyc');
  });

  it('excludes .git files nested inside watched directories', async () => {
    await createFile('.cursor/rules', 'rules content');
    await createFile('.cursor/.git/config', 'git config');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    expect(paths).toContain('.cursor/rules');
    expect(paths).not.toContain('.cursor/.git/config');
  });

  it('excludes swap files nested inside watched directories', async () => {
    await createFile('.cursor/rules', 'rules content');
    await createFile('.cursor/.rules.swp', 'swap file');
    await createFile('.cursor/.rules.swo', 'swap file');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    expect(paths).toContain('.cursor/rules');
    expect(paths).not.toContain('.cursor/.rules.swp');
    expect(paths).not.toContain('.cursor/.rules.swo');
  });

  it('respects disabled ignore patterns', async () => {
    // Disable .DS_Store pattern
    db.prepare("UPDATE ignore_patterns SET enabled = 0 WHERE pattern = '.DS_Store'").run();

    await createFile('.cursor/rules', 'rules content');
    await createFile('.cursor/.DS_Store', 'mac junk');

    const results = await scanRepoForAIFiles(tmpDir, db);
    const paths = results.map((r) => r.path);

    // .DS_Store should now be included since the pattern is disabled
    expect(paths).toContain('.cursor/.DS_Store');
  });
});

// ── Clean endpoint matching logic ────────────────────────────────────────────

describe('clean matching logic (picomatch without basename)', () => {
  it('matches files that the old basename:true approach would miss', () => {
    const patterns = getIgnorePatterns(db);
    const expanded = expandIgnorePatterns(patterns);
    const matcher = picomatch(expanded, { dot: true });

    // These are the cases that were broken before the fix
    expect(matcher('__pycache__/module.pyc')).toBe(true);
    expect(matcher('.cursor/__pycache__/module.pyc')).toBe(true);
    expect(matcher('.git/config')).toBe(true);
    expect(matcher('.cursor/.git/config')).toBe(true);
  });

  it('still matches simple filename patterns at any depth', () => {
    const patterns = getIgnorePatterns(db);
    const expanded = expandIgnorePatterns(patterns);
    const matcher = picomatch(expanded, { dot: true });

    expect(matcher('.DS_Store')).toBe(true);
    expect(matcher('.cursor/.DS_Store')).toBe(true);
    expect(matcher('deep/nested/.DS_Store')).toBe(true);
    expect(matcher('Thumbs.db')).toBe(true);
    expect(matcher('sub/Thumbs.db')).toBe(true);
  });

  it('does not match legitimate files', () => {
    const patterns = getIgnorePatterns(db);
    const expanded = expandIgnorePatterns(patterns);
    const matcher = picomatch(expanded, { dot: true });

    expect(matcher('CLAUDE.md')).toBe(false);
    expect(matcher('.cursor/rules')).toBe(false);
    expect(matcher('.cursorrules')).toBe(false);
    expect(matcher('GEMINI.md')).toBe(false);
  });
});
