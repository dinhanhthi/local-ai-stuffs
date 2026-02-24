import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import type Database from 'better-sqlite3';
import { config } from '../config.js';
import { mapRows } from '../db/index.js';
import { DEFAULT_SETTINGS } from '../db/schema.js';
import type { Repo, ServiceConfig } from '../types/index.js';
import { queueStoreCommit } from './store-git.js';

// ── Types ────────────────────────────────────────────────────────────

export interface RepoOverrideEntry {
  settings?: Record<string, string>;
  filePatternOverrides?: Record<string, string>;
  filePatternLocal?: Record<string, string>;
  ignorePatternOverrides?: Record<string, string>;
  ignorePatternLocal?: Record<string, string>;
}

export interface ServiceOverrideEntry {
  patternDefaults?: Record<string, string>;
  patternCustom?: Record<string, string>;
  ignoreOverrides?: Record<string, string>;
  ignoreCustom?: Record<string, string>;
}

export interface SyncSettingsFile {
  settings: Record<string, string>;
  filePatterns: { pattern: string; enabled: boolean }[];
  ignorePatterns: { pattern: string; enabled: boolean }[];
  repoOverrides: Record<string, RepoOverrideEntry>;
  serviceOverrides: Record<string, ServiceOverrideEntry>;
}

// ── Helpers ──────────────────────────────────────────────────────────

const SYNC_SETTINGS_FILE = 'sync-settings.json';

function getSyncSettingsFilePath(): string {
  return path.join(config.storePath, SYNC_SETTINGS_FILE);
}

function emptySyncSettings(): SyncSettingsFile {
  return {
    settings: {},
    filePatterns: [],
    ignorePatterns: [],
    repoOverrides: {},
    serviceOverrides: {},
  };
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const sorted: Record<string, T> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted;
}

function sortKeysDeep(
  obj: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const sorted: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(obj).sort()) {
    const inner = obj[key];
    const sortedInner: Record<string, unknown> = {};
    for (const k of Object.keys(inner).sort()) {
      const val = inner[k];
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        sortedInner[k] = sortKeys(val as Record<string, string>);
      } else {
        sortedInner[k] = val;
      }
    }
    sorted[key] = sortedInner;
  }
  return sorted;
}

/** Remove empty sub-objects from an override entry */
function cleanOverride(entry: Record<string, unknown>): Record<string, unknown> | null {
  const cleaned: Record<string, unknown> = {};
  let hasContent = false;
  for (const [k, v] of Object.entries(entry)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
      continue;
    }
    cleaned[k] = v;
    hasContent = true;
  }
  return hasContent ? cleaned : null;
}

// ── File I/O ─────────────────────────────────────────────────────────

export function readSyncSettingsFile(): SyncSettingsFile {
  const filePath = getSyncSettingsFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      settings: parsed.settings ?? {},
      filePatterns: parsed.filePatterns ?? [],
      ignorePatterns: parsed.ignorePatterns ?? [],
      repoOverrides: parsed.repoOverrides ?? {},
      serviceOverrides: parsed.serviceOverrides ?? {},
    };
  } catch {
    return emptySyncSettings();
  }
}

export function writeSyncSettingsFile(data: SyncSettingsFile): void {
  const filePath = getSyncSettingsFilePath();

  // Clean overrides: remove entries with no actual overrides
  const cleanedRepoOverrides: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(data.repoOverrides)) {
    const cleaned = cleanOverride(v as unknown as Record<string, unknown>);
    if (cleaned) cleanedRepoOverrides[k] = cleaned;
  }

  const cleanedServiceOverrides: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(data.serviceOverrides)) {
    const cleaned = cleanOverride(v as unknown as Record<string, unknown>);
    if (cleaned) cleanedServiceOverrides[k] = cleaned;
  }

  const sorted = {
    settings: sortKeys(data.settings),
    filePatterns: [...data.filePatterns].sort((a, b) => a.pattern.localeCompare(b.pattern)),
    ignorePatterns: [...data.ignorePatterns].sort((a, b) => a.pattern.localeCompare(b.pattern)),
    repoOverrides: sortKeysDeep(cleanedRepoOverrides),
    serviceOverrides: sortKeysDeep(cleanedServiceOverrides),
  };

  fs.writeFileSync(filePath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8');
  queueStoreCommit('Update sync-settings.json');
}

