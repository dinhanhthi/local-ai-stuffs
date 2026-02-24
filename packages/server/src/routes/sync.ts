import type { FastifyInstance } from 'fastify';
import type { SyncLogEntry } from '../types/index.js';
import type { AppState } from '../app-state.js';
import { mapRows } from '../db/index.js';
import {
  pullStoreChanges,
  pushStoreChanges,
  getStoreRemoteUrl,
  resolveStoreConfigConflict,
} from '../services/store-git.js';
import { restoreSettingsFromFile } from '../services/sync-settings.js';

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

    // Suppress watcher events during pull to prevent races where
    // watcher-triggered syncs run before conflict resolution completes
    state.syncEngine?.enterPullMode();

    try {
      const result = await pullStoreChanges();

      // If there are repo/service file conflicts from the merge, create
      // conflict records so the user can resolve them in the UI.
      // The merge was completed with "ours" for conflicted files, so
      // syncAfterPull will handle non-conflicting changes normally.
      if (result.repoFileConflicts && result.repoFileConflicts.length > 0 && state.syncEngine) {
        await state.syncEngine.handleMergeConflicts(result.repoFileConflicts);

        // Merge was completed (not aborted) — sync non-conflicting files
        if (result.prePullCommitHash) {
          state.syncEngine.syncAfterPull(result.prePullCommitHash).catch((err) => {
            console.error('Post-pull sync failed:', err);
          });
        } else {
          state.syncEngine.leavePullMode();
        }
      } else if (result.pulled && result.prePullCommitHash && state.syncEngine) {
        // No conflicts — trigger normal sync using the pre-pull base
        // so the engine correctly detects remote changes vs local changes.
        // syncAfterPull handles releasing pull mode in its finally block.
        state.syncEngine.syncAfterPull(result.prePullCommitHash).catch((err) => {
          console.error('Post-pull sync failed:', err);
        });
      } else {
        state.syncEngine?.leavePullMode();
      }

      return result;
    } catch (err) {
      state.syncEngine?.leavePullMode();
      const message = err instanceof Error ? err.message : 'Pull failed';
      return reply.code(500).send({ error: message });
    }
  });

  // Resolve a store config conflict (sync-settings.json or machines.json)
  app.post<{
    Params: { file: string };
    Body: { content: string };
  }>('/api/store/resolve-config/:file', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const file = req.params.file;
    if (file !== 'sync-settings.json' && file !== 'machines.json') {
      return reply.code(400).send({ error: 'Invalid file name' });
    }

    const { content } = req.body;
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'Missing content' });
    }

    try {
      await resolveStoreConfigConflict(file, content);

      // Reload settings into DB if sync-settings.json was resolved
      if (file === 'sync-settings.json') {
        restoreSettingsFromFile(db);
      }

      return { resolved: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Resolve failed';
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
