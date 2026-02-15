import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { fileChecksum } from '../services/checksum.js';
import { getFileMtime, ensureDir, fileExists, isSymlink } from '../services/repo-scanner.js';
import type { Repo, TrackedFile } from '../types/index.js';
import type { AppState } from '../app-state.js';
import { mapRow, mapRows } from '../db/index.js';
import {
  safeJoin,
  validateSymlinkTarget,
  PathTraversalError,
  SymlinkTargetError,
} from '../utils/safe-path.js';

/** Remove empty parent directories up to (but not including) stopAt */
async function removeEmptyParents(filePath: string, stopAt: string): Promise<void> {
  let dir = path.dirname(filePath);
  while (dir.length > stopAt.length && dir.startsWith(stopAt)) {
    try {
      await fs.rmdir(dir); // fails if not empty
      dir = path.dirname(dir);
    } catch {
      break;
    }
  }
}

export function registerFileRoutes(app: FastifyInstance, state: AppState): void {
  // List tracked files for a repo
  app.get<{ Params: { id: string } }>('/api/repos/:id/files', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const files = mapRows<TrackedFile>(
      db
        .prepare('SELECT * FROM tracked_files WHERE repo_id = ? ORDER BY relative_path')
        .all(repo.id),
    );

    return { files };
  });

  // Get file content (from store)
  app.get<{ Params: { id: string; '*': string } }>('/api/repos/:id/files/*', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const filePath = req.params['*'];
    const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
    if (!repo) return reply.code(404).send({ error: 'Repo not found' });

    const storeName = repo.storePath.replace(/^repos\//, '');
    let storeFilePath: string;
    try {
      storeFilePath = safeJoin(config.storeReposPath, storeName, filePath);
    } catch (err) {
      if (err instanceof PathTraversalError)
        return reply.code(400).send({ error: 'Invalid file path' });
      throw err;
    }

    try {
      // Check if it's a symlink in store
      if (await isSymlink(storeFilePath)) {
        const target = await fs.readlink(storeFilePath);
        return { type: 'symlink' as const, target, path: filePath };
      }
      const content = await fs.readFile(storeFilePath, 'utf-8');
      return { type: 'file' as const, content, path: filePath };
    } catch {
      return reply.code(404).send({ error: 'File not found in store' });
    }
  });

  // Update file content (writes to store, triggers sync)
  app.put<{ Params: { id: string; '*': string }; Body: { content?: string; target?: string } }>(
    '/api/repos/:id/files/*',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;
      const syncEngine = state.syncEngine;

      const filePath = req.params['*'];
      const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
      if (!repo) return reply.code(404).send({ error: 'Repo not found' });

      const storeName = repo.storePath.replace(/^repos\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeReposPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      const trackedFile = mapRow<TrackedFile>(
        db
          .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
          .get(repo.id, filePath),
      );

      if (trackedFile?.fileType === 'symlink' && req.body.target !== undefined) {
        // Validate symlink target before creating
        try {
          validateSymlinkTarget(req.body.target);
        } catch (err) {
          if (err instanceof SymlinkTargetError)
            return reply.code(400).send({ error: err.message });
          throw err;
        }
        // Update symlink target
        try {
          await fs.unlink(storeFilePath);
        } catch {
          // May not exist
        }
        await ensureDir(path.dirname(storeFilePath));
        await fs.symlink(req.body.target, storeFilePath);
      } else if (req.body.content !== undefined) {
        await ensureDir(path.dirname(storeFilePath));
        await fs.writeFile(storeFilePath, req.body.content, 'utf-8');

        // Update tracked file record
        const checksum = fileChecksum(req.body.content);
        const mtime = await getFileMtime(storeFilePath);

        if (trackedFile) {
          db.prepare(
            `UPDATE tracked_files SET store_checksum = ?, store_mtime = ?, sync_status = 'pending_to_target' WHERE id = ?`,
          ).run(checksum, mtime, trackedFile.id);
        }
      }

      // Trigger sync
      await syncEngine.syncRepo(repo.id);

      return { success: true };
    },
  );

  // Create new file
  app.post<{ Params: { id: string; '*': string }; Body: { content: string } }>(
    '/api/repos/:id/files/*',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;
      const syncEngine = state.syncEngine;

      const filePath = req.params['*'];
      const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
      if (!repo) return reply.code(404).send({ error: 'Repo not found' });

      const storeName = repo.storePath.replace(/^repos\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeReposPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      // Check if file already exists
      if (await fileExists(storeFilePath)) {
        return reply.code(409).send({ error: 'File already exists' });
      }

      await ensureDir(path.dirname(storeFilePath));
      await fs.writeFile(storeFilePath, req.body.content, 'utf-8');

      const checksum = await fileChecksum(storeFilePath);
      const mtime = await getFileMtime(storeFilePath);

      const fileId = uuid();
      db.prepare(
        `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, store_mtime, sync_status)
         VALUES (?, ?, ?, 'file', ?, ?, 'pending_to_target')`,
      ).run(fileId, repo.id, filePath, checksum, mtime);

      await syncEngine.syncRepo(repo.id);

      return reply.code(201).send({ success: true, fileId });
    },
  );

  // Delete file
  app.delete<{ Params: { id: string; '*': string }; Querystring: { storeOnly?: string } }>(
    '/api/repos/:id/files/*',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const filePath = req.params['*'];
      const storeOnly = req.query.storeOnly === 'true';
      const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(req.params.id));
      if (!repo) return reply.code(404).send({ error: 'Repo not found' });

      const storeName = repo.storePath.replace(/^repos\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeReposPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      // Delete from store
      const storeRoot = safeJoin(config.storeReposPath, storeName);
      try {
        await fs.unlink(storeFilePath);
        await removeEmptyParents(storeFilePath, storeRoot);
      } catch {
        // May not exist
      }

      if (!storeOnly) {
        let targetFilePath: string;
        try {
          targetFilePath = safeJoin(repo.localPath, filePath);
        } catch (err) {
          if (err instanceof PathTraversalError)
            return reply.code(400).send({ error: 'Invalid file path' });
          throw err;
        }
        try {
          await fs.unlink(targetFilePath);
          await removeEmptyParents(targetFilePath, repo.localPath);
        } catch {
          // May not exist
        }
      }

      // Remove tracking
      db.prepare('DELETE FROM tracked_files WHERE repo_id = ? AND relative_path = ?').run(
        repo.id,
        filePath,
      );

      return { success: true };
    },
  );
}
