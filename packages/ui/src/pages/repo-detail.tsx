import { ConfirmDialog } from '@/components/confirm-dialog';
import { ConflictResolver } from '@/components/conflict-resolver';
import { FileEditor } from '@/components/file-editor';
import { FileEditorLayout } from '@/components/file-editor-layout';
import { FileTree, type FileTreeHandle, type FileTreeItem } from '@/components/file-tree';
import { CloneDialog } from '@/components/clone-dialog';
import { RepoSettingsDialog } from '@/components/repo-settings-dialog';
import { ServiceSettingsDialog } from '@/components/service-settings-dialog';
import { SyncStatusBadge } from '@/components/sync-status-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useRepo } from '@/hooks/use-repos';
import { useService } from '@/hooks/use-services';
import { useSettings, parseSizeThresholds } from '@/hooks/use-settings';
import {
  api,
  type ConflictDetail,
  type RepoPatternEntry,
  type ServiceIgnorePatternEntry,
} from '@/lib/api';
import { formatDate, formatBytes, getSizeLevel, computeLargestPaths } from '@/lib/utils';
import { SizeLabel } from '@/components/size-label';
import { wsClient } from '@/lib/ws';
import {
  ArrowLeft,
  ChevronDown,
  Clock,
  FolderOpen,
  FolderSymlink,
  HardDrive,
  Pause,
  Play,
  RefreshCw,
  ScanSearch,
  Settings2,
  ShieldAlert,
  Star,
  Trash2,
} from 'lucide-react';
import { ServiceIcon } from '@/components/service-icon';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';

const isConflictStatus = (status: string) =>
  status === 'conflict' || status === 'missing_in_store' || status === 'missing_in_target';

type DetailTarget = {
  id: string;
  name: string;
  localPath: string;
  status: string;
  lastSyncedAt: string | null;
  totalStoreSize: number;
  files: {
    id: string;
    relativePath: string;
    syncStatus: string;
    fileType: 'file' | 'symlink';
    storeSize?: number;
  }[];
  // Repo-only fields
  isFavorite?: number;
  // Service-only fields
  serviceType?: string;
  iconPath?: string | null;
};

export function RepoDetailPage() {
  return <DetailPage type="repo" />;
}

export function ServiceDetailPage() {
  return <DetailPage type="service" />;
}

