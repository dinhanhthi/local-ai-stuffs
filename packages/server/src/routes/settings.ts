import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import picomatch from 'picomatch';
import { v4 as uuid } from 'uuid';
import type { AppState } from '../app-state.js';
import { config } from '../config.js';
import {
  expandIgnorePatterns,
  getIgnorePatterns,
  getRepoEnabledFilePatterns,
  mapRows,
} from '../db/index.js';
import { DEFAULT_PATTERNS, DEFAULT_IGNORE_PATTERNS } from '../db/schema.js';
import { setupGitignore } from '../services/gitignore-manager.js';
import { commitStoreChanges } from '../services/store-git.js';
import {
  syncSettingsUpdateGlobal,
  syncSettingsUpdateFilePatterns,
  syncSettingsUpdateIgnorePatterns,
} from '../services/sync-settings.js';
import type { Repo, TrackedFile } from '../types/index.js';

export function registerSettingsRoutes(app: FastifyInstance, state: AppState): void {
  // Get all settings
  app.get('/api/settings', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const settings = db.prepare('SELECT * FROM settings').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const s of settings) {
      result[s.key] = s.value;
    }
    return { settings: result };
  });

  // Update settings
  app.put<{ Body: Record<string, string> }>('/api/settings', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    );

    for (const [key, value] of Object.entries(req.body)) {
      upsert.run(key, value, value);
    }

    syncSettingsUpdateGlobal(db);
    return { success: true };
  });

  // Get file patterns
  app.get('/api/patterns', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const defaultSet = new Set(DEFAULT_PATTERNS);
    const patterns = db.prepare('SELECT * FROM file_patterns ORDER BY pattern').all() as {
      id: string;
      pattern: string;
      enabled: number;
    }[];

    return {
      patterns: patterns.map((p) => ({
        id: p.id,
        pattern: p.pattern,
        enabled: p.enabled === 1,
        source: (defaultSet.has(p.pattern) ? 'default' : 'user') as 'default' | 'user',
      })),
    };
  });

  // Get ignore patterns
  app.get('/api/ignore-patterns', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const defaultSet = new Set(DEFAULT_IGNORE_PATTERNS);
    const patterns = db.prepare('SELECT * FROM ignore_patterns ORDER BY pattern').all() as {
      id: string;
      pattern: string;
      enabled: number;
    }[];

    return {
      patterns: patterns.map((p) => ({
        id: p.id,
        pattern: p.pattern,
        enabled: p.enabled === 1,
        source: (defaultSet.has(p.pattern) ? 'default' : 'user') as 'default' | 'user',
      })),
    };
  });

  // Update ignore patterns
  app.put<{ Body: { patterns: { id?: string; pattern: string; enabled: boolean }[] } }>(
    '/api/ignore-patterns',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      db.prepare('DELETE FROM ignore_patterns').run();

      const insert = db.prepare(
        'INSERT INTO ignore_patterns (id, pattern, enabled) VALUES (?, ?, ?)',
      );

      for (const p of req.body.patterns) {
        insert.run(p.id || uuid(), p.pattern, p.enabled ? 1 : 0);
      }

      syncSettingsUpdateIgnorePatterns(db);
      return { success: true };
    },
  );

  // Remove tracked files matching ignore patterns
  // scope: 'both' (default) | 'target' | 'store'
  app.post<{ Querystring: { scope?: string } }>(
    '/api/ignore-patterns/clean',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;
      const scope = (req.query.scope as 'both' | 'target' | 'store') || 'both';

      const ignorePatterns = expandIgnorePatterns(getIgnorePatterns(db));
      if (ignorePatterns.length === 0) {
        return { success: true, removed: 0, files: [] };
      }

      const matcher = picomatch(ignorePatterns, { dot: true });

      const repos = mapRows<Repo>(db.prepare('SELECT * FROM repos').all());
      const allTracked = mapRows<TrackedFile>(db.prepare('SELECT * FROM tracked_files').all());

      const removedFiles: string[] = [];

      for (const file of allTracked) {
        if (!matcher(file.relativePath)) continue;

        const repo = repos.find((r) => r.id === file.repoId);
        if (!repo) continue;

        const storeName = repo.storePath.replace(/^repos\//, '');
        const storeFilePath = path.join(config.storeReposPath, storeName, file.relativePath);
        const targetFilePath = path.join(repo.localPath, file.relativePath);

        if (scope === 'both' || scope === 'store') {
          try {
            await fs.unlink(storeFilePath);
          } catch {
            // May not exist
          }
        }
        if (scope === 'both' || scope === 'target') {
          try {
            await fs.unlink(targetFilePath);
          } catch {
            // May not exist
          }
        }

        // Remove related conflicts
        db.prepare('DELETE FROM conflicts WHERE tracked_file_id = ?').run(file.id);

        // Remove tracking
        db.prepare('DELETE FROM tracked_files WHERE id = ?').run(file.id);

        removedFiles.push(`${repo.name}/${file.relativePath}`);
      }

      if (removedFiles.length > 0 && (scope === 'both' || scope === 'store')) {
        await commitStoreChanges(`Clean ${removedFiles.length} ignored file(s)`);
      }

      return { success: true, removed: removedFiles.length, files: removedFiles };
    },
  );

  // Apply .gitignore to all active repos
  app.post('/api/apply-gitignore', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const activeRepos = mapRows<Repo>(
      db.prepare("SELECT * FROM repos WHERE status = 'active'").all(),
    );

    let totalAdded = 0;
    let totalRemoved = 0;
    for (const repo of activeRepos) {
      const trackedPaths = (
        db.prepare('SELECT relative_path FROM tracked_files WHERE repo_id = ?').all(repo.id) as {
          relative_path: string;
        }[]
      ).map((r) => r.relative_path);
      const enabledPatterns = getRepoEnabledFilePatterns(db, repo.id);
      const result = await setupGitignore(repo.localPath, trackedPaths, enabledPatterns);
      totalAdded += result.addedPatterns.length;
      totalRemoved += result.removedFromGit.length;
    }

    return {
      success: true,
      reposProcessed: activeRepos.length,
      totalAdded,
      totalRemoved,
    };
  });

  // Update file patterns
  app.put<{ Body: { patterns: { id?: string; pattern: string; enabled: boolean }[] } }>(
    '/api/patterns',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      // Replace all patterns
      db.prepare('DELETE FROM file_patterns').run();

      const insert = db.prepare(
        'INSERT INTO file_patterns (id, pattern, enabled) VALUES (?, ?, ?)',
      );

      for (const p of req.body.patterns) {
        insert.run(p.id || uuid(), p.pattern, p.enabled ? 1 : 0);
      }

      syncSettingsUpdateFilePatterns(db);
      return { success: true };
    },
  );
}
