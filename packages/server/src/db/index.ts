import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { initSchema } from './schema.js';
import { registerCustomDefinition } from '../services/service-definitions.js';

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  initSchema(db);
  return db;
}

/**
 * Load custom service definitions from DB into the runtime registry.
 * Custom services have service_type starting with "custom-".
 */
export function loadCustomServiceDefinitions(database: Database.Database): void {
  const rows = database
    .prepare(
      "SELECT service_type, name, local_path FROM service_configs WHERE service_type LIKE 'custom-%'",
    )
    .all() as { service_type: string; name: string; local_path: string }[];

  for (const row of rows) {
    // Patterns are stored in service_settings, not in the definition.
    // registerCustomDefinition sets patterns to [] to avoid duplication.
    registerCustomDefinition({
      serviceType: row.service_type,
      name: row.name,
      defaultPath: row.local_path,
      patterns: [],
    });
  }
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

/**
 * Convert a snake_case key to camelCase.
 */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Map a single row from snake_case SQLite columns to camelCase TypeScript properties.
 */
export function mapRow<T>(row: unknown): T {
  if (!row || typeof row !== 'object') return row as T;
  const obj = row as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    result[snakeToCamel(key)] = obj[key];
  }
  return result as T;
}

/**
 * Map an array of rows from snake_case to camelCase.
 */
export function mapRows<T>(rows: unknown[]): T[] {
  return rows.map((r) => mapRow<T>(r));
}

/**
 * Read enabled ignore patterns from the ignore_patterns table.
 */
export function getIgnorePatterns(database: Database.Database): string[] {
  const rows = database.prepare('SELECT pattern FROM ignore_patterns WHERE enabled = 1').all() as {
    pattern: string;
  }[];
  return rows.map((r) => r.pattern);
}

/**
 * Get effective file patterns for a specific repo, merging global and repo-level overrides.
 * Repo-level overrides are stored as:
 *   - "file_pattern_override:<pattern>" = "enabled" | "disabled"  (override global)
 *   - "file_pattern_local:<pattern>" = "enabled" | "disabled"     (local-only pattern)
 */
export function getEffectiveFilePatterns(
  database: Database.Database,
  repoId: string,
): { pattern: string; enabled: boolean; source: 'global' | 'local' }[] {
  const globalPatterns = database
    .prepare('SELECT pattern, enabled FROM file_patterns ORDER BY pattern')
    .all() as { pattern: string; enabled: number }[];

  const overrides = database
    .prepare("SELECT key, value FROM repo_settings WHERE repo_id = ? AND key LIKE 'file_pattern_%'")
    .all(repoId) as { key: string; value: string }[];

  const overrideMap = new Map<string, { type: 'override' | 'local'; enabled: boolean }>();
  for (const o of overrides) {
    if (o.key.startsWith('file_pattern_override:')) {
      const pattern = o.key.slice('file_pattern_override:'.length);
      overrideMap.set(pattern, { type: 'override', enabled: o.value === 'enabled' });
    } else if (o.key.startsWith('file_pattern_local:')) {
      const pattern = o.key.slice('file_pattern_local:'.length);
      overrideMap.set(pattern, { type: 'local', enabled: o.value === 'enabled' });
    }
  }

  // Local patterns first
  const localPatterns: { pattern: string; enabled: boolean; source: 'global' | 'local' }[] = [];
  for (const [pattern, info] of overrideMap) {
    if (info.type === 'local') {
      localPatterns.push({ pattern, enabled: info.enabled, source: 'local' });
    }
  }

  // Then global patterns (with overrides applied)
  const globalResult: { pattern: string; enabled: boolean; source: 'global' | 'local' }[] = [];
  for (const gp of globalPatterns) {
    const override = overrideMap.get(gp.pattern);
    if (override && override.type === 'override') {
      globalResult.push({ pattern: gp.pattern, enabled: override.enabled, source: 'global' });
    } else {
      globalResult.push({ pattern: gp.pattern, enabled: gp.enabled === 1, source: 'global' });
    }
  }

  return [...localPatterns, ...globalResult];
}

/**
 * Get effective ignore patterns for a specific repo, merging global and repo-level overrides.
 */
