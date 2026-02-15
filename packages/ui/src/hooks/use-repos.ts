import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';

export type SyncStatus =
  | 'synced'
  | 'pending_to_target'
  | 'pending_to_store'
  | 'conflict'
  | 'missing_in_target'
  | 'missing_in_store';

export interface TrackedFile {
  id: string;
  repoId: string;
  relativePath: string;
  fileType: 'file' | 'symlink';
  storeChecksum: string | null;
  targetChecksum: string | null;
  storeMtime: string | null;
  targetMtime: string | null;
  syncStatus: SyncStatus;
  lastSyncedAt: string | null;
  createdAt: string;
  storeSize?: number;
}

export interface SyncSummary {
  total: number;
  synced: number;
  pending: number;
  conflicts: number;
  totalStoreSize: number;
}

export interface RepoDetail {
  id: string;
  name: string;
  localPath: string;
  storePath: string;
  status: 'active' | 'paused' | 'error';
  isFavorite: number;
  createdAt: string;
  updatedAt: string;
  files: TrackedFile[];
  syncSummary: SyncSummary;
  lastSyncedAt: string | null;
}

export interface RepoSummary {
  id: string;
  name: string;
  localPath: string;
  storePath: string;
  status: 'active' | 'paused' | 'error';
  isFavorite: number;
  createdAt: string;
  updatedAt: string;
  syncSummary: SyncSummary;
  lastSyncedAt: string | null;
}

export function useRepos() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRepos = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const data = await api.repos.list();
      setRepos(data.repos);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRepos(true);

    // Listen for sync events to refresh (without loading flash)
    const refresh = () => fetchRepos();
    const unsub1 = wsClient.on('sync_complete', refresh);
    const unsub2 = wsClient.on('repo_status', refresh);
    const unsub3 = wsClient.on('files_changed', refresh);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [fetchRepos]);

  return { repos, loading, error, refetch: fetchRepos };
}

export function useRepo(id: string | undefined) {
  const [repo, setRepo] = useState<RepoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRepo = useCallback(
    async (showLoading = false) => {
      if (!id) return;
      try {
        if (showLoading) setLoading(true);
        const data = await api.repos.get(id);
        setRepo(data);
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    fetchRepo(true);

    const refresh = (event: Record<string, unknown>) => {
      if (event.repoId === id) fetchRepo();
    };

    const unsub1 = wsClient.on('sync_status', refresh);
    const unsub2 = wsClient.on('files_changed', refresh);
    const unsub3 = wsClient.on('conflict_created', refresh);
    const unsub4 = wsClient.on('conflict_resolved', refresh);
    const unsub5 = wsClient.on('sync_complete', refresh);

    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
    };
  }, [fetchRepo, id]);

  return { repo, loading, error, refetch: fetchRepo };
}