// ── Read DB state into file sections ─────────────────────────────────

function readGlobalSettingsFromDb(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT * FROM settings').all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key === 'schema_version') continue;
    // Only store non-default values
    if (DEFAULT_SETTINGS[row.key] === row.value) continue;
    result[row.key] = row.value;
  }
  return result;
}

function readFilePatternsFromDb(db: Database.Database): { pattern: string; enabled: boolean }[] {
  const rows = db.prepare('SELECT pattern, enabled FROM file_patterns ORDER BY pattern').all() as {
    pattern: string;
    enabled: number;
  }[];
  return rows.map((r) => ({ pattern: r.pattern, enabled: r.enabled === 1 }));
}

function readIgnorePatternsFromDb(db: Database.Database): { pattern: string; enabled: boolean }[] {
  const rows = db
    .prepare('SELECT pattern, enabled FROM ignore_patterns ORDER BY pattern')
    .all() as { pattern: string; enabled: number }[];
  return rows.map((r) => ({ pattern: r.pattern, enabled: r.enabled === 1 }));
}

function readRepoOverridesFromDb(db: Database.Database): Record<string, RepoOverrideEntry> {
  const repos = mapRows<Repo>(db.prepare('SELECT * FROM repos').all());
  const result: Record<string, RepoOverrideEntry> = {};

  for (const repo of repos) {
    const rows = db
      .prepare('SELECT key, value FROM repo_settings WHERE repo_id = ?')
      .all(repo.id) as { key: string; value: string }[];

    if (rows.length === 0) continue;

    const entry: RepoOverrideEntry = {};
    const settings: Record<string, string> = {};
    const filePatternOverrides: Record<string, string> = {};
    const filePatternLocal: Record<string, string> = {};
    const ignorePatternOverrides: Record<string, string> = {};
    const ignorePatternLocal: Record<string, string> = {};

    for (const row of rows) {
      if (row.key.startsWith('file_pattern_override:')) {
        filePatternOverrides[row.key.slice('file_pattern_override:'.length)] = row.value;
      } else if (row.key.startsWith('file_pattern_local:')) {
        filePatternLocal[row.key.slice('file_pattern_local:'.length)] = row.value;
      } else if (row.key.startsWith('ignore_pattern_override:')) {
        ignorePatternOverrides[row.key.slice('ignore_pattern_override:'.length)] = row.value;
      } else if (row.key.startsWith('ignore_pattern_local:')) {
        ignorePatternLocal[row.key.slice('ignore_pattern_local:'.length)] = row.value;
      } else {
        settings[row.key] = row.value;
      }
    }

    if (Object.keys(settings).length > 0) entry.settings = settings;
    if (Object.keys(filePatternOverrides).length > 0)
      entry.filePatternOverrides = filePatternOverrides;
    if (Object.keys(filePatternLocal).length > 0) entry.filePatternLocal = filePatternLocal;
    if (Object.keys(ignorePatternOverrides).length > 0)
      entry.ignorePatternOverrides = ignorePatternOverrides;
    if (Object.keys(ignorePatternLocal).length > 0) entry.ignorePatternLocal = ignorePatternLocal;

    result[repo.storePath] = entry;
  }

  return result;
}

function readServiceOverridesFromDb(db: Database.Database): Record<string, ServiceOverrideEntry> {
  const services = mapRows<ServiceConfig>(db.prepare('SELECT * FROM service_configs').all());
  const result: Record<string, ServiceOverrideEntry> = {};

  for (const svc of services) {
    const rows = db
      .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ?')
      .all(svc.id) as { key: string; value: string }[];

    if (rows.length === 0) continue;

    const entry: ServiceOverrideEntry = {};
    const patternDefaults: Record<string, string> = {};
    const patternCustom: Record<string, string> = {};
    const ignoreOverrides: Record<string, string> = {};
    const ignoreCustom: Record<string, string> = {};

    for (const row of rows) {
      if (row.key.startsWith('service_pattern_default:')) {
        patternDefaults[row.key.slice('service_pattern_default:'.length)] = row.value;
      } else if (row.key.startsWith('service_pattern_custom:')) {
        patternCustom[row.key.slice('service_pattern_custom:'.length)] = row.value;
      } else if (row.key.startsWith('service_ignore_override:')) {
        ignoreOverrides[row.key.slice('service_ignore_override:'.length)] = row.value;
      } else if (row.key.startsWith('service_ignore_custom:')) {
        ignoreCustom[row.key.slice('service_ignore_custom:'.length)] = row.value;
      }
    }

    if (Object.keys(patternDefaults).length > 0) entry.patternDefaults = patternDefaults;
    if (Object.keys(patternCustom).length > 0) entry.patternCustom = patternCustom;
    if (Object.keys(ignoreOverrides).length > 0) entry.ignoreOverrides = ignoreOverrides;
    if (Object.keys(ignoreCustom).length > 0) entry.ignoreCustom = ignoreCustom;

    result[svc.storePath] = entry;
  }

  return result;
}

