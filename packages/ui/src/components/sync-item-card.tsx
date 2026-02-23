import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { SyncStatusBadge } from './sync-status-badge';
import { formatDate } from '@/lib/utils';
import { RefreshCw, FileCode2, Trash2, Pause, Play, Settings2, ShieldAlert } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getSizeLevel, type SizeThresholds, DEFAULT_SIZE_THRESHOLDS } from '@/lib/utils';
import { SizeLabel } from './size-label';
import type { SyncSummary } from '@/hooks/use-repos';

interface SyncItemCardProps {
  itemId: string;
  itemName: string;
  localPath: string;
  status: 'active' | 'paused' | 'error';
  syncSummary: SyncSummary;
  lastSyncedAt: string | null;
  detailPath: string;
  onSync: () => void;
  sizeThresholds?: SizeThresholds;

  apiSync: (id: string) => Promise<unknown>;
  apiPause: (id: string) => Promise<unknown>;
  apiResume: (id: string) => Promise<unknown>;
  apiDelete: (id: string) => Promise<unknown>;

  deleteTitle: string;
  deleteDescription: string;

  renderIcon: () => ReactNode;
  renderHeaderRight: (statusBadge: ReactNode) => ReactNode;
  renderSettingsDialog: (props: { open: boolean; onOpenChange: (v: boolean) => void }) => ReactNode;
}

export function SyncItemCard({
  itemId,
  itemName,
  localPath,
  status,
  syncSummary,
  lastSyncedAt,
  detailPath,
  onSync,
  sizeThresholds = DEFAULT_SIZE_THRESHOLDS,
  apiSync,
  apiPause,
  apiResume,
  apiDelete,
  deleteTitle,
  deleteDescription,
  renderIcon,
  renderHeaderRight,
  renderSettingsDialog,
}: SyncItemCardProps) {
  const [syncing, setSyncing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isPaused = status === 'paused';
  const sizeLevel = getSizeLevel(syncSummary.totalStoreSize, sizeThresholds);
  const isBlocked = sizeLevel === 'blocked';

  const handleSync = async (e: React.MouseEvent) => {
    e.preventDefault();
    setSyncing(true);
    try {
      await apiSync(itemId);
      onSync();
    } finally {
      setSyncing(false);
    }
  };

  const handleTogglePause = async (e: React.MouseEvent) => {
    e.preventDefault();
    setToggling(true);
    try {
      const action = isPaused ? apiResume : apiPause;
      await action(itemId);
      onSync();
    } finally {
      setToggling(false);
    }
  };

  const handleDelete = async () => {
    await apiDelete(itemId);
    onSync();
  };

  const statusBadge = <SyncStatusBadge status={status} />;

  return (
    <>
      <Link to={detailPath}>
        <Card className="transition-colors hover:bg-accent/50 cursor-pointer gap-2">
          <TooltipProvider delayDuration={300}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <div className="flex items-center gap-2 min-w-0">
                {renderIcon()}
                <CardTitle className="text-sm font-medium truncate">{itemName}</CardTitle>
              </div>
              {renderHeaderRight(statusBadge)}
            </CardHeader>
            <CardContent className="pb-3">
              <p className="text-xs text-muted-foreground truncate font-mono">{localPath}</p>
              <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <FileCode2 className="h-3 w-3" />
                  {syncSummary.total} files
                  <span className="inline-flex items-center gap-0.5">
                    ·{' '}
                    <SizeLabel bytes={syncSummary.totalStoreSize} sizeThresholds={sizeThresholds} />
                  </span>
                </span>
                {isBlocked && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <ShieldAlert className="h-3 w-3 text-destructive shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Sync blocked: store exceeds {sizeThresholds.blockedMB} MB
                    </TooltipContent>
                  </Tooltip>
                )}
                {syncSummary.conflicts > 0 && (
                  <span className="text-destructive font-medium">
                    {syncSummary.conflicts} conflicts
                  </span>
                )}
                {syncSummary.pending > 0 && (
                  <span className="text-yellow-600 font-medium">{syncSummary.pending} pending</span>
                )}
              </div>
            </CardContent>
            <CardFooter className="flex items-center justify-between pt-0">
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-[11px] text-muted-foreground cursor-default">
                    {formatDate(lastSyncedAt)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Last synced at</TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.preventDefault();
                        setSettingsOpen(true);
                      }}
                    >
                      <Settings2 className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Settings</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={handleTogglePause}
                      disabled={toggling}
                    >
                      {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{isPaused ? 'Resume sync' : 'Pause sync'}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={handleSync}
                      disabled={syncing || isPaused || isBlocked}
                    >
                      <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {isBlocked
                      ? `Sync blocked: store exceeds ${sizeThresholds.blockedMB} MB`
                      : 'Sync now'}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.preventDefault();
                        setDeleteOpen(true);
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Remove</TooltipContent>
                </Tooltip>
              </div>
            </CardFooter>
          </TooltipProvider>
        </Card>
      </Link>
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel="Remove"
        variant="destructive"
      />
      {renderSettingsDialog({ open: settingsOpen, onOpenChange: setSettingsOpen })}
    </>
  );
}
