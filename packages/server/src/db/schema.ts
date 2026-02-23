import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repos (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    local_path  TEXT NOT NULL UNIQUE,
    store_path  TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracked_files (
    id              TEXT PRIMARY KEY,
    repo_id         TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    relative_path   TEXT NOT NULL,
    store_checksum  TEXT,
    target_checksum TEXT,
    store_mtime     TEXT,
    target_mtime    TEXT,
    sync_status     TEXT NOT NULL DEFAULT 'synced',
    last_synced_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(repo_id, relative_path)
);

CREATE TABLE IF NOT EXISTS conflicts (
    id              TEXT PRIMARY KEY,
    tracked_file_id TEXT NOT NULL REFERENCES tracked_files(id) ON DELETE CASCADE,
    store_content   TEXT,
    target_content  TEXT,
    store_checksum  TEXT NOT NULL,
    target_checksum TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'pending',
    resolved_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file_patterns (
    id       TEXT PRIMARY KEY,
    pattern  TEXT NOT NULL UNIQUE,
    enabled  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_log (
    id          TEXT PRIMARY KEY,
    repo_id     TEXT REFERENCES repos(id) ON DELETE SET NULL,
    file_path   TEXT,
    action      TEXT NOT NULL,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tracked_files_repo ON tracked_files(repo_id);
CREATE INDEX IF NOT EXISTS idx_tracked_files_status ON tracked_files(sync_status);
CREATE INDEX IF NOT EXISTS idx_conflicts_status ON conflicts(status);
CREATE INDEX IF NOT EXISTS idx_sync_log_repo ON sync_log(repo_id);
CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
`;

export const DEFAULT_PATTERNS = [
  '.agent/**',
  '.agents/**',
  '.aider*',
  '.claude/**',
  '.claude-plugin/**',
  '.copilot/**',
  '.cursor/**',
  '.cursorrules',
  '.ipynb_checkpoints',
  '.gemini/**',
  '.github/copilot-instructions.md',
  '.github/skills/**',
  '.mcp.json',
  '.opencode/**',
  '.windsurfrules',
  'CLAUDE.md',
  'GEMINI.md',
];

export const DEFAULT_IGNORE_PATTERNS = [
  '*.swo',
  '*.swp',
  '.DS_Store',
  '.env',
  '.git/**',
  '.next/**',
  'node_modules/**',
  '__pycache__/**',
  'Thumbs.db',
];

const DEFAULT_SETTINGS: Record<string, string> = {
  auto_sync: 'true',
  auto_commit_store: 'true',
  sync_interval_ms: '5000',
  watch_debounce_ms: '300',
  size_warning_mb: '20',
  size_danger_mb: '50',
  size_blocked_mb: '100',
};

export function initSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  seedDefaults(db);
}

function runMigrations(db: Database.Database): void {
  // Get current schema version
  const row = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  const migrations: { version: number; sql: string }[] = [
    {
      version: 1,
      sql: `
        ALTER TABLE conflicts ADD COLUMN base_content TEXT;
        ALTER TABLE conflicts ADD COLUMN merged_content TEXT;
      `,
    },
    {
      version: 2,
      sql: `ALTER TABLE tracked_files ADD COLUMN file_type TEXT NOT NULL DEFAULT 'file'`,
    },
    {
      version: 3,
      sql: `ALTER TABLE repos ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`,
    },
    {
      version: 4,
      sql: `CREATE TABLE IF NOT EXISTS ignore_patterns (
        id       TEXT PRIMARY KEY,
        pattern  TEXT NOT NULL UNIQUE,
        enabled  INTEGER NOT NULL DEFAULT 1
      )`,
    },
    {
      version: 5,
      sql: `CREATE TABLE IF NOT EXISTS repo_settings (
        id       TEXT PRIMARY KEY,
        repo_id  TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
        key      TEXT NOT NULL,
        value    TEXT NOT NULL,
        UNIQUE(repo_id, key)
      )`,
    },
    {
      version: 6,
      sql: `
        CREATE TABLE IF NOT EXISTS service_configs (
          id            TEXT PRIMARY KEY,
          service_type  TEXT NOT NULL UNIQUE,
          name          TEXT NOT NULL,
          local_path    TEXT NOT NULL,
          store_path    TEXT NOT NULL UNIQUE,
          status        TEXT NOT NULL DEFAULT 'active',
          created_at    TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- Recreate tracked_files with nullable repo_id and new service_config_id
        CREATE TABLE tracked_files_new (
          id                TEXT PRIMARY KEY,
          repo_id           TEXT REFERENCES repos(id) ON DELETE CASCADE,
          service_config_id TEXT REFERENCES service_configs(id) ON DELETE CASCADE,
          relative_path     TEXT NOT NULL,
          file_type         TEXT NOT NULL DEFAULT 'file',
          store_checksum    TEXT,
          target_checksum   TEXT,
          store_mtime       TEXT,
          target_mtime      TEXT,
          sync_status       TEXT NOT NULL DEFAULT 'synced',
          last_synced_at    TEXT,
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO tracked_files_new (id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at, created_at)
          SELECT id, repo_id, relative_path, file_type, store_checksum, target_checksum, store_mtime, target_mtime, sync_status, last_synced_at, created_at FROM tracked_files;

        DROP TABLE tracked_files;
        ALTER TABLE tracked_files_new RENAME TO tracked_files;

        CREATE INDEX IF NOT EXISTS idx_tracked_files_repo ON tracked_files(repo_id);
        CREATE INDEX IF NOT EXISTS idx_tracked_files_service ON tracked_files(service_config_id);
        CREATE INDEX IF NOT EXISTS idx_tracked_files_status ON tracked_files(sync_status);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_files_repo_path ON tracked_files(repo_id, relative_path) WHERE repo_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_files_service_path ON tracked_files(service_config_id, relative_path) WHERE service_config_id IS NOT NULL;
      `,
    },
    {
      version: 7,
      sql: `CREATE TABLE IF NOT EXISTS service_settings (
        id                TEXT PRIMARY KEY,
        service_config_id TEXT NOT NULL REFERENCES service_configs(id) ON DELETE CASCADE,
        key               TEXT NOT NULL,
        value             TEXT NOT NULL,
        UNIQUE(service_config_id, key)
      )`,
    },
    {
      version: 8,
      sql: `
        CREATE INDEX IF NOT EXISTS idx_conflicts_tracked_file ON conflicts(tracked_file_id);
        DELETE FROM sync_log WHERE created_at < datetime('now', '-30 days');
      `,
    },
    {
      version: 9,
      sql: `
        -- Recreate sync_log without foreign key on repo_id,
        -- because it now stores both repo IDs and service_config IDs
        CREATE TABLE sync_log_new (
          id          TEXT PRIMARY KEY,
          repo_id     TEXT,
          file_path   TEXT,
          action      TEXT NOT NULL,
          details     TEXT,
          created_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );

        INSERT INTO sync_log_new (id, repo_id, file_path, action, details, created_at)
          SELECT id, repo_id, file_path, action, details, created_at FROM sync_log;

        DROP TABLE sync_log;
        ALTER TABLE sync_log_new RENAME TO sync_log;

        CREATE INDEX IF NOT EXISTS idx_sync_log_repo ON sync_log(repo_id);
        CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);
      `,
    },
    {
      version: 10,
      sql: `
        ALTER TABLE service_configs ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE service_configs ADD COLUMN icon_path TEXT DEFAULT NULL;
      `,
    },
  ];

  for (const m of migrations) {
    if (m.version > currentVersion) {
      db.exec(m.sql);
    }
  }

  const latestVersion = migrations.length;
  if (latestVersion > currentVersion) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('schema_version', ?)").run(
      String(latestVersion),
    );
  }
}

function seedDefaults(db: Database.Database): void {
  const insertPattern = db.prepare(
    'INSERT OR IGNORE INTO file_patterns (id, pattern, enabled) VALUES (?, ?, 1)',
  );
  for (const pattern of DEFAULT_PATTERNS) {
    insertPattern.run(uuid(), pattern);
  }

  const insertIgnorePattern = db.prepare(
    'INSERT OR IGNORE INTO ignore_patterns (id, pattern, enabled) VALUES (?, ?, 1)',
  );
  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    insertIgnorePattern.run(uuid(), pattern);
  }

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(key, value);
  }
}
