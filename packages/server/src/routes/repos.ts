import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import { config } from '../config.js';
import {
  scanRepoForAIFiles,
  deriveStoreName,
  ensureDir,
  symlinkExists,
} from '../services/repo-scanner.js';
import { fileChecksum, symlinkChecksum } from '../services/checksum.js';
import { getFileMtime, getSymlinkMtime, fileExists } from '../services/repo-scanner.js';
import { setupGitignore } from '../services/gitignore-manager.js';
import { commitStoreChanges } from '../services/store-git.js';
import { setRepoMapping, removeRepoMapping } from '../services/machines.js';
import type { Repo, RepoWithSummary, TrackedFile } from '../types/index.js';
import type { AppState } from '../app-state.js';
import {
  mapRow,
  mapRows,
  getEffectiveFilePatterns,
  getEffectiveIgnorePatterns,
  getRepoEffectiveSettings,
  getRepoEnabledFilePatterns,
  getRepoIgnorePatterns,
  expandIgnorePatterns,
} from '../db/index.js';
import { getDirectorySize, getFileSizes } from '../services/size-calculator.js';

export function registerRepoRoutes(app: FastifyInstance, state: AppState): void {
  // List all repos with sync summary
  app.get('/api/repos', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const rows = db
      .prepare(
        `SELECT r.*,
          COUNT(tf.id) as total_files,
          SUM(CASE WHEN tf.sync_status = 'synced' THEN 1 ELSE 0 END) as synced_count,
          SUM(CASE WHEN tf.sync_status IN ('pending_to_target','pending_to_store','missing_in_target','missing_in_store') THEN 1 ELSE 0 END) as pending_count,
          SUM(CASE WHEN tf.sync_status = 'conflict' THEN 1 ELSE 0 END) as conflict_count,
          MAX(tf.last_synced_at) as last_synced_at
        FROM repos r
        LEFT JOIN tracked_files tf ON tf.repo_id = r.id
        GROUP BY r.id
        ORDER BY r.name`,
      )
      .all() as Record<string, unknown>[];

    const result: RepoWithSummary[] = await Promise.all(
      rows.map(async (row) => {
        const repo = mapRow<Repo>(row);
        const storeName = repo.storePath.replace(/^repos\//, '');
        const storeDir = path.join(config.storeReposPath, storeName);
        const totalStoreSize = await getDirectorySize(storeDir);

        return {
          ...repo,
          syncSummary: {
            total: Number(row.total_files) || 0,
            synced: Number(row.synced_count) || 0,
            pending: Number(row.pending_count) || 0,
            conflicts: Number(row.conflict_count) || 0,
            totalStoreSize,
          },
          lastSyncedAt: (row.last_synced_at as string | null) ?? null,
        };
      }),
    );

    return { repos: result };
  });

  // Get single repo
  app.get<{ Params: { id: string } }>('/api/repos/:id', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));

    if (!repo) {
      return reply.code(404).send({ error: 'Repo not found' });
    }

    const files = mapRows<TrackedFile>(
      db
        .prepare('SELECT * FROM tracked_files WHERE repo_id = ? ORDER BY relative_path')
        .all(repo.id),
    );

    const lastSync = db
      .prepare('SELECT MAX(last_synced_at) as last FROM tracked_files WHERE repo_id = ?')
      .get(repo.id) as { last: string | null };

    const storeName = repo.storePath.replace(/^repos\//, '');
    const storeDir = path.join(config.storeReposPath, storeName);
    const fileSizes = await getFileSizes(
      storeDir,
      files.map((f) => f.relativePath),
    );
    const totalStoreSize = [...fileSizes.values()].reduce((sum, s) => sum + s, 0);

    const filesWithSize = files.map((f) => ({
      ...f,
      storeSize: fileSizes.get(f.relativePath) ?? 0,
    }));

    return {
      ...repo,
      files: filesWithSize,
      syncSummary: {
        total: files.length,
        synced: files.filter((f) => f.syncStatus === 'synced').length,
        pending: files.filter((f) =>
          ['pending_to_target', 'pending_to_store'].includes(f.syncStatus),
        ).length,
        conflicts: files.filter((f) => f.syncStatus === 'conflict').length,
        totalStoreSize,
      },
      lastSyncedAt: lastSync.last,
    };
  });

  // Register a new repo
  app.post<{
    Body: { localPath: string; name?: string; applyTemplate?: boolean };
  }>('/api/repos', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    const { localPath, name, applyTemplate } = req.body;

    // Validate path exists
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: 'Path does not exist' });
    }

    // Check if already registered
    const existing = db.prepare('SELECT id FROM repos WHERE local_path = ?').get(localPath);
    if (existing) {
      return reply.code(409).send({ error: 'Repository already registered' });
    }

    const repoName = name || path.basename(localPath);
    const storeName = deriveStoreName(localPath);
    const storePath = `repos/${storeName}`;
    const storeDir = path.join(config.storeReposPath, storeName);

    const repoId = uuid();

    // Create store directory
    await ensureDir(storeDir);

    // Apply default template if requested
    if (applyTemplate) {
      const templateDir = path.join(config.storeReposPath, '_default');
      try {
        await copyDirRecursive(templateDir, storeDir);
      } catch {
        // No template or copy failed, continue
      }
    }

    // Scan for existing AI files in target repo
    const foundEntries = await scanRepoForAIFiles(localPath, db);

    // Register the repo
    db.prepare(
      'INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?)',
    ).run(repoId, repoName, localPath, storePath, 'active');

    // Track and sync found files
    for (const entry of foundEntries) {
      const fileId = uuid();
      const targetPath = path.join(localPath, entry.path);
      const storeFilePath = path.join(storeDir, entry.path);
      const fileType = entry.isSymlink ? 'symlink' : 'file';

      if (entry.isSymlink) {
        // Symlink entry: copy the symlink itself
        const targetSymExists = await symlinkExists(targetPath);
        const storeSymExists = await symlinkExists(storeFilePath);

        let checksum: string | null = null;
        if (targetSymExists && !storeSymExists) {
          const linkTarget = await fs.readlink(targetPath);
          await ensureDir(path.dirname(storeFilePath));
          await fs.symlink(linkTarget, storeFilePath);
          checksum = await symlinkChecksum(targetPath);
        } else if (!targetSymExists && storeSymExists) {
          const linkTarget = await fs.readlink(storeFilePath);
          await ensureDir(path.dirname(targetPath));
          await fs.symlink(linkTarget, targetPath);
          checksum = await symlinkChecksum(storeFilePath);
        } else if (targetSymExists) {
          checksum = await symlinkChecksum(targetPath);
        }

        const mtime = (await getSymlinkMtime(targetPath)) || new Date().toISOString();
        db.prepare(
          `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'))`,
        ).run(fileId, repoId, entry.path, fileType, checksum, checksum, mtime, mtime);
      } else {
        // Regular file
        const targetExists = await fileExists(targetPath);
        const storeFileExists = await fileExists(storeFilePath);

        let storeChk: string | null = null;
        let targetChk: string | null = null;
        let syncStatus = 'synced';

        if (targetExists) {
          targetChk = await fileChecksum(targetPath);
        }
        if (storeFileExists) {
          storeChk = await fileChecksum(storeFilePath);
        }

        if (targetExists && !storeFileExists) {
          // Copy from target to store
          await ensureDir(path.dirname(storeFilePath));
          await fs.copyFile(targetPath, storeFilePath);
          storeChk = targetChk;
        } else if (!targetExists && storeFileExists) {
          // Copy from store to target (template or re-attach scenario)
          await ensureDir(path.dirname(targetPath));
          await fs.copyFile(storeFilePath, targetPath);
          targetChk = storeChk;
        } else if (targetExists && storeFileExists && storeChk !== targetChk) {
          // Both exist but differ — mark as needing attention
          syncStatus = 'conflict';
        }

        const mtime = (await getFileMtime(targetPath)) || new Date().toISOString();

        db.prepare(
          `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).run(fileId, repoId, entry.path, fileType, storeChk, targetChk, mtime, mtime, syncStatus);
      }
    }

    // Also check for template files that don't exist in target yet
    if (applyTemplate) {
      const templateFiles = await listFilesRecursive(storeDir);
      for (const tf of templateFiles) {
        const alreadyTracked = foundEntries.some((e) => e.path === tf);
        if (!alreadyTracked) {
          const fileId = uuid();
          const storeFilePath = path.join(storeDir, tf);
          const targetPath = path.join(localPath, tf);

          // Copy template file to target
          await ensureDir(path.dirname(targetPath));
          await fs.copyFile(storeFilePath, targetPath);

          const checksum = await fileChecksum(storeFilePath);
          const mtime = await getFileMtime(storeFilePath);

          db.prepare(
            `INSERT INTO tracked_files (id, repo_id, relative_path, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'))`,
          ).run(fileId, repoId, tf, checksum, checksum, mtime, mtime);
        }
      }
    }

    // Setup gitignore and remove from git tracking
    const allTrackedPaths = db
      .prepare('SELECT relative_path FROM tracked_files WHERE repo_id = ?')
      .all(repoId) as { relative_path: string }[];
    const trackedPaths = allTrackedPaths.map((r) => r.relative_path);
    const enabledFilePatterns = getRepoEnabledFilePatterns(db, repoId);

    const gitignoreResult = await setupGitignore(localPath, trackedPaths, enabledFilePatterns);

    // Update machines.json mapping
    setRepoMapping(storePath, localPath);

    // Commit store changes
    await commitStoreChanges(`Add ${repoName}`);

    // Start watcher
    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
    await syncEngine.startWatcherForRepo(repo);

    return reply.code(201).send({
      repo: { id: repoId, name: repoName, localPath, storePath, status: 'active' },
      filesTracked: foundEntries.length,
      gitignore: gitignoreResult,
    });
  });

  // Update repo
  app.put<{
    Params: { id: string };
    Body: { name?: string; status?: string; isFavorite?: boolean };
  }>('/api/repos/:id', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (req.body.name) {
      updates.push('name = ?');
      values.push(req.body.name);
    }
    if (req.body.status) {
      updates.push('status = ?');
      values.push(req.body.status);
    }
    if (req.body.isFavorite !== undefined) {
      updates.push('is_favorite = ?');
      values.push(req.body.isFavorite ? 1 : 0);
    }

    if (updates.length > 0) {
      updates.push("updated_at = datetime('now')");
      values.push(req.params.id);
      db.prepare(`UPDATE repos SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    }

    const updated = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    return { repo: updated };
  });

  // Delete repo
  app.delete<{ Params: { id: string }; Querystring: { deleteStoreFiles?: string } }>(
    '/api/repos/:id',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;
      const syncEngine = state.syncEngine;

      const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
      if (!repo) return reply.code(404).send({ error: 'Repo not found' });

      await syncEngine.stopWatcherForRepo(repo.id);

      if (req.query.deleteStoreFiles === 'true') {
        const storeDir = path.join(config.storeReposPath, repo.storePath.replace(/^repos\//, ''));
        try {
          await fs.rm(storeDir, { recursive: true });
        } catch {
          // May not exist
        }
        // Remove all machine mappings when deleting store files
        removeRepoMapping(repo.storePath);
      } else {
        // Only remove current machine's mapping
        removeRepoMapping(repo.storePath, config.machineId);
      }

      db.prepare('DELETE FROM repos WHERE id = ?').run(repo.id);
      await commitStoreChanges(`Remove ${repo.name}`);

      return { success: true };
    },
  );

  // Force sync for a repo
  app.post<{ Params: { id: string } }>('/api/repos/:id/sync', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const result = await syncEngine.syncRepo(repo.id, { force: true });
    return { result };
  });

  // Scan repo for new AI files
  app.post<{ Params: { id: string } }>('/api/repos/:id/scan', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const foundEntries = await scanRepoForAIFiles(repo.localPath, db, repo.id);
    const existing = db
      .prepare('SELECT relative_path FROM tracked_files WHERE repo_id = ?')
      .all(repo.id) as { relative_path: string }[];
    const existingPaths = new Set(existing.map((e) => e.relative_path));

    const newFiles: string[] = [];
    for (const entry of foundEntries) {
      if (!existingPaths.has(entry.path)) {
        newFiles.push(entry.path);
        const fileId = uuid();
        db.prepare(
          'INSERT INTO tracked_files (id, repo_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        ).run(
          fileId,
          repo.id,
          entry.path,
          entry.isSymlink ? 'symlink' : 'file',
          'pending_to_store',
        );
      }
    }

    // Sync new files
    if (newFiles.length > 0) {
      await syncEngine.syncRepo(repo.id);
    }

    return { newFiles };
  });

  // Apply .gitignore to target repo
  app.post<{ Params: { id: string } }>('/api/repos/:id/apply-gitignore', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const trackedPaths = (
      db.prepare('SELECT relative_path FROM tracked_files WHERE repo_id = ?').all(repo.id) as {
        relative_path: string;
      }[]
    ).map((r) => r.relative_path);
    const enabledPatterns = getRepoEnabledFilePatterns(db, repo.id);

    const result = await setupGitignore(repo.localPath, trackedPaths, enabledPatterns);
    return { success: true, ...result };
  });

  // Pause syncing
  app.post<{ Params: { id: string } }>('/api/repos/:id/pause', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });

    state.db
      .prepare("UPDATE repos SET status = 'paused', updated_at = datetime('now') WHERE id = ?")
      .run(req.params.id);
    await state.syncEngine.stopWatcherForRepo(req.params.id);
    return { status: 'paused' };
  });

  // Resume syncing
  app.post<{ Params: { id: string } }>('/api/repos/:id/resume', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    db.prepare("UPDATE repos SET status = 'active', updated_at = datetime('now') WHERE id = ?").run(
      req.params.id,
    );
    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    await syncEngine.startWatcherForRepo(repo);
    await syncEngine.syncRepo(repo.id);
    return { status: 'active' };
  });

  // Get repo-level settings (merged with global, showing source)
  app.get<{ Params: { id: string } }>('/api/repos/:id/settings', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = db.prepare('SELECT id FROM repos WHERE id = ?').get(req.params.id);
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    return {
      settings: getRepoEffectiveSettings(db, req.params.id),
      filePatterns: getEffectiveFilePatterns(db, req.params.id),
      ignorePatterns: getEffectiveIgnorePatterns(db, req.params.id),
    };
  });

  // Update repo-level settings (save overrides)
  app.put<{
    Params: { id: string };
    Body: {
      settings?: Record<string, string | null>;
      filePatterns?: { pattern: string; enabled: boolean; source: 'global' | 'local' }[];
      ignorePatterns?: { pattern: string; enabled: boolean; source: 'global' | 'local' }[];
    };
  }>('/api/repos/:id/settings', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = db.prepare('SELECT id FROM repos WHERE id = ?').get(req.params.id);
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const repoId = req.params.id;
    const upsert = db.prepare(
      'INSERT INTO repo_settings (id, repo_id, key, value) VALUES (?, ?, ?, ?) ON CONFLICT(repo_id, key) DO UPDATE SET value = ?',
    );
    const remove = db.prepare('DELETE FROM repo_settings WHERE repo_id = ? AND key = ?');

    // Handle general settings overrides
    if (req.body.settings) {
      for (const [key, value] of Object.entries(req.body.settings)) {
        if (value === null) {
          // Remove override (revert to global)
          remove.run(repoId, key);
        } else {
          upsert.run(uuid(), repoId, key, value, value);
        }
      }
    }

    // Handle file pattern overrides
    if (req.body.filePatterns) {
      // Clear all existing file pattern overrides for this repo
      db.prepare("DELETE FROM repo_settings WHERE repo_id = ? AND key LIKE 'file_pattern_%'").run(
        repoId,
      );

      // Get global patterns for comparison
      const globalPatterns = db
        .prepare('SELECT pattern, enabled FROM file_patterns ORDER BY pattern')
        .all() as { pattern: string; enabled: number }[];
      const globalMap = new Map(globalPatterns.map((p) => [p.pattern, p.enabled === 1]));

      for (const fp of req.body.filePatterns) {
        if (fp.source === 'local') {
          // Local-only pattern
          const key = `file_pattern_local:${fp.pattern}`;
          upsert.run(
            uuid(),
            repoId,
            key,
            fp.enabled ? 'enabled' : 'disabled',
            fp.enabled ? 'enabled' : 'disabled',
          );
        } else {
          // Global pattern — only save if different from global
          const globalEnabled = globalMap.get(fp.pattern);
          if (globalEnabled !== undefined && globalEnabled !== fp.enabled) {
            const key = `file_pattern_override:${fp.pattern}`;
            upsert.run(
              uuid(),
              repoId,
              key,
              fp.enabled ? 'enabled' : 'disabled',
              fp.enabled ? 'enabled' : 'disabled',
            );
          }
        }
      }
    }

    // Handle ignore pattern overrides
    if (req.body.ignorePatterns) {
      db.prepare("DELETE FROM repo_settings WHERE repo_id = ? AND key LIKE 'ignore_pattern_%'").run(
        repoId,
      );

      const globalPatterns = db
        .prepare('SELECT pattern, enabled FROM ignore_patterns ORDER BY pattern')
        .all() as { pattern: string; enabled: number }[];
      const globalMap = new Map(globalPatterns.map((p) => [p.pattern, p.enabled === 1]));

      for (const ip of req.body.ignorePatterns) {
        if (ip.source === 'local') {
          const key = `ignore_pattern_local:${ip.pattern}`;
          upsert.run(
            uuid(),
            repoId,
            key,
            ip.enabled ? 'enabled' : 'disabled',
            ip.enabled ? 'enabled' : 'disabled',
          );
        } else {
          const globalEnabled = globalMap.get(ip.pattern);
          if (globalEnabled !== undefined && globalEnabled !== ip.enabled) {
            const key = `ignore_pattern_override:${ip.pattern}`;
            upsert.run(
              uuid(),
              repoId,
              key,
              ip.enabled ? 'enabled' : 'disabled',
              ip.enabled ? 'enabled' : 'disabled',
            );
          }
        }
      }

      // Untrack files that now match ignore patterns
      const enabledIgnore = expandIgnorePatterns(getRepoIgnorePatterns(db, repoId));
      if (enabledIgnore.length > 0) {
        const matcher = picomatch(enabledIgnore, { dot: true });
        const trackedFiles = db
          .prepare('SELECT id, relative_path FROM tracked_files WHERE repo_id = ?')
          .all(repoId) as { id: string; relative_path: string }[];

        const repoRow = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
        const storeName = repoRow?.storePath?.replace(/^repos\//, '') ?? '';
        for (const tf of trackedFiles) {
          if (matcher(tf.relative_path)) {
            const storeFilePath = path.join(config.storeReposPath, storeName, tf.relative_path);
            try {
              await fs.unlink(storeFilePath);
            } catch {
              // May not exist
            }
            db.prepare('DELETE FROM tracked_files WHERE id = ?').run(tf.id);
          }
        }
      }
    }

    // Restart watcher if ignore patterns changed
    if (req.body.ignorePatterns && state.syncEngine) {
      const repoRow = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
      if (repoRow && repoRow.status === 'active') {
        await state.syncEngine.stopWatcherForRepo(repoRow.id);
        await state.syncEngine.startWatcherForRepo(repoRow);
      }
    }

    return { success: true };
  });
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function listFilesRecursive(dir: string, base = ''): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
      } else {
        result.push(rel);
      }
    }
  } catch {
    // Directory may not exist
  }
  return result;
}
