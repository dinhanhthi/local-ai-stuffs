import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import type { UnlinkedStoreRepo, UnlinkedStoreService } from '@/lib/api';

const MACHINE_NAME_CHANGED = 'machine-name-changed';

export function useMachine() {
  const [machineId, setMachineId] = useState('');
  const [machineName, setMachineName] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchMachine = useCallback(async () => {
    try {
      const data = await api.machines.current();
      setMachineId(data.machineId);
      setMachineName(data.machineName);
    } catch {
      // Not configured yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMachine();
  }, [fetchMachine]);

  useEffect(() => {
    const handler = (e: Event) => {
      setMachineName((e as CustomEvent<string>).detail);
    };
    window.addEventListener(MACHINE_NAME_CHANGED, handler);
    return () => window.removeEventListener(MACHINE_NAME_CHANGED, handler);
  }, []);

  const updateName = useCallback(async (name: string) => {
    const result = await api.machines.updateName(name);
    setMachineName(result.machineName);
    window.dispatchEvent(new CustomEvent(MACHINE_NAME_CHANGED, { detail: result.machineName }));
  }, []);

  return { machineId, machineName, loading, updateName, refetch: fetchMachine };
}

export function useUnlinkedRepos() {
  const [repos, setRepos] = useState<UnlinkedStoreRepo[]>([]);
  const [services, setServices] = useState<UnlinkedStoreService[]>([]);
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async (showLoading = false) => {
    try {
      if (showLoading) setLoading(true);
      const data = await api.machines.unlinked();
      setRepos(data.repos);
      setServices(data.services);
    } catch {
      // Not configured yet
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch(true);
  }, [fetch]);

  return { repos, services, loading, refetch: fetch };
}
