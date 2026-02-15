import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { DEFAULT_SIZE_THRESHOLDS, type SizeThresholds } from '@/lib/utils';

export function useSettings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const fetch = useCallback(async () => {
    try {
      const data = await api.settings.get();
      setSettings(data.settings);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch();
  }, [fetch]);

  return { settings, loading, refetch: fetch };
}

export function parseSizeThresholds(settings: Record<string, string>): SizeThresholds {
  const w = Number(settings.size_warning_mb);
  const d = Number(settings.size_danger_mb);
  const b = Number(settings.size_blocked_mb);
  return {
    warningMB: w > 0 ? w : DEFAULT_SIZE_THRESHOLDS.warningMB,
    dangerMB: d > 0 ? d : DEFAULT_SIZE_THRESHOLDS.dangerMB,
    blockedMB: b > 0 ? b : DEFAULT_SIZE_THRESHOLDS.blockedMB,
  };
}