function DetailPage({ type }: { type: 'repo' | 'service' }) {
  const isRepo = type === 'repo';
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  // Fetch data based on type
  const repoHook = useRepo(isRepo ? id : undefined);
  const serviceHook = useService(!isRepo ? id : undefined);
  const { settings } = useSettings();
  const sizeThresholds = parseSizeThresholds(settings);

  const target: DetailTarget | null = isRepo
    ? repoHook.repo
      ? {
          id: repoHook.repo.id,
          name: repoHook.repo.name,
          localPath: repoHook.repo.localPath,
          status: repoHook.repo.status,
          lastSyncedAt: repoHook.repo.lastSyncedAt,
          totalStoreSize: repoHook.repo.syncSummary.totalStoreSize,
          files: repoHook.repo.files,
          isFavorite: repoHook.repo.isFavorite,
        }
      : null
    : serviceHook.service
      ? {
          id: serviceHook.service.id,
          name: serviceHook.service.name,
          localPath: serviceHook.service.localPath,
          status: serviceHook.service.status,
          lastSyncedAt: serviceHook.service.lastSyncedAt,
          totalStoreSize: serviceHook.service.syncSummary.totalStoreSize,
          files: serviceHook.service.files,
          serviceType: serviceHook.service.serviceType,
          iconPath: serviceHook.service.iconPath,
        }
      : null;

  const loading = isRepo ? repoHook.loading : serviceHook.loading;
  const refetch = isRepo ? repoHook.refetch : serviceHook.refetch;

  // API adapters
  const apiSync = isRepo ? api.repos.sync : api.services.sync;
  const apiScan = isRepo ? api.repos.scan : api.services.scan;
  const apiPause = isRepo ? api.repos.pause : api.services.pause;
  const apiResume = isRepo ? api.repos.resume : api.services.resume;
  const apiDelete = isRepo
    ? (id: string) => api.repos.delete(id)
    : (id: string) => api.services.delete(id);
  const apiGetFile = isRepo
    ? (id: string, path: string) => api.files.get(id, path)
    : (id: string, path: string) => api.services.getFile(id, path);
  const apiUpdateFile = isRepo
    ? (id: string, path: string, content: string) => api.files.update(id, path, content)
    : (id: string, path: string, content: string) => api.services.updateFile(id, path, content);
  const bulkResolveOpts = isRepo
    ? (id: string) => ({ repoId: id })
    : (id: string) => ({ serviceId: id });
  const wsEventIdField = isRepo ? 'repoId' : 'serviceId';

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [symlinkTarget, setSymlinkTarget] = useState<string | null>(null);
  const [conflictDetail, setConflictDetail] = useState<ConflictDetail | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [bulkResolveAction, setBulkResolveAction] = useState<string | null>(null);
  const [conflictFilter, setConflictFilter] = useState(false);
  const fileTreeRef = useRef<FileTreeHandle>(null);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Repo-only states
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [clonePaths, setClonePaths] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [largestFilter, setLargestFilter] = useState(false);
  const [deleteFilePath, setDeleteFilePath] = useState<string | null>(null);

  const fileMap = useMemo(() => {
    const map = new Map<string, { id: string; syncStatus: string; fileType: 'file' | 'symlink' }>();
    for (const f of target?.files ?? []) {
      map.set(f.relativePath, f);
    }
    return map;
  }, [target?.files]);

  // When files change, update the editor if the selected file's status changed or was removed
  useEffect(() => {
    if (!selectedFile || !id) return;
    const file = fileMap.get(selectedFile);
    if (!file) {
      setSelectedFile(null);
      setConflictDetail(null);
      setFileContent(null);
      setSymlinkTarget(null);
      return;
    }
    if (conflictDetail && !isConflictStatus(file.syncStatus)) {
      setConflictDetail(null);
      apiGetFile(id, selectedFile).then(
        (data) => {
          if (data.type === 'symlink') {
            setSymlinkTarget(data.target);
            setFileContent(null);
          } else {
            setFileContent(data.content);
            setSymlinkTarget(null);
          }
        },
        () => {
          setSelectedFile(null);
          setFileContent(null);
          setSymlinkTarget(null);
        },
      );
      return;
    }
    if (!conflictDetail && fileContent !== null && isConflictStatus(file.syncStatus)) {
      setFileContent(null);
      api.conflicts.getByFileId(file.id).then(
        (c) => setConflictDetail(c),
        () => {},
      );
    }
  }, [fileMap]);

  // Auto-refresh conflict detail / file content when files change on disk
  const selectedFileRef = useRef<string | null>(null);
  const conflictFileIdRef = useRef<string | null>(null);
  const conflictIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
    conflictFileIdRef.current = conflictDetail?.trackedFileId ?? null;
    conflictIdRef.current = conflictDetail?.id ?? null;
  }, [selectedFile, conflictDetail]);

  useEffect(() => {
    const unsubUpdated = wsClient.on('conflict_updated', (event) => {
      if (event.trackedFileId !== conflictFileIdRef.current) return;
      api.conflicts.getByFileId(event.trackedFileId as string).then(
        (c) => setConflictDetail(c),
        () => {},
      );
    });

    const unsubSync = wsClient.on('sync_status', (event) => {
      if (!id || event[wsEventIdField] !== id) return;
      const fileId = event.fileId as string | undefined;
      if (fileId && fileId === conflictFileIdRef.current) {
        api.conflicts.getByFileId(fileId).then(
          (c) => setConflictDetail(c),
          () => {
            setConflictDetail(null);
            if (selectedFileRef.current) {
              apiGetFile(id, selectedFileRef.current).then(
                (data) => {
                  if (data.type === 'symlink') {
                    setSymlinkTarget(data.target);
                    setFileContent(null);
                  } else {
                    setFileContent(data.content);
                    setSymlinkTarget(null);
                  }
                },
                () => {
                  setSelectedFile(null);
                  setFileContent(null);
                  setSymlinkTarget(null);
                },
              );
            }
          },
        );
      } else if (selectedFileRef.current && !conflictFileIdRef.current) {
        apiGetFile(id, selectedFileRef.current).then(
          (data) => {
            if (data.type === 'symlink') {
              setSymlinkTarget(data.target);
              setFileContent(null);
            } else {
              setFileContent(data.content);
              setSymlinkTarget(null);
            }
          },
          () => {},
        );
      }
    });

    const unsubResolved = wsClient.on('conflict_resolved', (event) => {
      if (!conflictIdRef.current) return;
      if (event.conflictId === conflictIdRef.current) {
        setConflictDetail(null);
        setSelectedFile(null);
      }
    });

    return () => {
      unsubUpdated();
      unsubSync();
      unsubResolved();
    };
  }, [id]);

  const largestPaths = useMemo(() => computeLargestPaths(target?.files ?? []), [target?.files]);

  const treeItems: FileTreeItem[] = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return (target?.files ?? [])
      .filter((f) => !conflictFilter || isConflictStatus(f.syncStatus))
      .filter((f) => !largestFilter || largestPaths.has(f.relativePath))
      .filter((f) => !query || f.relativePath.toLowerCase().includes(query))
      .map((f) => ({
        path: f.relativePath,
        status: f.syncStatus,
        fileType: f.fileType,
        storeSize: f.storeSize,
        suffix: (
          <>
            {f.storeSize != null && <SizeLabel bytes={f.storeSize} className="mr-1" />}
            <SyncStatusBadge status={f.syncStatus} size="sm" />
          </>
        ),
      }));
  }, [target?.files, conflictFilter, largestFilter, largestPaths, searchQuery]);

  const hasConflicts = useMemo(
    () => (target?.files ?? []).some((f) => isConflictStatus(f.syncStatus)),
    [target?.files],
  );

  const handleCollapseAll = useCallback(() => {
    fileTreeRef.current?.collapseAll();
  }, []);

  const handleExpandAll = useCallback(() => {
    fileTreeRef.current?.expandAll();
  }, []);

  const handleSync = async () => {
    if (!id || syncing) return;
    setSyncing(true);
    try {
      await apiSync(id);
      refetch();
    } finally {
      setSyncing(false);
    }
  };

  const handleScan = async () => {
    if (!id || scanning) return;
    setScanning(true);
    try {
      await apiScan(id);
      refetch();
    } finally {
      setScanning(false);
    }
  };

  const handlePauseResume = async () => {
    if (!id || !target) return;
    if (target.status === 'paused') {
      await apiResume(id);
    } else {
      await apiPause(id);
    }
    refetch();
  };

  const handleBulkResolve = async (resolution: string) => {
    if (!id) return;
    await api.conflicts.bulkResolve(resolution, bulkResolveOpts(id));
    setSelectedFile(null);
    setConflictDetail(null);
    refetch();
  };

  const handleDelete = async () => {
    if (!id) return;
    await apiDelete(id);
    navigate('/');
  };

  const handleSelectFile = async (
    filePath: string,
    file: { id: string; syncStatus: string; fileType: 'file' | 'symlink' },
  ) => {
    if (!id) return;
    setSelectedFile(filePath);
    setConflictDetail(null);
    setFileContent(null);
    setSymlinkTarget(null);
    setLoadingFile(true);
    try {
      if (isConflictStatus(file.syncStatus)) {
        const conflict = await api.conflicts.getByFileId(file.id);
        setConflictDetail(conflict);
      } else {
        const data = await apiGetFile(id, filePath);
        if (data.type === 'symlink') {
          setSymlinkTarget(data.target);
        } else {
          setFileContent(data.content);
        }
      }
    } catch {
      setFileContent(null);
      setSymlinkTarget(null);
      setConflictDetail(null);
    } finally {
      setLoadingFile(false);
    }
  };

  const handleClone = useCallback((path: string) => {
    setClonePaths([path]);
    setCloneOpen(true);
  }, []);

  const handleResolveFile = useCallback(
    async (path: string, resolution: 'keep_store' | 'keep_target') => {
      const file = fileMap.get(path);
      if (!file || !isConflictStatus(file.syncStatus)) return;
      try {
        const conflict = await api.conflicts.getByFileId(file.id);
        await api.conflicts.resolve(conflict.id, resolution);
        if (selectedFile === path) {
          setConflictDetail(null);
          setSelectedFile(null);
        }
        refetch();
        toast.success(`Resolved: ${resolution === 'keep_store' ? 'Keep Store' : 'Keep Target'}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to resolve conflict');
      }
    },
    [fileMap, selectedFile, refetch],
  );

  const apiDeleteFile = isRepo
    ? (id: string, path: string, opts?: { storeOnly?: boolean }) => api.files.delete(id, path, opts)
    : (id: string, path: string, opts?: { storeOnly?: boolean }) =>
        api.services.deleteFile(id, path, opts);

  const handleDeleteFile = useCallback(
    async (filePath: string) => {
      if (!id) return;
      try {
        const isFolder = filePath.endsWith('/**');
        if (isFolder) {
          const prefix = filePath.slice(0, -3); // remove "/**"
          const filesToDelete = (target?.files ?? []).filter(
            (f) => f.relativePath.startsWith(prefix + '/') || f.relativePath === prefix,
          );
          await Promise.all(filesToDelete.map((f) => apiDeleteFile(id, f.relativePath)));
          if (selectedFile && (selectedFile.startsWith(prefix + '/') || selectedFile === prefix)) {
            setSelectedFile(null);
            setFileContent(null);
            setSymlinkTarget(null);
            setConflictDetail(null);
          }
          toast.success(`Deleted ${filesToDelete.length} file(s) from ${prefix}/`);
        } else {
          await apiDeleteFile(id, filePath);
          if (selectedFile === filePath) {
            setSelectedFile(null);
            setFileContent(null);
            setSymlinkTarget(null);
            setConflictDetail(null);
          }
          toast.success(`Deleted: ${filePath}`);
        }
        refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to delete file');
      }
    },
    [id, selectedFile, target?.files, refetch],
  );

  const handleIgnore = useCallback(
    async (pattern: string) => {
      if (!id) return;
      try {
        if (isRepo) {
          const data = await api.repos.getSettings(id);
          const alreadyExists = data.ignorePatterns.some((p) => p.pattern === pattern);
          if (alreadyExists) {
            toast.error('Pattern already exists in ignore list');
            return;
          }
          const newEntry: RepoPatternEntry = { pattern, enabled: true, source: 'local' };
          const firstGlobalIndex = data.ignorePatterns.findIndex((p) => p.source === 'global');
          const updatedIgnore =
            firstGlobalIndex === -1
              ? [...data.ignorePatterns, newEntry]
              : [
                  ...data.ignorePatterns.slice(0, firstGlobalIndex),
                  newEntry,
                  ...data.ignorePatterns.slice(firstGlobalIndex),
                ];
          await api.repos.updateSettings(id, {
            filePatterns: data.filePatterns,
            ignorePatterns: updatedIgnore,
          });
        } else {
          const data = await api.services.getSettings(id);
          const alreadyExists = data.ignorePatterns.some((p) => p.pattern === pattern);
          if (alreadyExists) {
            toast.error('Pattern already exists in ignore list');
            return;
          }
          const newEntry: ServiceIgnorePatternEntry = { pattern, enabled: true, source: 'custom' };
          const firstGlobalIndex = data.ignorePatterns.findIndex((p) => p.source === 'global');
          const updatedIgnore =
            firstGlobalIndex === -1
              ? [...data.ignorePatterns, newEntry]
              : [
                  ...data.ignorePatterns.slice(0, firstGlobalIndex),
                  newEntry,
                  ...data.ignorePatterns.slice(firstGlobalIndex),
                ];
          await api.services.updateSettings(id, {
            patterns: data.patterns,
            ignorePatterns: updatedIgnore,
          });
        }
        toast.success(`Added ignore pattern: ${pattern}`);
        refetch();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to add ignore pattern');
      }
    },
    [id, isRepo, refetch],
  );

  const handleSaveFile = async (content: string) => {
    if (!id || !selectedFile) return;
    await apiUpdateFile(id, selectedFile, content);
    refetch();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!target) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        {isRepo ? 'Repository' : 'Service'} not found
      </div>
    );
  }

  return (
    <>
      {isRepo ? (
        <>
          <CloneDialog
            open={cloneOpen}
            onOpenChange={setCloneOpen}
            sourceRepoId={target.id}
            sourceRepoName={target.name}
            sourcePaths={clonePaths}
          />
          <RepoSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            repoId={target.id}
            repoName={target.name}
          />
        </>
      ) : (
        <ServiceSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          serviceId={target.id}
          serviceName={target.name}
        />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        title={isRepo ? 'Remove repository' : 'Remove service'}
        description={
          isRepo
            ? 'Remove this repository from tracking? Store files will be kept.'
            : 'Remove this service from tracking? Store files will be kept.'
        }
        confirmLabel="Remove"
        variant="destructive"
      />
      <ConfirmDialog
        open={deleteFilePath !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteFilePath(null);
        }}
        onConfirm={() => {
          if (deleteFilePath) handleDeleteFile(deleteFilePath);
          setDeleteFilePath(null);
        }}
        title={deleteFilePath?.endsWith('/**') ? 'Delete folder' : 'Delete file'}
        description={
          deleteFilePath?.endsWith('/**')
            ? `Delete all files under "${deleteFilePath.slice(0, -3)}/" from both store and target repo? This cannot be undone.`
            : `Delete "${deleteFilePath}" from both store and target repo? This cannot be undone.`
        }
        confirmLabel="Delete"
        variant="destructive"
      />
      <ConfirmDialog
        open={bulkResolveAction !== null}
        onOpenChange={(open) => {
          if (!open) setBulkResolveAction(null);
        }}
        onConfirm={() => {
          if (bulkResolveAction) handleBulkResolve(bulkResolveAction);
          setBulkResolveAction(null);
        }}
        title="Bulk resolve conflicts"
        description={
          bulkResolveAction === 'delete'
            ? 'Delete all conflicting files from both store and target? This cannot be undone.'
            : `Resolve all conflicts by ${bulkResolveAction === 'keep_store' ? 'keeping store versions' : 'keeping target versions'}? This will overwrite the other side.`
        }
        confirmLabel={
          bulkResolveAction === 'delete'
            ? 'Delete all'
            : bulkResolveAction === 'keep_store'
              ? 'Keep Store'
              : 'Keep Target'
        }
        variant={bulkResolveAction === 'delete' ? 'destructive' : 'default'}
      />
      <div className="gap-6 flex-1 min-h-0 flex flex-col overflow-hidden p-4">
        {/* Header */}
        <div className="flex flex-wrap flex-col md:flex-row items-start gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Button variant="ghost" size="icon-sm" onClick={() => navigate('/')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {!isRepo && target.serviceType && (
                  <ServiceIcon
                    serviceType={target.serviceType}
                    serviceId={target.id}
                    iconPath={target.iconPath}
                    className="h-5 w-5 text-muted-foreground shrink-0"
                  />
                )}
                <h2 className="text-xl font-semibold tracking-tight truncate">{target.name}</h2>
                {isRepo && (
                  <button
                    onClick={async () => {
                      await api.repos.update(target.id, { isFavorite: !target.isFavorite });
                      refetch();
                    }}
                    className="text-muted-foreground hover:text-yellow-500 transition-colors"
                  >
                    <Star
                      className={`h-4 w-4 ${target.isFavorite ? 'fill-yellow-500 text-yellow-500' : ''}`}
                    />
                  </button>
                )}
                {!isRepo && target.serviceType?.startsWith('custom-') && (
                  <Badge variant="secondary">Custom</Badge>
                )}
                <SyncStatusBadge status={target.status} />
              </div>
              <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                <span className="flex items-center gap-1 truncate min-w-0">
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="font-mono truncate">{target.localPath}</span>
                </span>
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="flex items-center gap-1 shrink-0 cursor-default">
                        <Clock className="h-3 w-3" />
                        {formatDate(target.lastSyncedAt)}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Last synced at</TooltipContent>
                  </Tooltip>
                  <span className="flex items-center gap-1 shrink-0">
                    <HardDrive className="h-3 w-3" />
                    <SizeLabel bytes={target.totalStoreSize} className="text-xs" />
                    {getSizeLevel(target.totalStoreSize, sizeThresholds) === 'blocked' && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <ShieldAlert className="h-3 w-3 text-destructive" />
                        </TooltipTrigger>
                        <TooltipContent>
                          Sync blocked: store exceeds {sizeThresholds.blockedMB} MB
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </span>
                </TooltipProvider>
              </div>
            </div>
          </div>
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon-sm" onClick={() => setSettingsOpen(true)}>
                    <Settings2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Settings</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon-sm" onClick={handleScan} disabled={scanning}>
                    <ScanSearch className={`h-3.5 w-3.5 ${scanning ? 'animate-pulse' : ''}`} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Scan</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    onClick={handleSync}
                    disabled={
                      syncing || getSizeLevel(target.totalStoreSize, sizeThresholds) === 'blocked'
                    }
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {getSizeLevel(target.totalStoreSize, sizeThresholds) === 'blocked'
                    ? `Sync blocked: store exceeds ${sizeThresholds.blockedMB} MB`
                    : 'Sync'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon-sm" onClick={handlePauseResume}>
                    {target.status === 'paused' ? (
                      <Play className="h-3.5 w-3.5" />
                    ) : (
                      <Pause className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {target.status === 'paused' ? 'Resume' : 'Pause'}
                </TooltipContent>
              </Tooltip>
              {hasConflicts && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm">
                      Actions <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setBulkResolveAction('keep_store')}>
                      Resolve all: Keep Store
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setBulkResolveAction('keep_target')}>
                      Resolve all: Keep Target
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setBulkResolveAction('delete')}
                    >
                      Resolve all: Delete Files
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon-sm" onClick={() => setDeleteOpen(true)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {isRepo ? 'Remove repo' : 'Remove service'}
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>

        {/* Size blocked banner */}
        {getSizeLevel(target.totalStoreSize, sizeThresholds) === 'blocked' && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm shrink-0">
            <ShieldAlert className="h-4 w-4 text-destructive shrink-0" />
            <span>
              <span className="font-medium">Sync is blocked</span> — store size (
              {formatBytes(target.totalStoreSize)}) exceeds {sizeThresholds.blockedMB} MB. Remove
              some files to resume syncing.
            </span>
          </div>
        )}

        {/* File editor */}
        <FileEditorLayout
          listTitle="Tracked Files"
          listContent={
            target.files && target.files.length > 0 ? (
              treeItems.length > 0 ? (
                <FileTree
                  ref={fileTreeRef}
                  items={treeItems}
                  selectedPath={selectedFile}
                  onSelect={(path) => {
                    const file = fileMap.get(path);
                    if (file) handleSelectFile(path, file);
                  }}
                  folderSuffix={(status) => <SyncStatusBadge status={status} size="sm" />}
                  onCollapsedChange={setAllCollapsed}
                  onClone={isRepo ? handleClone : undefined}
                  onIgnore={handleIgnore}
                  onResolve={handleResolveFile}
                  onDelete={setDeleteFilePath}
                />
              ) : (
                <div className="text-sm text-muted-foreground p-2 h-full flex flex-col gap-2 items-center justify-center">
                  {isRepo && <span className="text-2xl">🎉</span>}
                  No conflicts found, all are resolved
                </div>
              )
            ) : (
              <div className="text-sm text-muted-foreground p-2 h-full flex flex-col gap-2 items-center justify-center">
                No files tracked yet
              </div>
            )
          }
          selectedFile={selectedFile}
          emptyText="Select a file to view and edit"
          onCollapseAll={handleCollapseAll}
          onExpandAll={handleExpandAll}
          isAllCollapsed={allCollapsed}
          largestFilter={largestFilter}
          onLargestFilterChange={setLargestFilter}
          conflictFilter={conflictFilter}
          onConflictFilterChange={setConflictFilter}
          hasConflicts={hasConflicts}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        >
          {(toolbarEl) =>
            !loadingFile && conflictDetail ? (
              <ConflictResolver
                conflict={conflictDetail}
                onResolved={() => {
                  setConflictDetail(null);
                  setSelectedFile(null);
                  refetch();
                }}
                onRefresh={() => {
                  api.conflicts.getByFileId(conflictDetail.trackedFileId).then(
                    (c) => setConflictDetail(c),
                    () => {},
                  );
                }}
                toolbarTarget={toolbarEl}
              />
            ) : !loadingFile && symlinkTarget !== null ? (
              <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-sm">
                <FolderSymlink className="h-10 w-10 text-muted-foreground" />
                <div className="text-center space-y-1">
                  <div className="font-medium">Symbolic Link</div>
                  <div className="text-muted-foreground">This entry is a symlink pointing to:</div>
                </div>
                <code className="px-3 py-2 bg-muted rounded-md font-mono text-xs max-w-full break-all">
                  {symlinkTarget}
                </code>
              </div>
            ) : !loadingFile && fileContent !== null ? (
              <FileEditor
                content={fileContent}
                filePath={selectedFile!}
                onSave={handleSaveFile}
                toolbarTarget={toolbarEl}
              />
            ) : loadingFile ? (
              <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
                Loading file...
              </div>
            ) : null
          }
        </FileEditorLayout>
      </div>
    </>
  );
}
