import { api } from '@/lib/api';
import { ArrowUpRight, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const DISMISSED_KEY = 'ai-sync-dismissed-update-version';
const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

export function UpdateBanner() {
  const [update, setUpdate] = useState<{
    latest: string;
    releaseUrl: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const checkForUpdate = useCallback(async () => {
    try {
      const result = await api.version.check();
      if (result.updateAvailable && result.latest && result.releaseUrl) {
        const dismissedVersion = localStorage.getItem(DISMISSED_KEY);
        if (dismissedVersion === result.latest) return;
        setUpdate({ latest: result.latest, releaseUrl: result.releaseUrl });
        setDismissed(false);
      } else {
        setUpdate(null);
      }
    } catch {
      // Silently ignore — version check is non-critical
    }
  }, []);

  useEffect(() => {
    checkForUpdate();
    const interval = setInterval(checkForUpdate, CHECK_INTERVAL);
    return () => clearInterval(interval);
  }, [checkForUpdate]);

  const handleDismiss = () => {
    if (update) {
      localStorage.setItem(DISMISSED_KEY, update.latest);
    }
    setDismissed(true);
  };

  if (!update || dismissed) return null;

  return (
    <div className="bg-green-600 text-white text-sm">
      <div className="mx-auto w-full max-w-7xl flex items-center justify-between px-4 py-1.5 sm:px-6">
        <div className="flex items-center gap-2">
          <span>
            A new version <strong>v{update.latest}</strong> is available!
          </span>
          <a
            href={update.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline underline-offset-2 hover:no-underline font-medium"
          >
            View release
            <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
        </div>
        <button
          onClick={handleDismiss}
          className="p-0.5 rounded hover:bg-white/20 transition-colors"
          aria-label="Dismiss update notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
