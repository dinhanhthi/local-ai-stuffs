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
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

export function registerCurrentMachine(): void {
  const data = readMachinesFile();
  data.machines[config.machineId] = {
    name: config.machineName,
    lastSeen: new Date().toISOString(),
  };
  writeMachinesFile(data);
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

    unlinked.push({
      storePath,
      storeName: entry,
      serviceType: entry,
      otherMachines,
      suggestedPath,
      pathExists,
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

  return repoId;
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
