import type { FastifyInstance } from 'fastify';
import { v4 as uuid } from 'uuid';
import path from 'node:path';
import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import { config } from '../config.js';
import { ensureDir, isSymlink, symlinkExists, fileExists } from '../services/repo-scanner.js';
import { fileChecksum, symlinkChecksum } from '../services/checksum.js';
import { getFileMtime, getSymlinkMtime } from '../services/repo-scanner.js';
import { commitStoreChanges } from '../services/store-git.js';
import {
  setServiceMapping,
  removeServiceMapping,
  writeServiceMeta,
  removeServiceMeta,
} from '../services/machines.js';
import {
  getServiceDefinition,
  getAllServiceDefinitions,
  getServiceStorePath,
  registerCustomDefinition,
} from '../services/service-definitions.js';
import { scanServiceFiles } from '../services/service-scanner.js';
import { syncSettingsUpdateService, syncSettingsRemoveService } from '../services/sync-settings.js';
import type { ServiceConfig, ServiceConfigWithSummary, TrackedFile } from '../types/index.js';
import type { AppState } from '../app-state.js';
import {
  mapRow,
  mapRows,
  getServiceEffectivePatterns,
  getServiceEnabledPatterns,
  getServiceEffectiveIgnorePatterns,
  getServiceEnabledIgnorePatterns,
  expandIgnorePatterns,
} from '../db/index.js';
import { getFileSizes } from '../services/size-calculator.js';
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

