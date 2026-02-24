import type { RepoDetail, RepoSummary, TrackedFile } from '@/hooks/use-repos';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const base = '/api';
  const url = `${base}${path}`;
  const headers: Record<string, string> = {};
  if (options?.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await fetch(url, { headers, ...options });
  } catch (e) {
    throw new Error(
      `Network error: ${e instanceof Error ? e.message : 'fetch failed'} (url: ${url})`,
    );
  }
  // Use text() + JSON.parse() instead of res.json() to avoid
  // WebKit's "The string did not match the expected pattern" error
  const text = await res.text();
  if (!res.ok) {
    let errMsg = res.statusText || 'Request failed';
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) errMsg = parsed.error;
    } catch {
      // response is not JSON
    }
    throw new Error(errMsg);
  }
  if (!text) return undefined as T;
  return JSON.parse(text);
}

export interface BrowseResult {
  current: string;
  parent: string;
  isGitRepo: boolean;
  dirs: { name: string; path: string }[];
}

export interface ConflictDetail {
  id: string;
  trackedFileId: string;
  storeContent: string | null;
  targetContent: string | null;
  baseContent: string | null;
  mergedContent: string | null;
  storeChecksum: string;
  targetChecksum: string;
  status: string;
  resolvedAt: string | null;
  createdAt: string;
  repoId: string | null;
  repoName: string | null;
  serviceId: string | null;
  serviceName: string | null;
  relativePath: string;
}

export interface StoreConfigConflict {
  file: 'sync-settings.json' | 'machines.json';
  content: string;
  ours: string;
  theirs: string;
}

export interface PullResult {
  pulled: boolean;
  message: string;
  storeConflicts?: StoreConfigConflict[];
}

export interface ServiceSummary {
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
  syncSummary: {
    total: number;
    synced: number;
    pending: number;
    conflicts: number;
    totalStoreSize: number;
  };
  lastSyncedAt: string | null;
}

export interface ServiceDetail extends ServiceSummary {
  files: TrackedFile[];
}

export interface AvailableService {
  serviceType: string;
  name: string;
  defaultPath: string;
  detected: boolean;
  registered: boolean;
}

export interface ServicePatternEntry {
  pattern: string;
  enabled: boolean;
  source: 'default' | 'custom';
}

export interface ServiceIgnorePatternEntry {
  pattern: string;
  enabled: boolean;
  source: 'global' | 'custom';
}

export interface FilePattern {
  id?: string;
  pattern: string;
  enabled: boolean;
  source?: 'default' | 'user';
}

export interface RepoPatternEntry {
  pattern: string;
  enabled: boolean;
  source: 'global' | 'local';
}

export interface RepoSettingsResponse {
  settings: Record<string, { value: string; source: 'global' | 'local' }>;
  filePatterns: RepoPatternEntry[];
  ignorePatterns: RepoPatternEntry[];
}

export interface CloneFileResult {
  relativePath: string;
  status:
    | 'will_create'
    | 'already_same'
    | 'will_conflict'
    | 'created'
    | 'skipped'
    | 'overwritten'
    | 'manual_saved';
  sourceContent?: string;
  existingContent?: string;
}

export interface CloneRepoResult {
  targetRepoId: string;
  targetRepoName: string;
  files: CloneFileResult[];
}

export interface CloneResponse {
  results: CloneRepoResult[];
}

