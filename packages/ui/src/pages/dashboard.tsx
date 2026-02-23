import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { RepoCard } from '@/components/repo-card';
import { ServiceCard } from '@/components/service-card';
import { UnlinkedRepoCard } from '@/components/unlinked-repo-card';
import { UnlinkedServiceCard } from '@/components/unlinked-service-card';
import { AddRepoDialog } from '@/components/add-repo-dialog';
import { AddServiceDialog } from '@/components/add-service-dialog';
import { useRepos } from '@/hooks/use-repos';
import { useServices } from '@/hooks/use-services';
import { useConflicts } from '@/hooks/use-conflicts';
import { useUnlinkedRepos } from '@/hooks/use-machines';
import { useSettings, parseSizeThresholds } from '@/hooks/use-settings';
import { api } from '@/lib/api';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Plus,
  RefreshCw,
  AlertTriangle,
  Pause,
  Play,
  FolderGit2,
  Star,
  Terminal,
  Link,
} from 'lucide-react';
import { toast } from 'sonner';

export function DashboardPage() {
  const { repos, loading, refetch } = useRepos();
  const { services, loading: servicesLoading, refetch: refetchServices } = useServices();
  const { conflicts, refetch: refetchConflicts } = useConflicts();
  const {
    repos: unlinkedRepos,
    services: unlinkedServices,
    loading: unlinkedLoading,
    refetch: refetchUnlinked,
  } = useUnlinkedRepos();
  const { settings } = useSettings();
  const sizeThresholds = parseSizeThresholds(settings);
  const [addOpen, setAddOpen] = useState(false);
  const [addServiceOpen, setAddServiceOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [togglingSync, setTogglingSync] = useState(false);
  const [autoLinking, setAutoLinking] = useState(false);
  const [conflictFilter, setConflictFilter] = useState(false);

  const refetchAll = useCallback(() => {
    refetch();
    refetchServices();
    refetchConflicts();
    refetchUnlinked();
  }, [refetch, refetchServices, refetchConflicts, refetchUnlinked]);

  const allItems = [...repos, ...services];
  const allPaused = allItems.length > 0 && allItems.every((r) => r.status === 'paused');
  const hasConflicts = conflicts.length > 0;
  const conflictRepoIds = new Set(conflicts.map((c) => c.repoId).filter(Boolean));
  const conflictServiceIds = new Set(conflicts.map((c) => c.serviceId).filter(Boolean));
  const filteredRepos = conflictFilter ? repos.filter((r) => conflictRepoIds.has(r.id)) : repos;
  const filteredServices = conflictFilter
    ? services.filter((s) => conflictServiceIds.has(s.id))
    : services;
  const favorites = filteredRepos.filter((r) => r.isFavorite);
  const others = filteredRepos.filter((r) => !r.isFavorite);

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      await Promise.all([
        api.sync.trigger(),
        ...services.filter((s) => s.status === 'active').map((s) => api.services.sync(s.id)),
      ]);
      await refetch();
      await refetchServices();
    } finally {
      setSyncing(false);
    }
  };

  const handleAutoLink = async () => {
    setAutoLinking(true);
    try {
      const data = await api.machines.autoLink();
      const linked = data.results.filter((r) => r.status === 'linked');
      if (linked.length > 0) {
        toast.success(`Auto-linked ${linked.length} item(s)`);
      } else {
        toast.info('Nothing could be auto-linked');
      }
      refetchAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Auto-link failed');
    } finally {
      setAutoLinking(false);
    }
  };

  const handleToggleSync = async () => {
    setTogglingSync(true);
    try {
      const repoAction = allPaused ? api.repos.resume : api.repos.pause;
      const svcAction = allPaused ? api.services.resume : api.services.pause;
      await Promise.all([
        ...repos
          .filter((r) => (allPaused ? r.status === 'paused' : r.status === 'active'))
          .map((r) => repoAction(r.id)),
        ...services
          .filter((s) => (allPaused ? s.status === 'paused' : s.status === 'active'))
          .map((s) => svcAction(s.id)),
      ]);
      await refetch();
      await refetchServices();
    } finally {
      setTogglingSync(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-4 p-4 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Dashboard</h2>
            <p className="text-sm text-muted-foreground">
              Manage AI configuration files across your repositories.
            </p>
          </div>
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-2">
              {hasConflicts && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Toggle
                        size="icon-sm"
                        variant="outline"
                        pressed={conflictFilter}
                        onPressedChange={setConflictFilter}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </Toggle>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {conflictFilter ? 'Show all repos' : 'Show repos with conflicts only'}
                  </TooltipContent>
                </Tooltip>
              )}
              {allItems.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleToggleSync}
                  disabled={togglingSync}
                >
                  {allPaused ? (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      <span className="">Resume All</span>
                    </>
                  ) : (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      <span className="">Pause All</span>
                    </>
                  )}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncAll}
                disabled={syncing || allPaused}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span className="">Sync All</span>
              </Button>
            </div>
          </TooltipProvider>
        </div>

        {conflicts.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
            <span className="font-medium">
              {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} need resolution
            </span>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="space-y-6">
          {/* AI Services section */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-muted-foreground" />
                <h3 className="text-base font-medium">AI Services</h3>
              </div>
              <Button variant="outline" size="sm" onClick={() => setAddServiceOpen(true)}>
                <Plus className="h-3.5 w-3.5" />
                Add Service
              </Button>
            </div>
            {servicesLoading ? (
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                Loading services...
              </div>
            ) : services.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-8 text-center">
                <Terminal className="h-6 w-6 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground mb-2">
                  Sync your local AI service configurations.
                </p>
              </div>
            ) : filteredServices.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                No services with conflicts.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredServices.map((svc) => (
                  <ServiceCard
                    key={svc.id}
                    service={svc}
                    onSync={refetchAll}
                    sizeThresholds={sizeThresholds}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Unlinked store services */}
          {!unlinkedLoading && unlinkedServices.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <h3 className="text-sm font-medium">
                    Unlinked Services ({unlinkedServices.length})
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    Found in store but not linked on this machine
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={handleAutoLink} disabled={autoLinking}>
                  <Link className="h-3.5 w-3.5" />
                  {autoLinking ? 'Linking...' : 'Auto-link All'}
                </Button>
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {unlinkedServices.map((svc) => (
                  <UnlinkedServiceCard key={svc.storePath} service={svc} onLinked={refetchAll} />
                ))}
              </div>
            </div>
          )}

          {/* Unlinked store repos */}
          {!unlinkedLoading && unlinkedRepos.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <h3 className="text-sm font-medium">
                    Unlinked Repositories ({unlinkedRepos.length})
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    Found in store but not linked on this machine
                  </span>
                </div>
                <Button variant="outline" size="sm" onClick={handleAutoLink} disabled={autoLinking}>
                  <Link className="h-3.5 w-3.5" />
                  {autoLinking ? 'Linking...' : 'Auto-link All'}
                </Button>
              </div>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {unlinkedRepos.map((repo) => (
                  <UnlinkedRepoCard key={repo.storePath} repo={repo} onLinked={refetchAll} />
                ))}
              </div>
            </div>
          )}

          {/* Repositories section */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <FolderGit2 className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-base font-medium">Repositories</h3>
            </div>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add Repo
            </Button>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              Loading repositories...
            </div>
          ) : repos.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                <FolderGit2 className="h-6 w-6 text-muted-foreground" />
              </div>
              <h3 className="text-sm font-medium mb-1">No repositories</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Get started by adding your first repository.
              </p>
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              No repositories with conflicts.
            </div>
          ) : (
            <>
              {favorites.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Star className="h-4 w-4 fill-yellow-500 text-yellow-500" />
                    <h3 className="text-sm font-medium">Favorites</h3>
                  </div>
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {favorites.map((repo) => (
                      <RepoCard
                        key={repo.id}
                        repo={repo}
                        onSync={refetchAll}
                        sizeThresholds={sizeThresholds}
                      />
                    ))}
                  </div>
                </div>
              )}
              {others.length > 0 && (
                <div>
                  {favorites.length > 0 && (
                    <h3 className="text-sm font-medium mb-3 text-muted-foreground">
                      All Repositories
                    </h3>
                  )}
                  <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {others.map((repo) => (
                      <RepoCard
                        key={repo.id}
                        repo={repo}
                        onSync={refetchAll}
                        sizeThresholds={sizeThresholds}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <AddRepoDialog open={addOpen} onOpenChange={setAddOpen} onAdded={refetch} />
      <AddServiceDialog
        open={addServiceOpen}
        onOpenChange={setAddServiceOpen}
        onAdded={refetchAll}
      />
    </div>
  );
}
