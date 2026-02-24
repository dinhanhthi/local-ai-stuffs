import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { mapRows } from '../db/index.js';
import type {
  MachinesFile,
  Repo,
  ServiceConfig,
  UnlinkedStoreRepo,
  UnlinkedStoreService,
  AutoLinkResult,
} from '../types/index.js';
import { scanRepoForAIFiles, ensureDir } from './repo-scanner.js';
import { fileChecksum, symlinkChecksum } from './checksum.js';
import { getFileMtime, getSymlinkMtime, fileExists, symlinkExists } from './repo-scanner.js';
import { setupGitignore } from './gitignore-manager.js';
import { getRepoEnabledFilePatterns } from '../db/index.js';
import { applyOverridesForRepo, applyOverridesForService } from './sync-settings.js';
import { getServiceDefinition, registerCustomDefinition } from './service-definitions.js';
import { scanServiceFiles } from './service-scanner.js';
import { queueStoreCommit } from './store-git.js';

const MACHINES_FILE = 'machines.json';

function getMachinesFilePath(): string {
  return path.join(config.storePath, MACHINES_FILE);
}

function emptyMachinesFile(): MachinesFile {
  return { machines: {}, repos: {}, services: {} };
}

export function readMachinesFile(): MachinesFile {
  const filePath = getMachinesFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      machines: parsed.machines ?? {},
      repos: parsed.repos ?? {},
      services: parsed.services ?? {},
    };
  } catch {
    return emptyMachinesFile();
  }
}

export function writeMachinesFile(data: MachinesFile): void {
  const filePath = getMachinesFilePath();
  // Sort keys for stable JSON output (avoids merge conflicts across machines)
  const sorted: MachinesFile = {
    machines: sortKeys(data.machines),
    repos: sortKeys(data.repos),
    services: sortKeys(data.services),
  };
  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  queueStoreCommit('Update machines.json');
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

/**
 * Register/update the current machine in machines.json.
 * Only writes the file when something meaningful changed:
 * - Machine is new (not in file yet)
 * - Machine name changed
 * - lastSeen is older than 1 day (UI only shows date, not time)
 * This avoids creating a git commit on every server startup.
 */
export function registerCurrentMachine(): void {
  const data = readMachinesFile();
  const existing = data.machines[config.machineId];
  const now = new Date();

  let needsWrite = false;
  if (!existing) {
    needsWrite = true;
  } else if (existing.name !== config.machineName) {
    needsWrite = true;
  } else {
    const lastSeen = new Date(existing.lastSeen);
    const ageMs = now.getTime() - lastSeen.getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      needsWrite = true;
    }
  }

  if (needsWrite) {
    data.machines[config.machineId] = {
      name: config.machineName,
      lastSeen: now.toISOString(),
    };
    writeMachinesFile(data);
  }
}

export function setRepoMapping(storePath: string, localPath: string): void {
  const data = readMachinesFile();
  if (!data.repos[storePath]) {
    data.repos[storePath] = {};
  }
  data.repos[storePath][config.machineId] = { localPath };
  writeMachinesFile(data);
}

export function removeRepoMapping(storePath: string, machineId?: string): void {
  const data = readMachinesFile();
  if (!data.repos[storePath]) return;
  if (machineId) {
    delete data.repos[storePath][machineId];
    if (Object.keys(data.repos[storePath]).length === 0) {
      delete data.repos[storePath];
    }
  } else {
    delete data.repos[storePath];
  }
  writeMachinesFile(data);
}

export function setServiceMapping(storePath: string, localPath: string): void {
  const data = readMachinesFile();
  if (!data.services[storePath]) {
    data.services[storePath] = {};
  }
  data.services[storePath][config.machineId] = { localPath };
  writeMachinesFile(data);
}

export function removeServiceMapping(storePath: string, machineId?: string): void {
  const data = readMachinesFile();
  if (!data.services[storePath]) return;
  if (machineId) {
    delete data.services[storePath][machineId];
    if (Object.keys(data.services[storePath]).length === 0) {
      delete data.services[storePath];
    }
  } else {
    delete data.services[storePath];
  }
  writeMachinesFile(data);
}