export function registerServiceRoutes(app: FastifyInstance, state: AppState): void {
  // List available service types
  app.get('/api/services/available', async (_req, _reply) => {
    const definitions = getAllServiceDefinitions();
    const results = await Promise.all(
      definitions.map(async (def) => {
        let detected = false;
        try {
          const stat = await fs.stat(def.defaultPath);
          detected = stat.isDirectory();
        } catch {
          // Path doesn't exist
        }

        let registered = false;
        if (state.db) {
          const existing = state.db
            .prepare('SELECT id FROM service_configs WHERE service_type = ?')
            .get(def.serviceType);
          registered = !!existing;
        }

        return {
          serviceType: def.serviceType,
          name: def.name,
          defaultPath: def.defaultPath,
          patterns: def.patterns,
          detected,
          registered,
        };
      }),
    );

    return { services: results };
  });

  // List all registered service configs with sync summary
  app.get('/api/services', async (_req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const rows = db
      .prepare(
        `SELECT sc.*,
          COUNT(tf.id) as total_files,
          SUM(CASE WHEN tf.sync_status = 'synced' THEN 1 ELSE 0 END) as synced_count,
          SUM(CASE WHEN tf.sync_status IN ('pending_to_target','pending_to_store','missing_in_target','missing_in_store') THEN 1 ELSE 0 END) as pending_count,
          SUM(CASE WHEN tf.sync_status = 'conflict' THEN 1 ELSE 0 END) as conflict_count,
          MAX(tf.last_synced_at) as last_synced_at
        FROM service_configs sc
        LEFT JOIN tracked_files tf ON tf.service_config_id = sc.id
        GROUP BY sc.id
        ORDER BY sc.name`,
      )
      .all() as Record<string, unknown>[];

    const result: ServiceConfigWithSummary[] = await Promise.all(
      rows.map(async (row) => {
        const svc = mapRow<ServiceConfig>(row);
        const storeName = svc.storePath.replace(/^services\//, '');
        const storeDir = path.join(config.storeServicesPath, storeName);

        // Calculate size from tracked files only (respects ignore patterns)
        const trackedPaths = (
          db
            .prepare('SELECT relative_path FROM tracked_files WHERE service_config_id = ?')
            .all(svc.id) as { relative_path: string }[]
        ).map((r) => r.relative_path);
        const fileSizes = await getFileSizes(storeDir, trackedPaths);
        const totalStoreSize = [...fileSizes.values()].reduce((sum, s) => sum + s, 0);

        return {
          ...svc,
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

    return { services: result };
  });

  // Get single service config with files
  app.get<{ Params: { id: string } }>('/api/services/:id', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const files = mapRows<TrackedFile>(
      db
        .prepare('SELECT * FROM tracked_files WHERE service_config_id = ? ORDER BY relative_path')
        .all(svc.id),
    );

    const lastSync = db
      .prepare('SELECT MAX(last_synced_at) as last FROM tracked_files WHERE service_config_id = ?')
      .get(svc.id) as { last: string | null };

    const storeName = svc.storePath.replace(/^services\//, '');
    const storeDir = path.join(config.storeServicesPath, storeName);
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
      ...svc,
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

  // Register a new service config
  app.post<{ Body: { serviceType: string } }>('/api/services', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    const { serviceType } = req.body;
    const definition = getServiceDefinition(serviceType);
    if (!definition) {
      return reply.code(400).send({ error: `Unknown service type: ${serviceType}` });
    }

    // Check if already registered
    const existing = db
      .prepare('SELECT id FROM service_configs WHERE service_type = ?')
      .get(serviceType);
    if (existing) {
      return reply.code(409).send({ error: 'Service config already registered' });
    }

    // Validate path exists
    try {
      const stat = await fs.stat(definition.defaultPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Service path is not a directory' });
      }
    } catch {
      return reply
        .code(400)
        .send({ error: `Service path does not exist: ${definition.defaultPath}` });
    }

    const serviceId = uuid();
    const storePath = getServiceStorePath(serviceType);
    const storeDir = path.join(config.storeServicesPath, serviceType);

    // Create store directory
    await ensureDir(storeDir);

    // Scan for files matching service patterns
    const foundEntries = await scanServiceFiles(definition.defaultPath, definition.patterns);

    // Register the service config
    db.prepare(
      'INSERT INTO service_configs (id, service_type, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(serviceId, serviceType, definition.name, definition.defaultPath, storePath, 'active');

    // Track and sync found files
    for (const entry of foundEntries) {
      const fileId = uuid();
      const targetPath = path.join(definition.defaultPath, entry.path);
      const storeFilePath = path.join(storeDir, entry.path);
      const fileType = entry.isSymlink ? 'symlink' : 'file';

      if (entry.isSymlink) {
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
          `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'))`,
        ).run(fileId, serviceId, entry.path, fileType, checksum, checksum, mtime, mtime);
      } else {
        const targetExists = await fileExists(targetPath);
        const storeFileExists = await fileExists(storeFilePath);

        let storeChk: string | null = null;
        let targetChk: string | null = null;
        let syncStatus = 'synced';

        if (targetExists) targetChk = await fileChecksum(targetPath);
        if (storeFileExists) storeChk = await fileChecksum(storeFilePath);

        if (targetExists && !storeFileExists) {
          await ensureDir(path.dirname(storeFilePath));
          await fs.copyFile(targetPath, storeFilePath);
          storeChk = targetChk;
        } else if (!targetExists && storeFileExists) {
          await ensureDir(path.dirname(targetPath));
          await fs.copyFile(storeFilePath, targetPath);
          targetChk = storeChk;
        } else if (targetExists && storeFileExists && storeChk !== targetChk) {
          syncStatus = 'conflict';
        }

        const mtime = (await getFileMtime(targetPath)) || new Date().toISOString();
        db.prepare(
          `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).run(
          fileId,
          serviceId,
          entry.path,
          fileType,
          storeChk,
          targetChk,
          mtime,
          mtime,
          syncStatus,
        );
      }
    }

    // Update machines.json mapping
    setServiceMapping(storePath, definition.defaultPath);

    // Commit store changes (no gitignore for services)
    await commitStoreChanges(`Add service: ${definition.name}`);

    // Start watcher
    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(serviceId),
    );
    await syncEngine.startWatcherForService(svc);

    return reply.code(201).send({
      service: {
        id: serviceId,
        serviceType,
        name: definition.name,
        localPath: definition.defaultPath,
        storePath,
        status: 'active',
      },
      filesTracked: foundEntries.length,
    });
  });

  // Register a custom service
  app.post('/api/services/custom', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;
    const syncEngine = state.syncEngine;

    const parts = req.parts();
    const fields: Record<string, string> = {};
    let iconBuffer: Buffer | null = null;
    let iconMime: string | null = null;

    for await (const part of parts) {
      if (part.type === 'field' && typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      } else if (part.type === 'file' && part.fieldname === 'icon') {
        iconBuffer = await part.toBuffer();
        iconMime = part.mimetype;
      }
    }

    const { name, description, localPath, patterns: patternsJson } = fields;
    if (!name || !localPath || !patternsJson) {
      return reply.code(400).send({ error: 'name, localPath, and patterns are required' });
    }

    let patterns: string[];
    try {
      patterns = JSON.parse(patternsJson);
      if (!Array.isArray(patterns) || patterns.length === 0) {
        return reply.code(400).send({ error: 'At least one pattern is required' });
      }
    } catch {
      return reply.code(400).send({ error: 'patterns must be a valid JSON array' });
    }

    // Generate serviceType from name
    const serviceType =
      'custom-' +
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

    // Check duplicate
    const existing = db
      .prepare('SELECT id FROM service_configs WHERE service_type = ?')
      .get(serviceType);
    if (existing) {
      return reply.code(409).send({ error: `Service "${name}" already exists` });
    }

    // Validate path
    try {
      const stat = await fs.stat(localPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ error: 'Service path is not a directory' });
      }
    } catch {
      return reply.code(400).send({ error: `Service path does not exist: ${localPath}` });
    }

    const serviceId = uuid();
    const storePath = getServiceStorePath(serviceType);
    const storeDir = path.join(config.storeServicesPath, serviceType);
    await ensureDir(storeDir);

    // Save icon if provided
    let iconPath: string | null = null;
    if (iconBuffer && iconMime?.startsWith('image/')) {
      const ext = iconMime.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
      iconPath = `icon.${ext}`;
      await fs.writeFile(path.join(storeDir, iconPath), iconBuffer);
    }

    // Register the custom service definition so scan/settings work
    registerCustomDefinition({
      serviceType,
      name,
      defaultPath: localPath,
      patterns,
    });

    // Write metadata so other machines can link this custom service
    writeServiceMeta(serviceType, { name, patterns, description: description || '' });

    // Scan for matching files
    const foundEntries = await scanServiceFiles(localPath, patterns);

    // Insert into DB
    db.prepare(
      'INSERT INTO service_configs (id, service_type, name, description, local_path, store_path, icon_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      serviceId,
      serviceType,
      name,
      description || '',
      localPath,
      storePath,
      iconPath,
      'active',
    );

    // Store the custom patterns as service_settings
    const insertSetting = db.prepare(
      'INSERT INTO service_settings (id, service_config_id, key, value) VALUES (?, ?, ?, ?)',
    );
    for (const p of patterns) {
      insertSetting.run(uuid(), serviceId, `service_pattern_custom:${p}`, 'enabled');
    }

    // Track and sync found files (same logic as regular service creation)
    for (const entry of foundEntries) {
      const fileId = uuid();
      const targetPath = path.join(localPath, entry.path);
      const storeFilePath = path.join(storeDir, entry.path);
      const fileType = entry.isSymlink ? 'symlink' : 'file';

      if (entry.isSymlink) {
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
          `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synced', datetime('now'))`,
        ).run(fileId, serviceId, entry.path, fileType, checksum, checksum, mtime, mtime);
      } else {
        const targetExists = await fileExists(targetPath);
        const storeFileExists = await fileExists(storeFilePath);

        let storeChk: string | null = null;
        let targetChk: string | null = null;
        let syncStatus = 'synced';

        if (targetExists) targetChk = await fileChecksum(targetPath);
        if (storeFileExists) storeChk = await fileChecksum(storeFilePath);

        if (targetExists && !storeFileExists) {
          await ensureDir(path.dirname(storeFilePath));
          await fs.copyFile(targetPath, storeFilePath);
          storeChk = targetChk;
        } else if (!targetExists && storeFileExists) {
          await ensureDir(path.dirname(targetPath));
          await fs.copyFile(storeFilePath, targetPath);
          targetChk = storeChk;
        } else if (targetExists && storeFileExists && storeChk !== targetChk) {
          syncStatus = 'conflict';
        }

        const mtime = (await getFileMtime(targetPath)) || new Date().toISOString();
        db.prepare(
          `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
        ).run(
          fileId,
          serviceId,
          entry.path,
          fileType,
          storeChk,
          targetChk,
          mtime,
          mtime,
          syncStatus,
        );
      }
    }

    // Update machines.json
    setServiceMapping(storePath, localPath);
    await commitStoreChanges(`Add custom service: ${name}`);

    // Start watcher
    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(serviceId),
    );
    await syncEngine.startWatcherForService(svc);

    return reply.code(201).send({
      service: {
        id: serviceId,
        serviceType,
        name,
        localPath,
        storePath,
        status: 'active',
      },
      filesTracked: foundEntries.length,
    });
  });

  // Get service icon
  app.get<{ Params: { id: string } }>('/api/services/:id/icon', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc || !svc.iconPath) return reply.code(404).send({ error: 'No icon' });

    const storeName = svc.storePath.replace(/^services\//, '');
    const iconFile = path.join(config.storeServicesPath, storeName, svc.iconPath);

    try {
      const data = await fs.readFile(iconFile);
      const ext = path.extname(svc.iconPath).slice(1);
      const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      reply.type(mime).send(data);
    } catch {
      return reply.code(404).send({ error: 'Icon file not found' });
    }
  });

  // Delete service config
  app.delete<{ Params: { id: string }; Querystring: { deleteStoreFiles?: string } }>(
    '/api/services/:id',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;
      const syncEngine = state.syncEngine;

      const svc = mapRow<ServiceConfig>(
        db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
      );
      if (!svc) return reply.code(404).send({ error: 'Service config not found' });

      await syncEngine.stopWatcherForService(svc.id);

      if (req.query.deleteStoreFiles === 'true') {
        const serviceType = svc.storePath.replace(/^services\//, '');
        const storeDir = path.join(config.storeServicesPath, serviceType);
        try {
          await fs.rm(storeDir, { recursive: true });
        } catch {
          // May not exist
        }
        removeServiceMeta(serviceType);
        removeServiceMapping(svc.storePath);
        syncSettingsRemoveService(svc.storePath);
      } else {
        removeServiceMapping(svc.storePath, config.machineId);
      }

      db.prepare('DELETE FROM service_configs WHERE id = ?').run(svc.id);
      await commitStoreChanges(`Remove service: ${svc.name}`);

      return { success: true };
    },
  );

  // Force sync
  app.post<{ Params: { id: string } }>('/api/services/:id/sync', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const result = await state.syncEngine.syncService(svc.id, { force: true });
    return { result };
  });

  // Scan for new files
  app.post<{ Params: { id: string } }>('/api/services/:id/scan', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const definition = getServiceDefinition(svc.serviceType);
    if (!definition) return reply.code(500).send({ error: 'Unknown service type' });

    const patterns = getServiceEnabledPatterns(db, svc.id, definition.patterns);
    const ignorePats = expandIgnorePatterns(getServiceEnabledIgnorePatterns(db, svc.id));
    const foundEntries = await scanServiceFiles(svc.localPath, patterns, ignorePats);
    const existing = db
      .prepare('SELECT relative_path FROM tracked_files WHERE service_config_id = ?')
      .all(svc.id) as { relative_path: string }[];
    const existingPaths = new Set(existing.map((e) => e.relative_path));

    const newFiles: string[] = [];
    for (const entry of foundEntries) {
      if (!existingPaths.has(entry.path)) {
        newFiles.push(entry.path);
        const fileId = uuid();
        db.prepare(
          'INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, sync_status) VALUES (?, ?, ?, ?, ?)',
        ).run(fileId, svc.id, entry.path, entry.isSymlink ? 'symlink' : 'file', 'pending_to_store');
      }
    }

    if (newFiles.length > 0) {
      await state.syncEngine.syncService(svc.id);
    }

    return { newFiles };
  });

  // Pause
  app.post<{ Params: { id: string } }>('/api/services/:id/pause', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });

    state.db
      .prepare(
        "UPDATE service_configs SET status = 'paused', updated_at = datetime('now') WHERE id = ?",
      )
      .run(req.params.id);
    await state.syncEngine.stopWatcherForService(req.params.id);
    return { status: 'paused' };
  });

  // Resume
  app.post<{ Params: { id: string } }>('/api/services/:id/resume', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    db.prepare(
      "UPDATE service_configs SET status = 'active', updated_at = datetime('now') WHERE id = ?",
    ).run(req.params.id);
    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    await state.syncEngine.startWatcherForService(svc);
    await state.syncEngine.syncService(svc.id);
    return { status: 'active' };
  });

  // Get service settings (file patterns with overrides)
  app.get<{ Params: { id: string } }>('/api/services/:id/settings', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const def = getServiceDefinition(svc.serviceType);
    if (!def) return reply.code(500).send({ error: 'Unknown service type' });

    const patterns = getServiceEffectivePatterns(db, svc.id, def.patterns);
    const ignorePatterns = getServiceEffectiveIgnorePatterns(db, svc.id);
    return { patterns, ignorePatterns };
  });

  // Update service settings (file patterns + ignore patterns)
  app.put<{
    Params: { id: string };
    Body: {
      patterns: { pattern: string; enabled: boolean; source: 'default' | 'custom' }[];
      ignorePatterns?: { pattern: string; enabled: boolean; source: 'global' | 'custom' }[];
    };
  }>('/api/services/:id/settings', async (req, reply) => {
    if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const def = getServiceDefinition(svc.serviceType);
    if (!def) return reply.code(500).send({ error: 'Unknown service type' });

    const defaultPatternSet = new Set(def.patterns);

    // Clear all existing pattern settings for this service
    db.prepare(
      "DELETE FROM service_settings WHERE service_config_id = ? AND key LIKE 'service_pattern_%'",
    ).run(svc.id);

    // Insert new settings
    const insert = db.prepare(
      'INSERT INTO service_settings (id, service_config_id, key, value) VALUES (?, ?, ?, ?)',
    );

    for (const p of req.body.patterns) {
      if (p.source === 'custom') {
        // Custom pattern — always store
        insert.run(
          uuid(),
          svc.id,
          `service_pattern_custom:${p.pattern}`,
          p.enabled ? 'enabled' : 'disabled',
        );
      } else if (p.source === 'default' && defaultPatternSet.has(p.pattern)) {
        // Default pattern — only store if disabled (defaults are enabled)
        if (!p.enabled) {
          insert.run(uuid(), svc.id, `service_pattern_default:${p.pattern}`, 'disabled');
        }
      }
    }

    // Save ignore pattern overrides
    if (req.body.ignorePatterns) {
      // Clear existing ignore pattern settings
      db.prepare(
        "DELETE FROM service_settings WHERE service_config_id = ? AND key LIKE 'service_ignore_%'",
      ).run(svc.id);

      const globalIgnorePatterns = db.prepare('SELECT pattern FROM ignore_patterns').all() as {
        pattern: string;
      }[];
      const globalIgnoreSet = new Set(globalIgnorePatterns.map((p) => p.pattern));

      for (const p of req.body.ignorePatterns) {
        if (p.source === 'custom') {
          // Custom ignore pattern — always store
          insert.run(
            uuid(),
            svc.id,
            `service_ignore_custom:${p.pattern}`,
            p.enabled ? 'enabled' : 'disabled',
          );
        } else if (p.source === 'global' && globalIgnoreSet.has(p.pattern)) {
          // Global pattern — only store if toggled differently from global default
          const globalEntry = db
            .prepare('SELECT enabled FROM ignore_patterns WHERE pattern = ?')
            .get(p.pattern) as { enabled: number } | undefined;
          const globalEnabled = globalEntry ? globalEntry.enabled === 1 : true;
          if (p.enabled !== globalEnabled) {
            insert.run(
              uuid(),
              svc.id,
              `service_ignore_override:${p.pattern}`,
              p.enabled ? 'enabled' : 'disabled',
            );
          }
        }
      }
    }

    // Untrack files that now match ignore patterns
    const enabledIgnore = expandIgnorePatterns(getServiceEnabledIgnorePatterns(db, svc.id));
    if (enabledIgnore.length > 0) {
      const matcher = picomatch(enabledIgnore, { dot: true });
      const trackedFiles = db
        .prepare('SELECT id, relative_path FROM tracked_files WHERE service_config_id = ?')
        .all(svc.id) as { id: string; relative_path: string }[];

      const storeName = svc.storePath.replace(/^services\//, '');
      for (const tf of trackedFiles) {
        if (matcher(tf.relative_path)) {
          // Remove from store and target
          const storeFilePath = path.join(config.storeServicesPath, storeName, tf.relative_path);
          try {
            await fs.unlink(storeFilePath);
          } catch {
            // May not exist
          }
          db.prepare('DELETE FROM tracked_files WHERE id = ?').run(tf.id);
        }
      }
    }

    // Restart watcher with new patterns
    await state.syncEngine.stopWatcherForService(svc.id);
    if (svc.status === 'active') {
      await state.syncEngine.startWatcherForService(svc);
    }

    // Persist to sync-settings.json for cross-machine sync
    syncSettingsUpdateService(db, svc.storePath);

    return { success: true };
  });

  // File routes for services
  // List tracked files
  app.get<{ Params: { id: string } }>('/api/services/:id/files', async (req, reply) => {
    if (!state.db) return reply.code(503).send({ error: 'Not configured' });
    const db = state.db;

    const svc = mapRow<ServiceConfig>(
      db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
    );
    if (!svc) return reply.code(404).send({ error: 'Service config not found' });

    const files = mapRows<TrackedFile>(
      db
        .prepare('SELECT * FROM tracked_files WHERE service_config_id = ? ORDER BY relative_path')
        .all(svc.id),
    );

    return { files };
  });

  // Get file content from store
  app.get<{ Params: { id: string; '*': string } }>(
    '/api/services/:id/files/*',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const filePath = req.params['*'];
      const svc = mapRow<ServiceConfig>(
        db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
      );
      if (!svc) return reply.code(404).send({ error: 'Service config not found' });

      const storeName = svc.storePath.replace(/^services\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeServicesPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      try {
        if (await isSymlink(storeFilePath)) {
          const target = await fs.readlink(storeFilePath);
          return { type: 'symlink' as const, target, path: filePath };
        }
        const content = await fs.readFile(storeFilePath, 'utf-8');
        return { type: 'file' as const, content, path: filePath };
      } catch {
        return reply.code(404).send({ error: 'File not found in store' });
      }
    },
  );

  // Update file content
  app.put<{ Params: { id: string; '*': string }; Body: { content?: string; target?: string } }>(
    '/api/services/:id/files/*',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const filePath = req.params['*'];
      const svc = mapRow<ServiceConfig>(
        db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
      );
      if (!svc) return reply.code(404).send({ error: 'Service config not found' });

      const storeName = svc.storePath.replace(/^services\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeServicesPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      const trackedFile = mapRow<TrackedFile>(
        db
          .prepare('SELECT * FROM tracked_files WHERE service_config_id = ? AND relative_path = ?')
          .get(svc.id, filePath),
      );

      if (trackedFile?.fileType === 'symlink' && req.body.target !== undefined) {
        try {
          validateSymlinkTarget(req.body.target);
        } catch (err) {
          if (err instanceof SymlinkTargetError)
            return reply.code(400).send({ error: err.message });
          throw err;
        }
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

        const checksum = fileChecksum(req.body.content);
        const mtime = await getFileMtime(storeFilePath);

        if (trackedFile) {
          db.prepare(
            `UPDATE tracked_files SET store_checksum = ?, store_mtime = ?, sync_status = 'pending_to_target' WHERE id = ?`,
          ).run(checksum, mtime, trackedFile.id);
        }
      }

      await state.syncEngine.syncService(svc.id);
      return { success: true };
    },
  );

  // Create new file
  app.post<{ Params: { id: string; '*': string }; Body: { content: string } }>(
    '/api/services/:id/files/*',
    async (req, reply) => {
      if (!state.db || !state.syncEngine) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const filePath = req.params['*'];
      const svc = mapRow<ServiceConfig>(
        db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
      );
      if (!svc) return reply.code(404).send({ error: 'Service config not found' });

      const storeName = svc.storePath.replace(/^services\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeServicesPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      if (await fileExists(storeFilePath)) {
        return reply.code(409).send({ error: 'File already exists' });
      }

      await ensureDir(path.dirname(storeFilePath));
      await fs.writeFile(storeFilePath, req.body.content, 'utf-8');

      const checksum = await fileChecksum(storeFilePath);
      const mtime = await getFileMtime(storeFilePath);

      const fileId = uuid();
      db.prepare(
        `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, store_mtime, sync_status)
         VALUES (?, ?, ?, 'file', ?, ?, 'pending_to_target')`,
      ).run(fileId, svc.id, filePath, checksum, mtime);

      await state.syncEngine.syncService(svc.id);
      return reply.code(201).send({ success: true, fileId });
    },
  );

  // Delete file
  app.delete<{ Params: { id: string; '*': string }; Querystring: { storeOnly?: string } }>(
    '/api/services/:id/files/*',
    async (req, reply) => {
      if (!state.db) return reply.code(503).send({ error: 'Not configured' });
      const db = state.db;

      const filePath = req.params['*'];
      const storeOnly = req.query.storeOnly === 'true';
      const svc = mapRow<ServiceConfig>(
        db.prepare('SELECT * FROM service_configs WHERE id = ?').get(req.params.id),
      );
      if (!svc) return reply.code(404).send({ error: 'Service config not found' });

      const storeName = svc.storePath.replace(/^services\//, '');
      let storeFilePath: string;
      try {
        storeFilePath = safeJoin(config.storeServicesPath, storeName, filePath);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }

      const storeRoot = safeJoin(config.storeServicesPath, storeName);
      try {
        await fs.unlink(storeFilePath);
        await removeEmptyParents(storeFilePath, storeRoot);
      } catch {
        // May not exist
      }

      if (!storeOnly) {
        let targetFilePath: string;
        try {
          targetFilePath = safeJoin(svc.localPath, filePath);
        } catch (err) {
          if (err instanceof PathTraversalError)
            return reply.code(400).send({ error: 'Invalid file path' });
          throw err;
        }
        try {
          await fs.unlink(targetFilePath);
          await removeEmptyParents(targetFilePath, svc.localPath);
        } catch {
          // May not exist
        }
      }

      db.prepare('DELETE FROM tracked_files WHERE service_config_id = ? AND relative_path = ?').run(
        svc.id,
        filePath,
      );

      return { success: true };
    },
  );
}
