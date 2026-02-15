import { useState, useEffect, useCallback } from 'react';
import { api, type ServiceSummary, type ServiceDetail } from '@/lib/api';
import { wsClient } from '@/lib/ws';

export function useServices() {
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchServices = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const data = await api.services.list();
      setServices(data.services);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServices(true);

    const refresh = () => fetchServices();
    const unsub1 = wsClient.on('sync_complete', refresh);
    const unsub2 = wsClient.on('service_status', refresh);
    const unsub3 = wsClient.on('files_changed', refresh);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [fetchServices]);

  return { services, loading, error, refetch: fetchServices };
}

export function useService(id: string | undefined) {
  const [service, setService] = useState<ServiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchService = useCallback(
    async (showLoading = false) => {
      if (!id) return;
      try {
        if (showLoading) setLoading(true);
        const data = await api.services.get(id);
        setService(data);
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
    fetchService(true);

    const refresh = (event: Record<string, unknown>) => {
      if (event.serviceId === id) fetchService();
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
  }, [fetchService, id]);

  return { service, loading, error, refetch: fetchService };
}
