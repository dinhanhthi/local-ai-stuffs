import type Database from 'better-sqlite3';
import type { SyncEngine } from './services/sync-engine.js';

export interface AppState {
  db: Database.Database | null;
  syncEngine: SyncEngine | null;
}
