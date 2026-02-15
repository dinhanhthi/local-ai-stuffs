import { FolderGit2, Star } from 'lucide-react';
import { SyncItemCard } from './sync-item-card';
import { RepoSettingsDialog } from './repo-settings-dialog';
import { api } from '@/lib/api';
import { type SizeThresholds, DEFAULT_SIZE_THRESHOLDS } from '@/lib/utils';
import type { RepoSummary } from '@/hooks/use-repos';

interface RepoCardProps {
  repo: RepoSummary;
  onSync: () => void;
  sizeThresholds?: SizeThresholds;
}

export function RepoCard({
  repo,
  onSync,
  sizeThresholds = DEFAULT_SIZE_THRESHOLDS,
}: RepoCardProps) {
  const handleToggleFavorite = async (e: React.MouseEvent) => {
    e.preventDefault();
    await api.repos.update(repo.id, { isFavorite: !repo.isFavorite });
    onSync();
  };

  return (
    <SyncItemCard
      itemId={repo.id}
      itemName={repo.name}
      localPath={repo.localPath}
      status={repo.status}
      syncSummary={repo.syncSummary}
      lastSyncedAt={repo.lastSyncedAt}
      detailPath={`/repos/${repo.id}`}
      onSync={onSync}
      sizeThresholds={sizeThresholds}
      apiSync={api.repos.sync}
      apiPause={api.repos.pause}
      apiResume={api.repos.resume}
      apiDelete={api.repos.delete}
      deleteTitle="Remove repository"
      deleteDescription="Remove this repository from tracking? Store files will be kept."
      renderIcon={() => <FolderGit2 className="h-4 w-4 text-muted-foreground shrink-0" />}
      renderHeaderRight={(statusBadge) => (
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleToggleFavorite}
            className="text-muted-foreground hover:text-yellow-500 transition-colors"
          >
            <Star
              className={`h-3.5 w-3.5 ${repo.isFavorite ? 'fill-yellow-500 text-yellow-500' : ''}`}
            />
          </button>
          {statusBadge}
        </div>
      )}
      renderSettingsDialog={({ open, onOpenChange }) => (
        <RepoSettingsDialog
          open={open}
          onOpenChange={onOpenChange}
          repoId={repo.id}
          repoName={repo.name}
        />
      )}
    />
  );
}