// ── Full export / restore ────────────────────────────────────────────

export function exportSettingsToFile(db: Database.Database): void {
  const data: SyncSettingsFile = {
    settings: readGlobalSettingsFromDb(db),
    filePatterns: readFilePatternsFromDb(db),
    ignorePatterns: readIgnorePatternsFromDb(db),
    repoOverrides: readRepoOverridesFromDb(db),
    serviceOverrides: readServiceOverridesFromDb(db),
  };
  writeSyncSettingsFile(data);
}

export function restoreSettingsFromFile(db: Database.Database): void {
  const filePath = getSyncSettingsFilePath();
  if (!fs.existsSync(filePath)) return;

  const data = readSyncSettingsFile();

  // Restore global settings
  const upsertSetting = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  );
  for (const [key, value] of Object.entries(data.settings)) {
    if (key === 'schema_version') continue;
    upsertSetting.run(key, value, value);
  }

  // Restore file patterns (replace all)
  if (data.filePatterns.length > 0) {
    db.prepare('DELETE FROM file_patterns').run();
    const insertPattern = db.prepare(
      'INSERT INTO file_patterns (id, pattern, enabled) VALUES (?, ?, ?)',
    );
    for (const p of data.filePatterns) {
      insertPattern.run(uuid(), p.pattern, p.enabled ? 1 : 0);
    }
  }

  // Restore ignore patterns (replace all)
  if (data.ignorePatterns.length > 0) {
    db.prepare('DELETE FROM ignore_patterns').run();
    const insertIgnore = db.prepare(
      'INSERT INTO ignore_patterns (id, pattern, enabled) VALUES (?, ?, ?)',
    );
    for (const p of data.ignorePatterns) {
      insertIgnore.run(uuid(), p.pattern, p.enabled ? 1 : 0);
    }
  }

  // Restore repo overrides
  for (const [storePath, overrides] of Object.entries(data.repoOverrides)) {
    const repo = db.prepare('SELECT id FROM repos WHERE store_path = ?').get(storePath) as
      | { id: string }
      | undefined;
    if (!repo) continue; // Repo not linked on this machine yet — deferred

    applyRepoOverridesToDb(db, repo.id, overrides);
  }

  // Restore service overrides
  for (const [storePath, overrides] of Object.entries(data.serviceOverrides)) {
    const svc = db.prepare('SELECT id FROM service_configs WHERE store_path = ?').get(storePath) as
      | { id: string }
      | undefined;
    if (!svc) continue; // Service not linked on this machine yet — deferred

    applyServiceOverridesToDb(db, svc.id, overrides);
  }
}

/**
 * On startup: if sync-settings.json exists, restore it to DB.
 * If not, export current DB state to the file (migration for existing users).
 */
export function restoreOrMigrateSettings(db: Database.Database): void {
  const filePath = getSyncSettingsFilePath();
  if (fs.existsSync(filePath)) {
    restoreSettingsFromFile(db);
    console.log('Restored settings from sync-settings.json');
  } else {
    exportSettingsToFile(db);
    console.log('Exported settings to sync-settings.json (first-time migration)');
  }
}

// ── Apply overrides to DB ────────────────────────────────────────────