export async function getUnlinkedStoreRepos(db: Database.Database): Promise<UnlinkedStoreRepo[]> {
  const machinesData = readMachinesFile();
  const registeredRepos = mapRows<Repo>(db.prepare('SELECT * FROM repos').all());
  const registeredStorePaths = new Set(registeredRepos.map((r) => r.storePath));

  const unlinked: UnlinkedStoreRepo[] = [];

  // Scan store repos directory
  let entries: string[];
  try {
    entries = await fsPromises.readdir(config.storeReposPath);
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (entry === '_default') continue;
    const storePath = `repos/${entry}`;
    if (registeredStorePaths.has(storePath)) continue;

    const fullPath = path.join(config.storeReposPath, entry);
    const stat = await fsPromises.stat(fullPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    // Check other machines' mappings
    const mappings = machinesData.repos[storePath] ?? {};
    const otherMachines: UnlinkedStoreRepo['otherMachines'] = [];
    let suggestedPath: string | null = null;
    let pathExists = false;

    for (const [machineId, mapping] of Object.entries(mappings)) {
      if (machineId === config.machineId) {
        suggestedPath = mapping.localPath;
        try {
          const s = await fsPromises.stat(mapping.localPath);
          pathExists = s.isDirectory();
        } catch {
          pathExists = false;
        }
      } else {
        const machineName = machinesData.machines[machineId]?.name ?? machineId;
        otherMachines.push({ machineId, machineName, localPath: mapping.localPath });
      }
    }

    unlinked.push({
      storePath,
      storeName: entry,
      otherMachines,
      suggestedPath,
      pathExists,
    });
  }

  return unlinked;
}

export async function getUnlinkedStoreServices(
  db: Database.Database,
): Promise<UnlinkedStoreService[]> {
  const machinesData = readMachinesFile();
  const registeredServices = mapRows<ServiceConfig>(
    db.prepare('SELECT * FROM service_configs').all(),
  );
  const registeredStorePaths = new Set(registeredServices.map((s) => s.storePath));

  const unlinked: UnlinkedStoreService[] = [];

  let entries: string[];
  try {
    entries = await fsPromises.readdir(config.storeServicesPath);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const storePath = `services/${entry}`;
    if (registeredStorePaths.has(storePath)) continue;

    const fullPath = path.join(config.storeServicesPath, entry);
    const stat = await fsPromises.stat(fullPath).catch(() => null);
    if (!stat || !stat.isDirectory()) continue;

    const mappings = machinesData.services[storePath] ?? {};
    const otherMachines: UnlinkedStoreService['otherMachines'] = [];
    let suggestedPath: string | null = null;
    let pathExists = false;

    for (const [machineId, mapping] of Object.entries(mappings)) {
      if (machineId === config.machineId) {
        suggestedPath = mapping.localPath;
        try {
          const s = await fsPromises.stat(mapping.localPath);
          pathExists = s.isDirectory();
        } catch {
          pathExists = false;
        }
      } else {
        const machineName = machinesData.machines[machineId]?.name ?? machineId;
        otherMachines.push({ machineId, machineName, localPath: mapping.localPath });
      }
    }

    const definition = getServiceDefinition(entry);
    unlinked.push({
      storePath,
      storeName: entry,
      serviceType: entry,
      otherMachines,
      suggestedPath,
      pathExists,
      defaultPath: definition?.defaultPath ?? null,
      serviceName: definition?.name ?? null,
    });
  }

  return unlinked;
}

/**
 * Seed machines.json with current machine's existing DB repos and services.
 * Only adds mappings that don't already exist for the current machine.
 */
export function seedMachinesFile(db: Database.Database): void {
  const data = readMachinesFile();
  let changed = false;

  const repos = mapRows<Repo>(db.prepare('SELECT * FROM repos').all());
  for (const repo of repos) {
    if (!data.repos[repo.storePath]) {
      data.repos[repo.storePath] = {};
    }
    if (!data.repos[repo.storePath][config.machineId]) {
      data.repos[repo.storePath][config.machineId] = { localPath: repo.localPath };
      changed = true;
    }
  }

  const services = mapRows<ServiceConfig>(db.prepare('SELECT * FROM service_configs').all());
  for (const svc of services) {
    if (!data.services[svc.storePath]) {
      data.services[svc.storePath] = {};
    }
    if (!data.services[svc.storePath][config.machineId]) {
      data.services[svc.storePath][config.machineId] = { localPath: svc.localPath };
      changed = true;
    }
  }

  if (changed) {
    writeMachinesFile(data);
  }
}

/**
 * Auto-link store repos that have mappings for the current machine.
 * Only links repos where the local path exists and the repo isn't already registered.
 */
export async function autoLinkRepos(db: Database.Database): Promise<AutoLinkResult[]> {
  const unlinked = await getUnlinkedStoreRepos(db);
  const results: AutoLinkResult[] = [];

  for (const item of unlinked) {
    if (!item.suggestedPath) continue;

    if (!item.pathExists) {
      results.push({
        storePath: item.storePath,
        localPath: item.suggestedPath,
        status: 'path_missing',
      });
      continue;
    }

    // Check not already registered by local_path
    const existing = db
      .prepare('SELECT id FROM repos WHERE local_path = ?')
      .get(item.suggestedPath);
    if (existing) {
      results.push({
        storePath: item.storePath,
        localPath: item.suggestedPath,
        status: 'already_registered',
      });
      continue;
    }

    // Register the repo
    await linkStoreRepo(db, item.storePath, item.suggestedPath, item.storeName);
    results.push({ storePath: item.storePath, localPath: item.suggestedPath, status: 'linked' });
  }

  return results;
}

/**
 * Link an existing store repo to a local path on this machine.
 * Similar to POST /api/repos but skips store directory creation.
 */
export async function linkStoreRepo(
  db: Database.Database,
  storePath: string,
  localPath: string,
  name?: string,
): Promise<string> {
  const storeName = storePath.replace(/^repos\//, '');
  const repoName = name || storeName;
  const storeDir = path.join(config.storeReposPath, storeName);
  const repoId = uuid();

  // Register the repo in DB
  db.prepare(
    'INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?)',
  ).run(repoId, repoName, localPath, storePath, 'active');

  // Scan for AI files in the target repo
  const foundEntries = await scanRepoForAIFiles(localPath, db);

  // Track files
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
        const linkTarget = await fsPromises.readlink(targetPath);
        await ensureDir(path.dirname(storeFilePath));
        await fsPromises.symlink(linkTarget, storeFilePath);
        checksum = await symlinkChecksum(targetPath);
      } else if (!targetSymExists && storeSymExists) {
        const linkTarget = await fsPromises.readlink(storeFilePath);
        await ensureDir(path.dirname(targetPath));
        await fsPromises.symlink(linkTarget, targetPath);
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
      const targetExists = await fileExists(targetPath);
      const storeFileExists = await fileExists(storeFilePath);

      let storeChk: string | null = null;
      let targetChk: string | null = null;
      let syncStatus = 'synced';

      if (targetExists) targetChk = await fileChecksum(targetPath);
      if (storeFileExists) storeChk = await fileChecksum(storeFilePath);

      if (targetExists && !storeFileExists) {
        await ensureDir(path.dirname(storeFilePath));
        await fsPromises.copyFile(targetPath, storeFilePath);
        storeChk = targetChk;
      } else if (!targetExists && storeFileExists) {
        await ensureDir(path.dirname(targetPath));
        await fsPromises.copyFile(storeFilePath, targetPath);
        targetChk = storeChk;
      } else if (targetExists && storeFileExists && storeChk !== targetChk) {
        syncStatus = 'conflict';
      }

      const mtime = (await getFileMtime(targetPath)) || new Date().toISOString();
      db.prepare(
        `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(fileId, repoId, entry.path, fileType, storeChk, targetChk, mtime, mtime, syncStatus);
    }
  }

  // Also track store-only files (files in store but not in target)
  const storeFiles = await listStoreFiles(storeDir);
  const foundPaths = new Set(foundEntries.map((e) => e.path));
  for (const sf of storeFiles) {
    if (foundPaths.has(sf)) continue;
    const fileId = uuid();
    const storeFilePath = path.join(storeDir, sf);
    const targetPath = path.join(localPath, sf);

    // Copy store file to target
    await ensureDir(path.dirname(targetPath));
    await fsPromises.copyFile(storeFilePath, targetPath);

    const checksum = await fileChecksum(storeFilePath);
    const mtime = (await getFileMtime(storeFilePath)) || new Date().toISOString();

    db.prepare(
      `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
       VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 'synced', datetime('now'))`,
    ).run(fileId, repoId, sf, checksum, checksum, mtime, mtime);
  }

  // Setup gitignore
  const allTrackedPaths = db
    .prepare('SELECT relative_path FROM tracked_files WHERE repo_id = ?')
    .all(repoId) as { relative_path: string }[];
  const trackedPaths = allTrackedPaths.map((r) => r.relative_path);
  const enabledFilePatterns = getRepoEnabledFilePatterns(db, repoId);
  await setupGitignore(localPath, trackedPaths, enabledFilePatterns);

  // Update machines.json mapping
  setRepoMapping(storePath, localPath);

  // Apply deferred settings overrides from sync-settings.json
  applyOverridesForRepo(db, storePath);

  return repoId;
}

interface ServiceMeta {
  name: string;
  patterns: string[];
  description?: string;
}

interface ServicesJsonFile {
  [serviceType: string]: ServiceMeta;
}

function getServicesJsonPath(): string {
  return path.join(config.storeServicesPath, 'services.json');
}

function readServicesJson(): ServicesJsonFile {
  try {
    const raw = fs.readFileSync(getServicesJsonPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeServicesJson(data: ServicesJsonFile): void {
  const sorted: ServicesJsonFile = {};
  for (const key of Object.keys(data).sort()) {
    sorted[key] = data[key];
  }
  fs.writeFileSync(getServicesJsonPath(), JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
}

/**
 * Write metadata for a custom service to services/services.json.
 * This allows linking the service on another machine without access to the original DB.
 */
export function writeServiceMeta(serviceType: string, meta: ServiceMeta): void {
  const data = readServicesJson();
  data[serviceType] = meta;
  writeServicesJson(data);
}

/**
 * Read metadata for a custom service from services/services.json.
 */
function readServiceMeta(serviceType: string): ServiceMeta | null {
  const data = readServicesJson();
  return data[serviceType] ?? null;
}

/**
 * Remove metadata for a service from services/services.json.
 */
export function removeServiceMeta(serviceType: string): void {
  const data = readServicesJson();
  if (serviceType in data) {
    delete data[serviceType];
    writeServicesJson(data);
  }
}

/**
 * Link an existing store service to a local path on this machine.
 * Similar to POST /api/services but reuses existing store files.
 */
export async function linkStoreService(
  db: Database.Database,
  storePath: string,
  localPath: string,
): Promise<string> {
  const serviceType = storePath.replace(/^services\//, '');
  const storeDir = path.join(config.storeServicesPath, serviceType);

  // Look up definition (built-in or custom via metadata)
  let definition = getServiceDefinition(serviceType);
  let customPatterns: string[] | null = null;

  if (!definition) {
    // Custom service — read metadata from services.json
    const meta = readServiceMeta(serviceType);
    if (!meta) {
      throw new Error(
        `Unknown service type "${serviceType}" and no metadata found in services.json`,
      );
    }
    customPatterns = meta.patterns;
    registerCustomDefinition({
      serviceType,
      name: meta.name,
      defaultPath: localPath,
      patterns: meta.patterns,
    });
    definition = getServiceDefinition(serviceType)!;
  }

  const serviceName = definition.name;
  const serviceId = uuid();

  // Get patterns to scan with
  const patterns = customPatterns ?? definition.patterns;

  // Check for custom service icon in store
  let iconPath: string | null = null;
  try {
    const storeEntries = await fsPromises.readdir(storeDir);
    const iconFile = storeEntries.find((f) => f.startsWith('icon.'));
    if (iconFile) iconPath = iconFile;
  } catch {
    // No icon
  }

  // Read description from metadata if available
  const meta = readServiceMeta(serviceType);
  const description = meta?.description ?? '';

  // Register the service config in DB
  db.prepare(
    'INSERT INTO service_configs (id, service_type, name, description, local_path, store_path, icon_path, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(serviceId, serviceType, serviceName, description, localPath, storePath, iconPath, 'active');

  // If custom, store patterns in service_settings
  if (customPatterns) {
    const insertSetting = db.prepare(
      'INSERT INTO service_settings (id, service_config_id, key, value) VALUES (?, ?, ?, ?)',
    );
    for (const p of customPatterns) {
      insertSetting.run(uuid(), serviceId, `service_pattern_custom:${p}`, 'enabled');
    }
  }

  // Scan for files matching service patterns in the local directory
  const foundEntries = await scanServiceFiles(localPath, patterns);

  // Track and sync found files
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
        const linkTarget = await fsPromises.readlink(targetPath);
        await ensureDir(path.dirname(storeFilePath));
        await fsPromises.symlink(linkTarget, storeFilePath);
        checksum = await symlinkChecksum(targetPath);
      } else if (!targetSymExists && storeSymExists) {
        const linkTarget = await fsPromises.readlink(storeFilePath);
        await ensureDir(path.dirname(targetPath));
        await fsPromises.symlink(linkTarget, targetPath);
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
        await fsPromises.copyFile(targetPath, storeFilePath);
        storeChk = targetChk;
      } else if (!targetExists && storeFileExists) {
        await ensureDir(path.dirname(targetPath));
        await fsPromises.copyFile(storeFilePath, targetPath);
        targetChk = storeChk;
      } else if (targetExists && storeFileExists && storeChk !== targetChk) {
        syncStatus = 'conflict';
      }

      const mtime = (await getFileMtime(targetPath)) || new Date().toISOString();
      db.prepare(
        `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(fileId, serviceId, entry.path, fileType, storeChk, targetChk, mtime, mtime, syncStatus);
    }
  }

  // Also track store-only files (files in store but not scanned from target)
  const storeFiles = await listStoreFiles(storeDir);
  const foundPaths = new Set(foundEntries.map((e) => e.path));
  for (const sf of storeFiles) {
    if (foundPaths.has(sf)) continue;
    if (sf.startsWith('icon.')) continue;
    const fileId = uuid();
    const storeFilePath = path.join(storeDir, sf);
    const targetPath = path.join(localPath, sf);

    await ensureDir(path.dirname(targetPath));
    await fsPromises.copyFile(storeFilePath, targetPath);

    const checksum = await fileChecksum(storeFilePath);
    const mtime = (await getFileMtime(storeFilePath)) || new Date().toISOString();

    db.prepare(
      `INSERT INTO tracked_files (id, service_config_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at)
       VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 'synced', datetime('now'))`,
    ).run(fileId, serviceId, sf, checksum, checksum, mtime, mtime);
  }

  // Update machines.json mapping
  setServiceMapping(storePath, localPath);

  // Apply deferred settings overrides from sync-settings.json
  applyOverridesForService(db, storePath);

  return serviceId;
}

