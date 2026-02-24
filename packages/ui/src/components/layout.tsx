import { Button } from '@/components/ui/button';
import { api, type StoreConfigConflict } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Database,
  Download,
  FileText,
  FolderSearch2,
  Globe,
  Loader2,
  Monitor,
  RotateCcw,
  Settings,
  Upload,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { toast } from 'sonner';
import { ConfirmDialog } from './confirm-dialog';
import { StoreConfigConflictDialog } from './store-config-conflict-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { UpdateBanner } from './update-banner';
import { useMachine } from '@/hooks/use-machines';

const navItems = [
  { to: '/', label: 'Dashboard', icon: Database },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Layout({ children, dataDir }: { children: React.ReactNode; dataDir?: string }) {
  const location = useLocation();
  const [pulling, setPulling] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pullConfirmOpen, setPullConfirmOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);
  const [storeConfigConflicts, setStoreConfigConflicts] = useState<StoreConfigConflict[] | null>(
    null,
  );
  const { machineName } = useMachine();

  useEffect(() => {
    if (dataDir) {
      api.store
        .remote()
        .then((r) => setRemoteUrl(r.url))
        .catch(() => {});
    }
  }, [dataDir]);

  const isActive = (to: string) =>
    location.pathname === to || (to !== '/' && location.pathname.startsWith(to));

  const capsuleRef = useRef<HTMLSpanElement>(null);
  const [capsuleStyle, setCapsuleStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useEffect(() => {
    const nav = capsuleRef.current?.parentElement;
    if (!nav) return;
    const activeLink = nav.querySelector<HTMLElement>('[data-nav-active]');
    if (!activeLink) {
      setCapsuleStyle({ opacity: 0 });
      return;
    }
    const navRect = nav.getBoundingClientRect();
    const linkRect = activeLink.getBoundingClientRect();
    setCapsuleStyle({
      left: linkRect.left - navRect.left,
      top: linkRect.top - navRect.top,
      width: linkRect.width,
      height: linkRect.height,
      opacity: 1,
    });
  }, [location.pathname]);

  const handleReset = async () => {
    setResetting(true);
    try {
      await api.setup.reset();
      window.location.reload();
    } catch {
      setResetting(false);
    }
  };

  const handlePull = async () => {
    setPulling(true);
    try {
      const result = await api.store.pull();
      if (result.storeConflicts && result.storeConflicts.length > 0) {
        setStoreConfigConflicts(result.storeConflicts);
        toast.warning('Pull completed with config conflicts — please resolve them');
      } else if (result.pulled) {
        toast.success(result.message);
      } else {
        toast.warning(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setPulling(false);
    }
  };

  const handlePush = async () => {
    setPushing(true);
    try {
      const result = await api.store.push();
      if (result.pushed) {
        toast.success(result.message);
      } else {
        toast.warning(result.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  return (
    <div className="h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/80 bg-white/95 backdrop-blur-sm supports-backdrop-filter:bg-white/60">
        <div className="mx-auto w-full max-w-7xl flex h-14 items-center px-4 gap-4 sm:gap-6 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <img src="/logo.svg" alt="AI Sync" className="h-8 w-8" />
            <span className="inline text-base font-semibold tracking-tight">AI Sync</span>
          </Link>

          <nav className="relative flex items-center gap-2 sm:gap-0.5 rounded-full border border-border/80 bg-muted/60 p-1">
            <span
              ref={capsuleRef}
              className="absolute rounded-full bg-white border border-border/80 shadow-sm transition-all duration-300 ease-out"
              style={capsuleStyle}
            />
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                data-nav-active={isActive(item.to) || undefined}
                className={cn(
                  'relative flex items-center gap-1.5 rounded-full px-1.5 sm:px-3.5 py-1.5 text-sm font-medium transition-colors',
                  isActive(item.to)
                    ? 'text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <span className="relative z-10 flex items-center gap-1.5">
                  <item.icon className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{item.label}</span>
                </span>
              </Link>
            ))}
          </nav>

          <a
            href="https://github.com/dinhanhthi/ai-sync"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex items-center gap-1.5 rounded-full border border-border/80 px-2.5 py-1 text-muted-foreground hover:text-foreground transition-colors"
            title="GitHub"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
              <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            <span className="text-xs font-semibold">v{__APP_VERSION__}</span>
          </a>
        </div>
      </header>

      <UpdateBanner />

      {/* Main content */}
      <main className="flex-1 min-h-0 flex flex-col">
        <div className="mx-auto w-full max-w-7xl flex-1 min-h-0 flex flex-col overflow-y-auto">
          {children}
        </div>
      </main>

      {/* Footer */}
      {dataDir && (
        <footer className="border-t border-border/80 py-2 text-xs text-muted-foreground w-full overflow-hidden">
          <div className="mx-auto w-full max-w-7xl px-2 flex items-center gap-2">
            {machineName && (
              <div className="flex items-center gap-1.5 shrink-0 rounded-full border border-border/80 bg-muted/60 px-2 py-0.5">
                <Monitor className="h-3 w-3 shrink-0" />
                <span className="font-medium text-xs">{machineName}</span>
              </div>
            )}
            <div className="flex items-center gap-1 min-w-0">
              <Database className="h-4 w-4 shrink-0" />
              <span
                className="font-mono truncate text-xs [direction:rtl] text-left"
                title={dataDir}
              >
                {dataDir}
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="outline"
                size="xs"
                onClick={() => api.openFolder(dataDir)}
                title="Show in file manager"
              >
                <FolderSearch2 className="h-3 w-3" />
                <span className="hidden sm:inline">Local</span>
              </Button>
              {remoteUrl && (
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => window.open(remoteUrl, '_blank')}
                  title="Open remote repository"
                >
                  <Globe className="h-3 w-3" />
                  <span className="hidden sm:inline">Remote</span>
                </Button>
              )}
              <Button
                variant="outline"
                size="xs"
                onClick={() => setResetOpen(true)}
                disabled={resetting}
                title="Change data directory"
              >
                <RotateCcw className="h-3 w-3" />
                <span className="hidden sm:inline">Change</span>
              </Button>
              {remoteUrl && (
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setPullConfirmOpen(true)}
                        disabled={pulling}
                      >
                        {pulling ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Download className="h-3 w-3" />
                        )}
                        <span className="hidden sm:inline">Pull</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Pull latest changes from remote repository</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setConfirmOpen(true)}
                        disabled={pushing}
                      >
                        {pushing ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Upload className="h-3 w-3" />
                        )}
                        <span className="hidden sm:inline">Push</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      Push committed store changes to remote repository
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
            <ConfirmDialog
              open={resetOpen}
              onOpenChange={setResetOpen}
              onConfirm={handleReset}
              title="Change data directory?"
              description="This will disconnect from the current data directory and return to the setup screen. Your data files will not be deleted."
              confirmLabel="Continue"
            />
          </div>
        </footer>
      )}

      <ConfirmDialog
        open={pullConfirmOpen}
        onOpenChange={setPullConfirmOpen}
        onConfirm={handlePull}
        title="Pull from remote"
        description="Pull latest changes from the remote repository? This will merge remote changes into your local store."
        confirmLabel="Pull"
      />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={handlePush}
        title="Push to remote"
        description="Push all committed store changes to the remote repository?"
        confirmLabel="Push"
      />

      {storeConfigConflicts && storeConfigConflicts.length > 0 && (
        <StoreConfigConflictDialog
          conflicts={storeConfigConflicts}
          onResolved={() => setStoreConfigConflicts(null)}
        />
      )}
    </div>
  );
}