function applyRepoOverridesToDb(
  db: Database.Database,
  repoId: string,
  overrides: RepoOverrideEntry,
): void {
  // Clear existing overrides for this repo
  db.prepare('DELETE FROM repo_settings WHERE repo_id = ?').run(repoId);

  const insert = db.prepare(
    'INSERT INTO repo_settings (id, repo_id, key, value) VALUES (?, ?, ?, ?)',
  );

  if (overrides.settings) {
    for (const [key, value] of Object.entries(overrides.settings)) {
      insert.run(uuid(), repoId, key, value);
    }
  }

  if (overrides.filePatternOverrides) {
    for (const [pattern, value] of Object.entries(overrides.filePatternOverrides)) {
      insert.run(uuid(), repoId, `file_pattern_override:${pattern}`, value);
    }
  }

  if (overrides.filePatternLocal) {
    for (const [pattern, value] of Object.entries(overrides.filePatternLocal)) {
      insert.run(uuid(), repoId, `file_pattern_local:${pattern}`, value);
    }
  }

  if (overrides.ignorePatternOverrides) {
    for (const [pattern, value] of Object.entries(overrides.ignorePatternOverrides)) {
      insert.run(uuid(), repoId, `ignore_pattern_override:${pattern}`, value);
    }
  }

  if (overrides.ignorePatternLocal) {
    for (const [pattern, value] of Object.entries(overrides.ignorePatternLocal)) {
      insert.run(uuid(), repoId, `ignore_pattern_local:${pattern}`, value);
    }
  }
}

function applyServiceOverridesToDb(
  db: Database.Database,
  serviceId: string,
  overrides: ServiceOverrideEntry,
): void {
  // Clear existing overrides for this service
  db.prepare('DELETE FROM service_settings WHERE service_config_id = ?').run(serviceId);

  const insert = db.prepare(
    'INSERT INTO service_settings (id, service_config_id, key, value) VALUES (?, ?, ?, ?)',
  );

  if (overrides.patternDefaults) {
    for (const [pattern, value] of Object.entries(overrides.patternDefaults)) {
      insert.run(uuid(), serviceId, `service_pattern_default:${pattern}`, value);
    }
  }

  if (overrides.patternCustom) {
    for (const [pattern, value] of Object.entries(overrides.patternCustom)) {
      insert.run(uuid(), serviceId, `service_pattern_custom:${pattern}`, value);
    }
  }

  if (overrides.ignoreOverrides) {
    for (const [pattern, value] of Object.entries(overrides.ignoreOverrides)) {
      insert.run(uuid(), serviceId, `service_ignore_override:${pattern}`, value);
    }
  }

  if (overrides.ignoreCustom) {
    for (const [pattern, value] of Object.entries(overrides.ignoreCustom)) {
      insert.run(uuid(), serviceId, `service_ignore_custom:${pattern}`, value);
    }
  }
}

// ── Granular updates (called from route handlers) ────────────────────

export function syncSettingsUpdateGlobal(db: Database.Database): void {
  const data = readSyncSettingsFile();
  data.settings = readGlobalSettingsFromDb(db);
  writeSyncSettingsFile(data);
}

export function syncSettingsUpdateFilePatterns(db: Database.Database): void {
  const data = readSyncSettingsFile();
  data.filePatterns = readFilePatternsFromDb(db);
  writeSyncSettingsFile(data);
}

export function syncSettingsUpdateIgnorePatterns(db: Database.Database): void {
  const data = readSyncSettingsFile();
  data.ignorePatterns = readIgnorePatternsFromDb(db);
  writeSyncSettingsFile(data);
}

export function syncSettingsUpdateRepo(db: Database.Database, storePath: string): void {
  const data = readSyncSettingsFile();

  const repo = db.prepare('SELECT id FROM repos WHERE store_path = ?').get(storePath) as
    | { id: string }
    | undefined;
  if (!repo) return;

  const rows = db
    .prepare('SELECT key, value FROM repo_settings WHERE repo_id = ?')
    .all(repo.id) as { key: string; value: string }[];

  if (rows.length === 0) {
    delete data.repoOverrides[storePath];
  } else {
    const entry: RepoOverrideEntry = {};
    const settings: Record<string, string> = {};
    const filePatternOverrides: Record<string, string> = {};
    const filePatternLocal: Record<string, string> = {};
    const ignorePatternOverrides: Record<string, string> = {};
    const ignorePatternLocal: Record<string, string> = {};

    for (const row of rows) {
      if (row.key.startsWith('file_pattern_override:')) {
        filePatternOverrides[row.key.slice('file_pattern_override:'.length)] = row.value;
      } else if (row.key.startsWith('file_pattern_local:')) {
        filePatternLocal[row.key.slice('file_pattern_local:'.length)] = row.value;
      } else if (row.key.startsWith('ignore_pattern_override:')) {
        ignorePatternOverrides[row.key.slice('ignore_pattern_override:'.length)] = row.value;
      } else if (row.key.startsWith('ignore_pattern_local:')) {
        ignorePatternLocal[row.key.slice('ignore_pattern_local:'.length)] = row.value;
      } else {
        settings[row.key] = row.value;
      }
    }

    if (Object.keys(settings).length > 0) entry.settings = settings;
    if (Object.keys(filePatternOverrides).length > 0)
      entry.filePatternOverrides = filePatternOverrides;
    if (Object.keys(filePatternLocal).length > 0) entry.filePatternLocal = filePatternLocal;
    if (Object.keys(ignorePatternOverrides).length > 0)
      entry.ignorePatternOverrides = ignorePatternOverrides;
    if (Object.keys(ignorePatternLocal).length > 0) entry.ignorePatternLocal = ignorePatternLocal;

    data.repoOverrides[storePath] = entry;
  }

  writeSyncSettingsFile(data);
}

