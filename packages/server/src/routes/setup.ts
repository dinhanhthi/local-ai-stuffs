import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  config,
  isConfigured,
  getDataDir,
  configure,
  resetConfig,
  ensureMachineId,
} from '../config.js';
import { initStoreRepo, commitStoreChanges } from '../services/store-git.js';
import { initDb } from '../db/index.js';
import { SyncEngine } from '../services/sync-engine.js';
import { registerCurrentMachine, seedMachinesFile, autoLinkRepos } from '../services/machines.js';
import type { AppState } from '../app-state.js';

export function registerSetupRoutes(app: FastifyInstance, state: AppState): void {
  app.get('/api/setup/status', async () => {
    const configured = isConfigured();
    return {
      configured,
      dataDir: configured ? getDataDir() : undefined,
    };
  });

  // Browse directories — needed during setup and normal operation
  app.get<{ Querystring: { path?: string; showDotFiles?: string } }>(
    '/api/browse',
    async (req, reply) => {
      const targetPath = req.query.path || process.env.HOME || '/';
      const showDotFiles = req.query.showDotFiles === 'true';

      try {
        const stat = await fs.stat(targetPath);
        if (!stat.isDirectory()) {
          return reply.code(400).send({ error: 'Not a directory' });
        }
      } catch {
        return reply.code(400).send({ error: 'Path does not exist' });
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && (showDotFiles || !e.name.startsWith('.')))
        .map((e) => ({
          name: e.name,
          path: path.join(targetPath, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const isGitRepo = entries.some((e) => e.name === '.git' && e.isDirectory());

      return {
        current: targetPath,
        parent: path.dirname(targetPath),
        isGitRepo,
        dirs,
      };
    },
  );

  // Create a new folder inside a given parent directory
  app.post<{ Body: { parentPath: string; name: string } }>(
    '/api/browse/mkdir',
    async (req, reply) => {
      const { parentPath, name } = req.body;

      if (!parentPath || !name) {
        return reply.code(400).send({ error: 'parentPath and name are required' });
      }

      const trimmedName = name.trim();
      if (!trimmedName || trimmedName.includes('/') || trimmedName.includes('..')) {
        return reply.code(400).send({ error: 'Invalid folder name' });
      }

      const newPath = path.join(parentPath, trimmedName);

      try {
        await fs.mkdir(newPath, { recursive: true });
      } catch {
        return reply.code(400).send({ error: 'Cannot create folder' });
      }

      return { path: newPath };
    },
  );

  // Reset configuration — returns to setup mode
  app.post('/api/setup/reset', async (_req, _reply) => {
    // Stop sync engine if running
    if (state.syncEngine) {
      await state.syncEngine.stop();
    }

    // Close database
    if (state.db) {
      state.db.close();
    }

    // Clear shared state
    state.db = null;
    state.syncEngine = null;

    // Remove config file
    resetConfig();

    return { success: true };
  });

  app.post<{ Body: { path: string } }>('/api/open-folder', async (req, reply) => {
    const folderPath = req.body?.path;
    if (!folderPath || typeof folderPath !== 'string') {
      return reply.code(400).send({ error: 'path is required' });
    }

    try {
      const stat = await fs.stat(folderPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: 'Path does not exist' });
    }

    const platform = process.platform;
    const cmd =
      platform === 'darwin'
        ? ['open', folderPath]
        : platform === 'win32'
          ? ['explorer', folderPath]
          : ['xdg-open', folderPath];

    execFile(cmd[0], [cmd[1]]);
    return { success: true };
  });

  app.post<{ Body: { dataDir: string } }>('/api/setup', async (req, reply) => {
    const { dataDir } = req.body;

    if (!dataDir || typeof dataDir !== 'string') {
      return reply.code(400).send({ error: 'dataDir is required' });
    }

    const trimmed = dataDir.trim();

    // Validate or create directory
    try {
      await fs.mkdir(trimmed, { recursive: true });
      const stat = await fs.stat(trimmed);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Path is not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: 'Cannot create directory at the specified path' });
    }

    // Save config
    configure(trimmed);
    ensureMachineId();

    // Initialize store repo + DB
    await initStoreRepo();
    const db = initDb(config.dbPath);

    // Register machine and auto-link repos from machines.json
    registerCurrentMachine();
    seedMachinesFile(db);

    const syncEngine = new SyncEngine(db);

    // Populate shared state — all routes will now work
    state.db = db;
    state.syncEngine = syncEngine;

    // Auto-link repos before starting sync engine
    await autoLinkRepos(db);
    await commitStoreChanges(`Setup on ${config.machineName}`);

    // Start sync engine
    await syncEngine.start();

    return { success: true, dataDir: trimmed };
  });
}