export function getEffectiveIgnorePatterns(
  database: Database.Database,
  repoId: string,
): { pattern: string; enabled: boolean; source: 'global' | 'local' }[] {
  const globalPatterns = database
    .prepare('SELECT pattern, enabled FROM ignore_patterns ORDER BY pattern')
    .all() as { pattern: string; enabled: number }[];

  const overrides = database
    .prepare(
      "SELECT key, value FROM repo_settings WHERE repo_id = ? AND key LIKE 'ignore_pattern_%'",
    )
    .all(repoId) as { key: string; value: string }[];

  const overrideMap = new Map<string, { type: 'override' | 'local'; enabled: boolean }>();
  for (const o of overrides) {
    if (o.key.startsWith('ignore_pattern_override:')) {
      const pattern = o.key.slice('ignore_pattern_override:'.length);
      overrideMap.set(pattern, { type: 'override', enabled: o.value === 'enabled' });
    } else if (o.key.startsWith('ignore_pattern_local:')) {
      const pattern = o.key.slice('ignore_pattern_local:'.length);
      overrideMap.set(pattern, { type: 'local', enabled: o.value === 'enabled' });
    }
  }

  // Local patterns first
  const localPatterns: { pattern: string; enabled: boolean; source: 'global' | 'local' }[] = [];
  for (const [pattern, info] of overrideMap) {
    if (info.type === 'local') {
      localPatterns.push({ pattern, enabled: info.enabled, source: 'local' });
    }
  }

  // Then global patterns (with overrides applied)
  const globalResult: { pattern: string; enabled: boolean; source: 'global' | 'local' }[] = [];
  for (const gp of globalPatterns) {
    const override = overrideMap.get(gp.pattern);
    if (override && override.type === 'override') {
      globalResult.push({ pattern: gp.pattern, enabled: override.enabled, source: 'global' });
    } else {
      globalResult.push({ pattern: gp.pattern, enabled: gp.enabled === 1, source: 'global' });
    }
  }

  return [...localPatterns, ...globalResult];
}

/**
 * Get enabled file patterns for a specific repo (considering repo-level overrides).
 */
export function getRepoEnabledFilePatterns(database: Database.Database, repoId: string): string[] {
  return getEffectiveFilePatterns(database, repoId)
    .filter((p) => p.enabled)
    .map((p) => p.pattern);
}

/**
 * Get enabled ignore patterns for a specific repo (considering repo-level overrides).
 */
export function getRepoIgnorePatterns(database: Database.Database, repoId: string): string[] {
  return getEffectiveIgnorePatterns(database, repoId)
    .filter((p) => p.enabled)
    .map((p) => p.pattern);
}

/**
 * Get effective general settings for a specific repo, merging global and repo-level overrides.
 */
export function getRepoEffectiveSettings(
  database: Database.Database,
  repoId: string,
): Record<string, { value: string; source: 'global' | 'local' }> {
  const globalSettings = database.prepare('SELECT * FROM settings').all() as {
    key: string;
    value: string;
  }[];

  const localOverrides = database
    .prepare(
      "SELECT key, value FROM repo_settings WHERE repo_id = ? AND key NOT LIKE 'file_pattern_%' AND key NOT LIKE 'ignore_pattern_%'",
    )
    .all(repoId) as { key: string; value: string }[];

  const localMap = new Map(localOverrides.map((o) => [o.key, o.value]));

  const result: Record<string, { value: string; source: 'global' | 'local' }> = {};
  for (const s of globalSettings) {
    if (s.key === 'schema_version') continue;
    const localValue = localMap.get(s.key);
    if (localValue !== undefined) {
      result[s.key] = { value: localValue, source: 'local' };
    } else {
      result[s.key] = { value: s.value, source: 'global' };
    }
  }

  return result;
}

/**
 * Get effective file patterns for a service, merging predefined (default) and custom overrides.
 * Overrides are stored in service_settings as:
 *   - "service_pattern_default:<pattern>" = "enabled" | "disabled"  (toggle predefined)
 *   - "service_pattern_custom:<pattern>" = "enabled" | "disabled"   (custom pattern)
 */
export function getServiceEffectivePatterns(
  database: Database.Database,
  serviceConfigId: string,
  defaultPatterns: string[],
): { pattern: string; enabled: boolean; source: 'default' | 'custom' }[] {
  const overrides = database
    .prepare(
      "SELECT key, value FROM service_settings WHERE service_config_id = ? AND key LIKE 'service_pattern_%'",
    )
    .all(serviceConfigId) as { key: string; value: string }[];

  const overrideMap = new Map<string, { type: 'default' | 'custom'; enabled: boolean }>();
  for (const o of overrides) {
    if (o.key.startsWith('service_pattern_default:')) {
      const pattern = o.key.slice('service_pattern_default:'.length);
      overrideMap.set(pattern, { type: 'default', enabled: o.value === 'enabled' });
    } else if (o.key.startsWith('service_pattern_custom:')) {
      const pattern = o.key.slice('service_pattern_custom:'.length);
      overrideMap.set(pattern, { type: 'custom', enabled: o.value === 'enabled' });
    }
  }

  // Custom patterns first
  const customPatterns: { pattern: string; enabled: boolean; source: 'default' | 'custom' }[] = [];
  for (const [pattern, info] of overrideMap) {
    if (info.type === 'custom') {
      customPatterns.push({ pattern, enabled: info.enabled, source: 'custom' });
    }
  }

  // Then default patterns (with overrides applied)
  const defaultResult: { pattern: string; enabled: boolean; source: 'default' | 'custom' }[] = [];
  for (const dp of defaultPatterns) {
    const override = overrideMap.get(dp);
    if (override && override.type === 'default') {
      defaultResult.push({ pattern: dp, enabled: override.enabled, source: 'default' });
    } else {
      defaultResult.push({ pattern: dp, enabled: true, source: 'default' });
    }
  }

  return [...customPatterns, ...defaultResult];
}

