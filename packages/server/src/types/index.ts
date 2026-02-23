export interface Repo {
  id: string;
  name: string;
  localPath: string;
  storePath: string;
  status: 'active' | 'paused' | 'error';
  isFavorite: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceConfig {
  id: string;
  serviceType: string;
  name: string;
  description: string;
  localPath: string;
  storePath: string;
  iconPath: string | null;
  status: 'active' | 'paused' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface ServiceConfigWithSummary extends ServiceConfig {
  syncSummary: {
    total: number;
    synced: number;
    pending: number;
    conflicts: number;
    totalStoreSize: number;
  };
  lastSyncedAt: string | null;
}

/** Common interface for sync targets (repos and service configs) */
export interface SyncTarget {
  id: string;
  name: string;
  localPath: string;
  storePath: string;
  status: string;
  type: 'repo' | 'service';
}

export interface TrackedFile {
  id: string;
  repoId: string | null;
  serviceConfigId: string | null;
  relativePath: string;
  fileType: 'file' | 'symlink';
  storeChecksum: string | null;
  targetChecksum: string | null;
  storeMtime: string | null;
  targetMtime: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  createdAt: string;
}

export type SyncStatus =
  | 'synced'
  | 'pending_to_target'
  | 'pending_to_store'
  | 'conflict'
  | 'missing_in_target'
  | 'missing_in_store';

export interface Conflict {
  id: string;
  trackedFileId: string;
  storeContent: string | null;
  targetContent: string | null;
  baseContent: string | null;
  mergedContent: string | null;
  storeChecksum: string;
  targetChecksum: string;
  status: 'pending' | 'resolved_store' | 'resolved_target' | 'resolved_manual' | 'resolved_delete';
  resolvedAt: string | null;
  createdAt: string;
}

export interface FilePattern {
  id: string;
  pattern: string;
  enabled: boolean;
}

export interface Setting {
  key: string;
  value: string;
}

export interface SyncLogEntry {
  id: string;
  repoId: string | null;
  filePath: string | null;
  action: string;
  details: string | null;
  createdAt: string;
}

export interface RepoWithSummary extends Repo {
  syncSummary: {
    total: number;
    synced: number;
    pending: number;
    conflicts: number;
    totalStoreSize: number;
  };
  lastSyncedAt: string | null;
}

export interface ConflictWithDetails extends Conflict {
  repoId: string | null;
  repoName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  relativePath: string;
}

export interface MachinesFile {
  machines: Record<string, { name: string; lastSeen: string }>;
  repos: Record<string, Record<string, { localPath: string }>>;
  services: Record<string, Record<string, { localPath: string }>>;
}

export interface UnlinkedStoreRepo {
  storePath: string;
  storeName: string;
  otherMachines: { machineId: string; machineName: string; localPath: string }[];
  suggestedPath: string | null;
  pathExists: boolean;
}

export interface UnlinkedStoreService {
  storePath: string;
  storeName: string;
  serviceType: string;
  otherMachines: { machineId: string; machineName: string; localPath: string }[];
  suggestedPath: string | null;
  pathExists: boolean;
  defaultPath: string | null;
  serviceName: string | null;
}

export interface AutoLinkResult {
  storePath: string;
  localPath: string;
  status: 'linked' | 'path_missing' | 'already_registered';
}

export type WsEvent =
  | { type: 'sync_status'; repoId?: string; serviceId?: string; fileId: string; status: SyncStatus }
  | { type: 'conflict_created'; conflict: ConflictWithDetails }
  | { type: 'conflict_resolved'; conflictId: string }
  | { type: 'repo_status'; repoId: string; status: string }
  | { type: 'service_status'; serviceId: string; status: string }
  | { type: 'watcher_error'; repoId?: string; serviceId?: string; error: string }
  | {
      type: 'sync_complete';
      repoId?: string;
      serviceId?: string;
      summary: { synced: number; conflicts: number; errors: number };
    }
  | { type: 'files_changed'; repoId?: string; serviceId?: string }
  | {
      type: 'conflict_updated';
      conflictId: string;
      trackedFileId: string;
      repoId?: string;
      serviceId?: string;
    }
  | {
      type: 'sync_blocked';
      repoId?: string;
      serviceId?: string;
      reason: string;
      totalSize: number;
    };
