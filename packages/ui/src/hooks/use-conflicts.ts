import { useState, useEffect, useCallback } from 'react';
import { api, type ConflictDetail } from '@/lib/api';
import { wsClient } from '@/lib/ws';

export function useConflicts() {
  const [conflicts, setConflicts] = useState<ConflictDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchConflicts = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const data = await api.conflicts.list();
      setConflicts(data.conflicts);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConflicts(true);

    const refresh = () => fetchConflicts();
    const unsub1 = wsClient.on('conflict_created', refresh);
    const unsub2 = wsClient.on('conflict_resolved', refresh);

    return () => {
      unsub1();
      unsub2();
    };
  }, [fetchConflicts]);

  return { conflicts, loading, error, refetch: fetchConflicts };
}