export interface CloneResolution {
  targetRepoId: string;
  relativePath: string;
  action: 'overwrite' | 'skip' | 'manual';
  content?: string;
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

export interface MachineInfo {
  id: string;
  name: string;
  lastSeen: string;
  isCurrent: boolean;
}

export interface AutoLinkResult {
  storePath: string;
  localPath: string;
  status: 'linked' | 'path_missing' | 'already_registered';
}

export interface SyncLogEntry {
  id: string;
  repoId: string | null;
  repoName: string | null;
  filePath: string | null;
  action: string;
  details: string | null;
  createdAt: string;
}

export const api = {
  setup: {
    status: () => request<{ configured: boolean; dataDir?: string }>('/setup/status'),
    initialize: (dataDir: string) =>
      request<{ success: boolean; dataDir: string }>('/setup', {
        method: 'POST',
        body: JSON.stringify({ dataDir }),
      }),
    reset: () => request<{ success: boolean }>('/setup/reset', { method: 'POST' }),
  },

  openFolder: (path: string) =>
    request<{ success: boolean }>('/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  browse: (dirPath?: string, opts?: { showDotFiles?: boolean }) => {
    const params = new URLSearchParams();
    if (dirPath) params.set('path', dirPath);
    if (opts?.showDotFiles) params.set('showDotFiles', 'true');
    const qs = params.toString();
    return request<BrowseResult>(`/browse${qs ? `?${qs}` : ''}`);
  },

  mkdir: (parentPath: string, name: string) =>
    request<{ path: string }>('/browse/mkdir', {
      method: 'POST',
      body: JSON.stringify({ parentPath, name }),
    }),

  repos: {
    list: () => request<{ repos: RepoSummary[] }>('/repos'),
    get: (id: string) => request<RepoDetail>(`/repos/${id}`),
    create: (data: {
      localPath: string;
      name?: string;
      applyTemplate?: boolean;
      modifyGitignore?: boolean;
    }) =>
      request<{ repo: RepoSummary; filesTracked: number }>('/repos', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; status?: string; isFavorite?: boolean }) =>
      request<{ repo: RepoSummary }>(`/repos/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string, deleteStoreFiles = false) =>
      request<{ success: boolean }>(`/repos/${id}?deleteStoreFiles=${deleteStoreFiles}`, {
        method: 'DELETE',
      }),
    sync: (id: string) =>
      request<{ result: Record<string, unknown> }>(`/repos/${id}/sync`, { method: 'POST' }),
    scan: (id: string) => request<{ newFiles: string[] }>(`/repos/${id}/scan`, { method: 'POST' }),
    pause: (id: string) => request<{ status: string }>(`/repos/${id}/pause`, { method: 'POST' }),
    resume: (id: string) => request<{ status: string }>(`/repos/${id}/resume`, { method: 'POST' }),
    applyGitignore: (id: string) =>
      request<{ success: boolean; addedPatterns: string[]; removedFromGit: string[] }>(
        `/repos/${id}/apply-gitignore`,
        { method: 'POST' },
      ),
    getSettings: (id: string) => request<RepoSettingsResponse>(`/repos/${id}/settings`),
    updateSettings: (
      id: string,
      data: {
        settings?: Record<string, string | null>;
        filePatterns?: RepoPatternEntry[];
        ignorePatterns?: RepoPatternEntry[];
      },
    ) =>
      request<{ success: boolean }>(`/repos/${id}/settings`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    cleanIgnored: (id: string, scope: 'both' | 'target' | 'store' = 'both') =>
      request<{ success: boolean; removed: number; files: string[] }>(
        `/repos/${id}/ignore-patterns/clean?scope=${scope}`,
        { method: 'POST' },
      ),
  },

  files: {
    list: (repoId: string) => request<{ files: TrackedFile[] }>(`/repos/${repoId}/files`),
    get: (repoId: string, filePath: string) =>
      request<
        | { type: 'file'; content: string; path: string }
        | { type: 'symlink'; target: string; path: string }
      >(`/repos/${repoId}/files/${filePath}`),
    update: (repoId: string, filePath: string, content: string) =>
      request<{ success: boolean }>(`/repos/${repoId}/files/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    updateSymlink: (repoId: string, filePath: string, target: string) =>
      request<{ success: boolean }>(`/repos/${repoId}/files/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({ target }),
      }),
    create: (repoId: string, filePath: string, content: string) =>
      request<{ success: boolean; fileId: string }>(`/repos/${repoId}/files/${filePath}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    delete: (repoId: string, filePath: string, opts?: { storeOnly?: boolean }) =>
      request<{ success: boolean }>(
        `/repos/${repoId}/files/${filePath}${opts?.storeOnly ? '?storeOnly=true' : ''}`,
        { method: 'DELETE' },
      ),
  },

  conflicts: {
    list: () => request<{ conflicts: ConflictDetail[] }>('/conflicts'),
    get: (id: string) => request<ConflictDetail>(`/conflicts/${id}`),
    getByFileId: (trackedFileId: string) =>
      request<ConflictDetail>(`/conflicts/by-file/${trackedFileId}`),
    resolve: (id: string, resolution: string, content?: string) =>
      request<{ success: boolean; resolution: string }>(`/conflicts/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ resolution, content }),
      }),
    bulkResolve: (resolution: string, opts: { repoId?: string; serviceId?: string }) =>
      request<{ success: boolean; resolved: number }>('/conflicts/bulk-resolve', {
        method: 'POST',
        body: JSON.stringify({ ...opts, resolution }),
      }),
  },

  settings: {
    get: () => request<{ settings: Record<string, string> }>('/settings'),
    update: (data: Record<string, string>) =>
      request<{ success: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  },

  applyGitignore: () =>
    request<{ success: boolean; reposProcessed: number; totalAdded: number; totalRemoved: number }>(
      '/apply-gitignore',
      { method: 'POST' },
    ),

  patterns: {
    get: () => request<{ patterns: FilePattern[] }>('/patterns'),
    update: (patterns: FilePattern[]) =>
      request<{ success: boolean }>('/patterns', {
        method: 'PUT',
        body: JSON.stringify({ patterns }),
      }),
  },

  ignorePatterns: {
    get: () => request<{ patterns: FilePattern[] }>('/ignore-patterns'),
    update: (patterns: FilePattern[]) =>
      request<{ success: boolean }>('/ignore-patterns', {
        method: 'PUT',
        body: JSON.stringify({ patterns }),
      }),
    clean: (scope: 'both' | 'target' | 'store' = 'both') =>
      request<{ success: boolean; removed: number; files: string[] }>(
        `/ignore-patterns/clean?scope=${scope}`,
        { method: 'POST' },
      ),
  },

  sync: {
    trigger: () => request<{ success: boolean }>('/sync/trigger', { method: 'POST' }),
    log: (limit = 50, offset = 0) =>
      request<{ entries: SyncLogEntry[]; total: number }>(
        `/sync/log?limit=${limit}&offset=${offset}`,
      ),
  },

  version: {
    check: () =>
      request<{
        current: string;
        latest: string | null;
        updateAvailable: boolean;
        releaseUrl: string | null;
      }>('/version'),
  },

  store: {
    pull: () => request<PullResult>('/store/pull', { method: 'POST' }),
    push: () => request<{ pushed: boolean; message: string }>('/store/push', { method: 'POST' }),
    remote: () => request<{ url: string | null }>('/store/remote'),
    resolveConfig: (file: 'sync-settings.json' | 'machines.json', content: string) =>
      request<{ resolved: boolean }>(`/store/resolve-config/${file}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
  },

  clone: {
    preview: (sourceRepoId: string, paths: string[], targetRepoIds: string[]) =>
      request<CloneResponse>('/clone', {
        method: 'POST',
        body: JSON.stringify({ sourceRepoId, paths, targetRepoIds, dryRun: true }),
      }),
    execute: (
      sourceRepoId: string,
      paths: string[],
      targetRepoIds: string[],
      resolutions?: CloneResolution[],
    ) =>
      request<CloneResponse>('/clone', {
        method: 'POST',
        body: JSON.stringify({ sourceRepoId, paths, targetRepoIds, dryRun: false, resolutions }),
      }),
  },

  services: {
    list: () => request<{ services: ServiceSummary[] }>('/services'),
    get: (id: string) => request<ServiceDetail>(`/services/${id}`),
    available: () => request<{ services: AvailableService[] }>('/services/available'),
    create: (serviceType: string) =>
      request<{ service: ServiceSummary; filesTracked: number }>('/services', {
        method: 'POST',
        body: JSON.stringify({ serviceType }),
      }),
    createCustom: (formData: FormData) =>
      request<{ service: ServiceSummary; filesTracked: number }>('/services/custom', {
        method: 'POST',
        body: formData,
      }),
    delete: (id: string) => request<{ success: boolean }>(`/services/${id}`, { method: 'DELETE' }),
    sync: (id: string) =>
      request<{ result: Record<string, unknown> }>(`/services/${id}/sync`, { method: 'POST' }),
    scan: (id: string) =>
      request<{ newFiles: string[] }>(`/services/${id}/scan`, { method: 'POST' }),
    pause: (id: string) => request<{ status: string }>(`/services/${id}/pause`, { method: 'POST' }),
    resume: (id: string) =>
      request<{ status: string }>(`/services/${id}/resume`, { method: 'POST' }),
    getFile: (id: string, filePath: string) =>
      request<
        | { type: 'file'; content: string; path: string }
        | { type: 'symlink'; target: string; path: string }
      >(`/services/${id}/files/${filePath}`),
    updateFile: (id: string, filePath: string, content: string) =>
      request<{ success: boolean }>(`/services/${id}/files/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    createFile: (id: string, filePath: string, content: string) =>
      request<{ success: boolean; fileId: string }>(`/services/${id}/files/${filePath}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    deleteFile: (id: string, filePath: string, opts?: { storeOnly?: boolean }) =>
      request<{ success: boolean }>(
        `/services/${id}/files/${filePath}${opts?.storeOnly ? '?storeOnly=true' : ''}`,
        { method: 'DELETE' },
      ),
    getSettings: (id: string) =>
      request<{ patterns: ServicePatternEntry[]; ignorePatterns: ServiceIgnorePatternEntry[] }>(
        `/services/${id}/settings`,
      ),
    updateSettings: (
      id: string,
      data: { patterns: ServicePatternEntry[]; ignorePatterns?: ServiceIgnorePatternEntry[] },
    ) =>
      request<{ success: boolean }>(`/services/${id}/settings`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
  },

  machines: {
    current: () => request<{ machineId: string; machineName: string }>('/machines/current'),
    updateName: (name: string) =>
      request<{ success: boolean; machineName: string }>('/machines/current', {
        method: 'PUT',
        body: JSON.stringify({ name }),
      }),
    list: () => request<{ machines: MachineInfo[] }>('/machines'),
    unlinked: () =>
      request<{ repos: UnlinkedStoreRepo[]; services: UnlinkedStoreService[] }>(
        '/machines/unlinked',
      ),
    linkRepo: (data: { storePath: string; localPath: string; name?: string }) =>
      request<{ repoId: string; storePath: string; localPath: string }>('/machines/link-repo', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    autoLink: () =>
      request<{ results: AutoLinkResult[] }>('/machines/auto-link', { method: 'POST' }),
    deleteUnlinkedRepo: (storePath: string) =>
      request<{ success: boolean }>('/machines/unlinked-repo', {
        method: 'DELETE',
        body: JSON.stringify({ storePath }),
      }),
    linkService: (data: { storePath: string; localPath: string }) =>
      request<{ serviceId: string; storePath: string; localPath: string }>(
        '/machines/link-service',
        {
          method: 'POST',
          body: JSON.stringify(data),
        },
      ),
    deleteUnlinkedService: (storePath: string) =>
      request<{ success: boolean }>('/machines/unlinked-service', {
        method: 'DELETE',
        body: JSON.stringify({ storePath }),
      }),
  },

  templates: {
    listFiles: () => request<{ files: string[] }>('/templates/files'),
    getFile: (filePath: string) =>
      request<{ content: string; path: string }>(`/templates/files/${filePath}`),
    updateFile: (filePath: string, content: string) =>
      request<{ success: boolean }>(`/templates/files/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({ content }),
      }),
    createFile: (filePath: string, content: string) =>
      request<{ success: boolean }>(`/templates/files/${filePath}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    deleteFile: (filePath: string) =>
      request<{ success: boolean }>(`/templates/files/${filePath}`, { method: 'DELETE' }),
  },
};