/**
 * Auto-link store services that have mappings for the current machine.
 * For built-in services without a suggestedPath, also tries the platform defaultPath.
 */
export async function autoLinkServices(db: Database.Database): Promise<AutoLinkResult[]> {
  const unlinked = await getUnlinkedStoreServices(db);
  const results: AutoLinkResult[] = [];

  for (const item of unlinked) {
    // Determine the path to try: suggestedPath first, then defaultPath for built-in services
    let tryPath = item.suggestedPath;
    let tryPathExists = item.pathExists;

    if (!tryPath && item.defaultPath) {
      tryPath = item.defaultPath;
      try {
        const s = await fsPromises.stat(item.defaultPath);
        tryPathExists = s.isDirectory();
      } catch {
        tryPathExists = false;
      }
    }

    if (!tryPath) continue;

    if (!tryPathExists) {
      results.push({
        storePath: item.storePath,
        localPath: tryPath,
        status: 'path_missing',
      });
      continue;
    }

    // Check not already registered by service_type
    const existing = db
      .prepare('SELECT id FROM service_configs WHERE service_type = ?')
      .get(item.serviceType);
    if (existing) {
      results.push({
        storePath: item.storePath,
        localPath: tryPath,
        status: 'already_registered',
      });
      continue;
    }

    await linkStoreService(db, item.storePath, tryPath);
    results.push({ storePath: item.storePath, localPath: tryPath, status: 'linked' });
  }

  return results;
}

async function listStoreFiles(dir: string, base = ''): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push(...(await listStoreFiles(path.join(dir, entry.name), rel)));
      } else {
        result.push(rel);
      }
    }
  } catch {
    // Directory may not exist
  }
  return result;
}