export function syncSettingsUpdateService(db: Database.Database, storePath: string): void {
  const data = readSyncSettingsFile();

  const svc = db.prepare('SELECT id FROM service_configs WHERE store_path = ?').get(storePath) as
    | { id: string }
    | undefined;
  if (!svc) return;

  const rows = db
    .prepare('SELECT key, value FROM service_settings WHERE service_config_id = ?')
    .all(svc.id) as { key: string; value: string }[];

  if (rows.length === 0) {
    delete data.serviceOverrides[storePath];
  } else {
    const entry: ServiceOverrideEntry = {};
    const patternDefaults: Record<string, string> = {};
    const patternCustom: Record<string, string> = {};
    const ignoreOverrides: Record<string, string> = {};
    const ignoreCustom: Record<string, string> = {};

    for (const row of rows) {
      if (row.key.startsWith('service_pattern_default:')) {
        patternDefaults[row.key.slice('service_pattern_default:'.length)] = row.value;
      } else if (row.key.startsWith('service_pattern_custom:')) {
        patternCustom[row.key.slice('service_pattern_custom:'.length)] = row.value;
      } else if (row.key.startsWith('service_ignore_override:')) {
        ignoreOverrides[row.key.slice('service_ignore_override:'.length)] = row.value;
      } else if (row.key.startsWith('service_ignore_custom:')) {
        ignoreCustom[row.key.slice('service_ignore_custom:'.length)] = row.value;
      }
    }

    if (Object.keys(patternDefaults).length > 0) entry.patternDefaults = patternDefaults;
    if (Object.keys(patternCustom).length > 0) entry.patternCustom = patternCustom;
    if (Object.keys(ignoreOverrides).length > 0) entry.ignoreOverrides = ignoreOverrides;
    if (Object.keys(ignoreCustom).length > 0) entry.ignoreCustom = ignoreCustom;

    data.serviceOverrides[storePath] = entry;
  }

  writeSyncSettingsFile(data);
}

export function syncSettingsRemoveRepo(storePath: string): void {
  const data = readSyncSettingsFile();
  delete data.repoOverrides[storePath];
  writeSyncSettingsFile(data);
}

export function syncSettingsRemoveService(storePath: string): void {
  const data = readSyncSettingsFile();
  delete data.serviceOverrides[storePath];
  writeSyncSettingsFile(data);
}

// ── Deferred application (when linking repos/services) ───────────────

export function applyOverridesForRepo(db: Database.Database, storePath: string): void {
  const data = readSyncSettingsFile();
  const overrides = data.repoOverrides[storePath];
  if (!overrides) return;

  const repo = db.prepare('SELECT id FROM repos WHERE store_path = ?').get(storePath) as
    | { id: string }
    | undefined;
  if (!repo) return;

  applyRepoOverridesToDb(db, repo.id, overrides);
}

export function applyOverridesForService(db: Database.Database, storePath: string): void {
  const data = readSyncSettingsFile();
  const overrides = data.serviceOverrides[storePath];
  if (!overrides) return;

  const svc = db.prepare('SELECT id FROM service_configs WHERE store_path = ?').get(storePath) as
    | { id: string }
    | undefined;
  if (!svc) return;

  applyServiceOverridesToDb(db, svc.id, overrides);
}
