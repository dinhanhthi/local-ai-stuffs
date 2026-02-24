import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { v4 as uuid } from 'uuid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');

const isDev = process.env.NODE_ENV !== 'production' && !!process.env.DEV;

const APP_CONFIG_DIR = path.join(os.homedir(), '.ai-sync');
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'config.json');

// Legacy paths for backward compatibility
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.local-ai-stuffs');
const LEGACY_CONFIG_FILE = path.join(LEGACY_CONFIG_DIR, 'config.json');

interface AppConfig {
  dataDir: string;
  machineId?: string;
  machineName?: string;
}

function readAppConfig(): AppConfig | null {
  if (process.env.DATA_DIR) {
    return { dataDir: process.env.DATA_DIR };
  }
  // Try new config path first, then fall back to legacy
  for (const configFile of [APP_CONFIG_FILE, LEGACY_CONFIG_FILE]) {
    try {
      const raw = fs.readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.dataDir && typeof parsed.dataDir === 'string') {
        return {
          dataDir: parsed.dataDir,
          machineId: parsed.machineId,
          machineName: parsed.machineName,
        };
      }
    } catch {
      // Config file doesn't exist, try next
    }
  }
  return null;
}

function writeAppConfig(appCfg: AppConfig): void {
  fs.mkdirSync(APP_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify(appCfg, null, 2), 'utf-8');
}

function buildDataPaths(dataDir: string) {
  // Use legacy DB name if it exists, otherwise use new name
  const legacyDbPath = path.join(dataDir, '.db', 'local-ai-stuffs.db');
  const newDbPath = path.join(dataDir, '.db', 'ai-sync.db');
  const dbPath = fs.existsSync(legacyDbPath) ? legacyDbPath : newDbPath;

  return {
    storePath: dataDir,
    storeReposPath: path.join(dataDir, 'repos'),
    storeServicesPath: path.join(dataDir, 'services'),
    dbPath,
  };
}

const appConfig = readAppConfig();
const dataPaths = appConfig ? buildDataPaths(appConfig.dataDir) : null;

export const config = {
  isDev,
  port: parseInt(process.env.PORT || (isDev ? '2704' : '2703'), 10),
  host: process.env.HOST || '127.0.0.1',
  uiDistPath: path.join(projectRoot, 'packages', 'ui', 'dist'),
  syncIntervalMs: 5000,
  watchDebounceMs: 300,
  selfChangeGuardTtlMs: 1000,
  dataDir: appConfig?.dataDir || '',
  storePath: dataPaths?.storePath || '',
  storeReposPath: dataPaths?.storeReposPath || '',
  storeServicesPath: dataPaths?.storeServicesPath || '',
  dbPath: dataPaths?.dbPath || '',
  machineId: appConfig?.machineId || '',
  machineName: appConfig?.machineName || '',
};

export function isConfigured(): boolean {
  return !!readAppConfig();
}

export function getDataDir(): string | null {
  return readAppConfig()?.dataDir || null;
}

export function configure(dataDir: string): void {
  const existing = readAppConfig();
  const appCfg: AppConfig = {
    dataDir,
    machineId: existing?.machineId,
    machineName: existing?.machineName,
  };
  writeAppConfig(appCfg);

  const paths = buildDataPaths(dataDir);
  config.dataDir = dataDir;
  config.storePath = paths.storePath;
  config.storeReposPath = paths.storeReposPath;
  config.storeServicesPath = paths.storeServicesPath;
  config.dbPath = paths.dbPath;
}

export function resetConfig(): void {
  try {
    fs.unlinkSync(APP_CONFIG_FILE);
  } catch {
    // File may not exist
  }
  config.dataDir = '';
  config.storePath = '';
  config.storeReposPath = '';
  config.storeServicesPath = '';
  config.dbPath = '';
  config.machineId = '';
  config.machineName = '';
}

export function ensureMachineId(): void {
  const appCfg = readAppConfig();
  if (!appCfg) return;

  let changed = false;
  if (!appCfg.machineId) {
    appCfg.machineId = uuid();
    changed = true;
  }
  if (!appCfg.machineName) {
    appCfg.machineName = os.hostname();
    changed = true;
  }
  if (changed) {
    writeAppConfig(appCfg);
  }
  config.machineId = appCfg.machineId;
  config.machineName = appCfg.machineName!;
}

export function updateMachineName(name: string): void {
  const appCfg = readAppConfig();
  if (!appCfg) return;
  appCfg.machineName = name;
  writeAppConfig(appCfg);
  config.machineName = name;
}
