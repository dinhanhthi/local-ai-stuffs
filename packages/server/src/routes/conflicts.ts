import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConflict } from '../services/conflict-detector.js';
import { ensureDir } from '../services/repo-scanner.js';
import { fileChecksum } from '../services/checksum.js';
import { getFileMtime } from '../services/repo-scanner.js';
import { commitStoreChanges } from '../services/store-git.js';
import type { ConflictWithDetails } from '../types/index.js';
import type { AppState } from '../app-state.js';
import { mapRow, mapRows } from '../db/index.js';
import { config } from '../config.js';
import { safeJoin } from '../utils/safe-path.js';

async function refreshConflictContent(
  conflict: ConflictWithDetails & {
    localPath: string;
    storePath: string;
    targetType: 'repo' | 'service';
  },
): Promise<ConflictWithDetails> {
  const storeBasePath =
    conflict.targetType === 'repo'
      ? path.join(config.storeReposPath, conflict.storePath.replace(/^repos\//, ''))
      : path.join(config.storeServicesPath, conflict.storePath.replace(/^services\//, ''));
  const storeFilePath = safeJoin(storeBasePath, conflict.relativePath);
  const targetFilePath = safeJoin(conflict.localPath, conflict.relativePath);

  try {
    conflict.storeContent = await fs.readFile(storeFilePath, 'utf-8');
  } catch {
    // File may have been deleted
  }
  try {
    conflict.targetContent = await fs.readFile(targetFilePath, 'utf-8');
  } catch {
    // File may have been deleted
  }

  // Strip extra fields before returning
  const { localPath: _lp, storePath: _sp, targetType: _tt, ...result } = conflict;
  return result;
}

export function registerConflictRoutes(app: FastifyInstance, state: AppState): void {
  // List all pending conflicts
  app.get('/api/conflicts', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const conflicts = db
      .prepare(
        `SELECT c.*, tf.repo_id, tf.service_config_id, tf.relative_path,
                r.name as repo_name, sc.id as service_id, sc.name as service_name
         FROM conflicts c
         JOIN tracked_files tf ON c.tracked_file_id = tf.id
         LEFT JOIN repos r ON tf.repo_id = r.id
         LEFT JOIN service_configs sc ON tf.service_config_id = sc.id
         WHERE c.status = 'pending'
         ORDER BY c.created_at DESC`,
      )
      .all();

    const result = mapRows<ConflictWithDetails>(conflicts);

    return { conflicts: result };
  });

  // Get conflict detail (reads fresh file content from disk)
  app.get<{ Params: { id: string } }>('/api/conflicts/:id', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const row = db
      .prepare(
        `SELECT c.*, tf.repo_id, tf.service_config_id, tf.relative_path,
                r.name as repo_name, sc.id as service_id, sc.name as service_name,
                COALESCE(r.local_path, sc.local_path) as local_path,
                COALESCE(r.store_path, sc.store_path) as store_path,
                CASE WHEN tf.repo_id IS NOT NULL THEN 'repo' ELSE 'service' END as target_type
         FROM conflicts c
         JOIN tracked_files tf ON c.tracked_file_id = tf.id
         LEFT JOIN repos r ON tf.repo_id = r.id
         LEFT JOIN service_configs sc ON tf.service_config_id = sc.id
         WHERE c.id = ?`,
      )
      .get(req.params.id);

    if (!row) return reply.code(404).send({ error: 'Conflict not found' });

    const conflict = mapRow<
      ConflictWithDetails & { localPath: string; storePath: string; targetType: 'repo' | 'service' }
    >(row);
    return await refreshConflictContent(conflict);
  });

  // Get pending conflict by tracked file id (reads fresh file content from disk)
  app.get<{ Params: { trackedFileId: string } }>(
    '/api/conflicts/by-file/:trackedFileId',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const row = db
        .prepare(
          `SELECT c.*, tf.repo_id, tf.service_config_id, tf.relative_path,
                  r.name as repo_name, sc.id as service_id, sc.name as service_name,
                  COALESCE(r.local_path, sc.local_path) as local_path,
                  COALESCE(r.store_path, sc.store_path) as store_path,
                  CASE WHEN tf.repo_id IS NOT NULL THEN 'repo' ELSE 'service' END as target_type
           FROM conflicts c
           JOIN tracked_files tf ON c.tracked_file_id = tf.id
           LEFT JOIN repos r ON tf.repo_id = r.id
           LEFT JOIN service_configs sc ON tf.service_config_id = sc.id
           WHERE c.tracked_file_id = ? AND c.status = 'pending'`,
        )
        .get(req.params.trackedFileId);

      if (!row) return reply.code(404).send({ error: 'Conflict not found' });

      const conflict = mapRow<
        ConflictWithDetails & {
          localPath: string;
          storePath: string;
          targetType: 'repo' | 'service';
        }
      >(row);
      return await refreshConflictContent(conflict);
    },
  );

  // Resolve a conflict
  app.post<{
    Params: { id: string };
    Body: { resolution: 'keep_store' | 'keep_target' | 'manual' | 'delete'; content?: string };
  }>('/api/conflicts/:id/resolve', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const { resolution, content: manualContent } = req.body;

    const result = await resolveConflict(db, req.params.id, resolution, manualContent);
    if (!result) {
      return reply.code(404).send({ error: 'Conflict not found' });
    }

    const conflict = db
      .prepare(
        `SELECT tf.id as tracked_file_id FROM conflicts c
         JOIN tracked_files tf ON c.tracked_file_id = tf.id
         WHERE c.id = ?`,
      )
      .get(req.params.id) as { tracked_file_id: string };

    if (result.deleted) {
      // Delete both files and remove tracking
      try {
        await fs.unlink(result.storeFilePath);
      } catch {
        // File may already be gone
      }
      try {
        await fs.unlink(result.targetFilePath);
      } catch {
        // File may already be gone
      }
      db.prepare('DELETE FROM tracked_files WHERE id = ?').run(conflict.tracked_file_id);
    } else {
      // Write resolved content to both locations
      await ensureDir(path.dirname(result.storeFilePath));
      await ensureDir(path.dirname(result.targetFilePath));
      await fs.writeFile(result.storeFilePath, result.content, 'utf-8');
      await fs.writeFile(result.targetFilePath, result.content, 'utf-8');

      // Update tracked file checksums
      const checksum = await fileChecksum(result.storeFilePath);
      const mtime = await getFileMtime(result.storeFilePath);
      db.prepare(
        `UPDATE tracked_files SET store_checksum = ?, target_checksum = ?, store_mtime = ?, target_mtime = ?, last_synced_at = datetime('now') WHERE id = ?`,
      ).run(checksum, checksum, mtime, mtime, conflict.tracked_file_id);
    }

    await commitStoreChanges(`[${result.repoName}] Resolve conflict: ${resolution}`);

    return { success: true, resolution };
  });

  // Bulk resolve conflicts for a repo or service
  app.post<{
    Body: {
      repoId?: string;
      serviceId?: string;
      resolution: 'keep_store' | 'keep_target' | 'delete';
    };
  }>('/api/conflicts/bulk-resolve', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const { repoId, serviceId, resolution } = req.body;

    let conflicts: { id: string }[];
    if (repoId) {
      conflicts = db
        .prepare(
          `SELECT c.id FROM conflicts c
           JOIN tracked_files tf ON c.tracked_file_id = tf.id
           WHERE tf.repo_id = ? AND c.status = 'pending'`,
        )
        .all(repoId) as { id: string }[];
    } else if (serviceId) {
      conflicts = db
        .prepare(
          `SELECT c.id FROM conflicts c
           JOIN tracked_files tf ON c.tracked_file_id = tf.id
           WHERE tf.service_config_id = ? AND c.status = 'pending'`,
        )
        .all(serviceId) as { id: string }[];
    } else {
      return reply.code(400).send({ error: 'repoId or serviceId is required' });
    }

    let resolved = 0;
    for (const conflict of conflicts) {
      const result = await resolveConflict(db, conflict.id, resolution);
      if (!result) continue;

      const tf = db
        .prepare(
          `SELECT tf.id as tracked_file_id FROM conflicts c
           JOIN tracked_files tf ON c.tracked_file_id = tf.id
           WHERE c.id = ?`,
        )
        .get(conflict.id) as { tracked_file_id: string };

      if (result.deleted) {
        try {
          await fs.unlink(result.storeFilePath);
        } catch {
          // File may already be gone
        }
        try {
          await fs.unlink(result.targetFilePath);
        } catch {
          // File may already be gone
        }
        db.prepare('DELETE FROM tracked_files WHERE id = ?').run(tf.tracked_file_id);
      } else {
        await ensureDir(path.dirname(result.storeFilePath));
        await ensureDir(path.dirname(result.targetFilePath));
        await fs.writeFile(result.storeFilePath, result.content, 'utf-8');
        await fs.writeFile(result.targetFilePath, result.content, 'utf-8');

        const checksum = await fileChecksum(result.storeFilePath);
        const mtime = await getFileMtime(result.storeFilePath);
        db.prepare(
          `UPDATE tracked_files SET store_checksum = ?, target_checksum = ?, store_mtime = ?, target_mtime = ?, last_synced_at = datetime('now') WHERE id = ?`,
        ).run(checksum, checksum, mtime, mtime, tf.tracked_file_id);
      }
      resolved++;
    }

    if (resolved > 0) {
      const targetName = repoId
        ? ((
            db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as
              | { name: string }
              | undefined
          )?.name ?? repoId)
        : ((
            db.prepare('SELECT name FROM service_configs WHERE id = ?').get(serviceId!) as
              | { name: string }
              | undefined
          )?.name ?? serviceId!);
      await commitStoreChanges(`[${targetName}] Bulk resolve ${resolved} conflicts: ${resolution}`);
    }

    return { success: true, resolved };
  });
}
