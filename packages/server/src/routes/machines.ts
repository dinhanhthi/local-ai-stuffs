import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { config, updateMachineName } from '../config.js';
import path from 'node:path';
import {
  readMachinesFile,
  registerCurrentMachine,
  getUnlinkedStoreRepos,
  getUnlinkedStoreServices,
  linkStoreRepo,
  autoLinkRepos,
  removeRepoMapping,
} from '../services/machines.js';
import { commitStoreChanges } from '../services/store-git.js';
import { mapRow } from '../db/index.js';
import type { Repo } from '../types/index.js';
import type { AppState } from '../app-state.js';

export function registerMachineRoutes(app: FastifyInstance, state: AppState): void {
  // Get current machine info
  app.get('/api/machines/current', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    return {
      machineId: config.machineId,
      machineName: config.machineName,
    };
  });

  // Update current machine name
  app.put<{ Body: { name: string } }>('/api/machines/current', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    const { name } = req.body;
    if (!name || typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ error: 'name is required' });
    }

    updateMachineName(name.trim());
    registerCurrentMachine();
    await commitStoreChanges(`Update machine name to ${name.trim()}`);

    return { success: true, machineName: config.machineName };
  });

  // List all known machines
  app.get('/api/machines', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    const data = readMachinesFile();
    const machines = Object.entries(data.machines).map(([id, info]) => ({
      id,
      name: info.name,
      lastSeen: info.lastSeen,
      isCurrent: id === config.machineId,
    }));

    return { machines };
  });

  // Get unlinked store repos and services
  app.get('/api/machines/unlinked', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    const repos = await getUnlinkedStoreRepos(state.db);
    const services = await getUnlinkedStoreServices(state.db);

    return { repos, services };
  });

  // Link an existing store repo to a local path
  app.post<{
    Body: { storePath: string; localPath: string; name?: string };
  }>('/api/machines/link-repo', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });

    const { storePath, localPath, name } = req.body;

    if (!storePath || !localPath) {
      return reply.code(400).send({ error: 'storePath and localPath are required' });
    }

    // Validate local path exists
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: 'Path does not exist' });
    }

    // Check if already registered
    const existing = state.db.prepare('SELECT id FROM repos WHERE local_path = ?').get(localPath);
    if (existing) {
      return reply.code(409).send({ error: 'Repository already registered at this path' });
    }

    const existingStore = state.db
      .prepare('SELECT id FROM repos WHERE store_path = ?')
      .get(storePath);
    if (existingStore) {
      return reply.code(409).send({ error: 'Store path already linked' });
    }

    const repoId = await linkStoreRepo(state.db, storePath, localPath, name);
    await commitStoreChanges(`Link ${name || storePath} on ${config.machineName}`);

    // Start watcher
    const repo = mapRow<Repo>(state.db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId));
    await state.syncEngine.startWatcherForRepo(repo);

    return reply.code(201).send({ repoId, storePath, localPath });
  });

  // Auto-link all repos with valid mappings for this machine
  app.post('/api/machines/auto-link', async (_req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });

    const results = await autoLinkRepos(state.db);

    // Start watchers for newly linked repos
    for (const result of results) {
      if (result.status === 'linked') {
        const repo = mapRow<Repo>(
          state.db.prepare('SELECT * FROM repos WHERE store_path = ?').get(result.storePath),
        );
        if (repo) {
          await state.syncEngine.startWatcherForRepo(repo);
        }
      }
    }

    if (results.some((r) => r.status === 'linked')) {
      await commitStoreChanges(`Auto-link repos on ${config.machineName}`);
    }

    return { results };
  });

  // Delete an unlinked store repo (removes store files + all machine mappings)
  app.delete<{
    Body: { storePath: string };
  }>('/api/machines/unlinked-repo', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });

    const { storePath } = req.body;
    if (!storePath || typeof storePath !== 'string') {
      return reply.code(400).send({ error: 'storePath is required' });
    }

    // Ensure this repo is truly unlinked (not in DB)
    const existing = state.db.prepare('SELECT id FROM repos WHERE store_path = ?').get(storePath);
    if (existing) {
      return reply.code(409).send({ error: 'Repository is linked — delete it from the dashboard' });
    }

    // Remove store directory
    const storeDir = path.join(config.storePath, storePath);
    try {
      await fs.rm(storeDir, { recursive: true });
    } catch {
      // May not exist
    }

    // Remove all machine mappings
    removeRepoMapping(storePath);

    await commitStoreChanges(`Delete unlinked repo: ${storePath}`);

    return { success: true };
  });
}