/**
 * Get enabled patterns for a service (considering overrides).
 */
export function getServiceEnabledPatterns(
  database: Database.Database,
  serviceConfigId: string,
  defaultPatterns: string[],
): string[] {
  return getServiceEffectivePatterns(database, serviceConfigId, defaultPatterns)
    .filter((p) => p.enabled)
    .map((p) => p.pattern);
}

/**
 * Get effective ignore patterns for a service, merging global and service-level overrides.
 * Overrides are stored in service_settings as:
 *   - "service_ignore_override:<pattern>" = "enabled" | "disabled"  (override global)
 *   - "service_ignore_custom:<pattern>" = "enabled" | "disabled"    (custom pattern)
 */
export function getServiceEffectiveIgnorePatterns(
  database: Database.Database,
  serviceConfigId: string,
): { pattern: string; enabled: boolean; source: 'global' | 'custom' }[] {
  const globalPatterns = database
    .prepare('SELECT pattern, enabled FROM ignore_patterns ORDER BY pattern')
    .all() as { pattern: string; enabled: number }[];

  const overrides = database
    .prepare(
      "SELECT key, value FROM service_settings WHERE service_config_id = ? AND key LIKE 'service_ignore_%'",
    )
    .all(serviceConfigId) as { key: string; value: string }[];

  const overrideMap = new Map<string, { type: 'override' | 'custom'; enabled: boolean }>();
  for (const o of overrides) {
    if (o.key.startsWith('service_ignore_override:')) {
      const pattern = o.key.slice('service_ignore_override:'.length);
      overrideMap.set(pattern, { type: 'override', enabled: o.value === 'enabled' });
    } else if (o.key.startsWith('service_ignore_custom:')) {
      const pattern = o.key.slice('service_ignore_custom:'.length);
      overrideMap.set(pattern, { type: 'custom', enabled: o.value === 'enabled' });
    }
  }

  // Custom patterns first
  const customPatterns: { pattern: string; enabled: boolean; source: 'global' | 'custom' }[] = [];
  for (const [pattern, info] of overrideMap) {
    if (info.type === 'custom') {
      customPatterns.push({ pattern, enabled: info.enabled, source: 'custom' });
    }
  }

  // Then global patterns (with overrides applied)
  const globalResult: { pattern: string; enabled: boolean; source: 'global' | 'custom' }[] = [];
  for (const gp of globalPatterns) {
    const override = overrideMap.get(gp.pattern);
    if (override && override.type === 'override') {
      globalResult.push({ pattern: gp.pattern, enabled: override.enabled, source: 'global' });
    } else {
      globalResult.push({ pattern: gp.pattern, enabled: gp.enabled === 1, source: 'global' });
    }
  }

  return [...customPatterns, ...globalResult];
}

/**
 * Get enabled ignore patterns for a service (considering overrides).
 */
export function getServiceEnabledIgnorePatterns(
  database: Database.Database,
  serviceConfigId: string,
): string[] {
  return getServiceEffectiveIgnorePatterns(database, serviceConfigId)
    .filter((p) => p.enabled)
    .map((p) => p.pattern);
}

/**
 * Expand ignore patterns so they match at any directory depth.
 *
 * - Patterns with `/` (e.g. `__pycache__/**`) get an additional `** /` prefixed
 *   variant so they also match nested occurrences like `.cursor/__pycache__/x`.
 * - Patterns without `/` (e.g. `.DS_Store`) get a `** /` prefixed variant so
 *   they match at any depth without relying on picomatch `basename` option.
 */
export function expandIgnorePatterns(patterns: string[]): string[] {
  const expanded: string[] = [];
  for (const p of patterns) {
    expanded.push(p);
    if (!p.startsWith('**/')) {
      expanded.push('**/' + p);
    }
  }
  return expanded;
}
