import type { FastifyInstance } from 'fastify';
import type { SyncLogEntry } from '../types/index.js';
import type { AppState } from '../app-state.js';
import { mapRows } from '../db/index.js';
import { pullStoreChanges, pushStoreChanges, getStoreRemoteUrl } from '../services/store-git.js';

interface SyncLogEntryWithRepo extends SyncLogEntry {
  repoName: string | null;
}

export function registerSyncRoutes(app: FastifyInstance, state: AppState): void {
  // Force sync all repos
  app.post('/api/sync/trigger', async (_req, reply) => {
    if (!state.syncEngine) return reply.code(503).send({ error: 'Not configured' });

    await state.syncEngine.syncAllRepos({ force: true });
    return { success: true };
  });

  // Pull store changes from remote
  app.post('/api/store/pull', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    try {
      const result = await pullStoreChanges();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull failed';
      return reply.code(500).send({ error: message });
    }
  });

  // Push store changes to remote
  app.post('/api/store/push', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    try {
      const result = await pushStoreChanges();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Push failed';
      return reply.code(500).send({ error: message });
    }
  });

  // Get store remote URL
  app.get('/api/store/remote', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    try {
      const url = await getStoreRemoteUrl();
      return { url };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get remote';
      return reply.code(500).send({ error: message });
    }
  });

  // Get sync log (recent events, paginated)
  app.get<{ Querystring: { limit?: string; offset?: string } }>(
    '/api/sync/log',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const limit = parseInt(req.query.limit || '50', 10);
      const offset = parseInt(req.query.offset || '0', 10);

      const entries = mapRows<SyncLogEntryWithRepo>(
        db
          .prepare(
            `SELECT sl.*, r.name as repo_name
           FROM sync_log sl
           LEFT JOIN repos r ON sl.repo_id = r.id
           ORDER BY sl.created_at DESC
           LIMIT ? OFFSET ?`,
          )
          .all(limit, offset),
      );

      const total = db.prepare('SELECT COUNT(*) as count FROM sync_log').get() as {
        count: number;
      };

      return {
        entries,
        total: total.count,
      };
    },
  );
}
