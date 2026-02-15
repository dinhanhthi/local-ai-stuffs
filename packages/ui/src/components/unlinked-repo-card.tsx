import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { LinkRepoDialog } from './link-repo-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderGit2, AlertTriangle, Link, Loader2, Monitor, Trash2 } from 'lucide-react';
import { api, type UnlinkedStoreRepo } from '@/lib/api';
import { toast } from 'sonner';

interface UnlinkedRepoCardProps {
  repo: UnlinkedStoreRepo;
  onLinked: () => void;
}

export function UnlinkedRepoCard({ repo, onLinked }: UnlinkedRepoCardProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.machines.deleteUnlinkedRepo(repo.storePath);
      toast.success(`Deleted ${repo.storeName} from store`);
      onLinked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <Card className="border-dashed border-yellow-500/50 bg-yellow-50/30 dark:bg-yellow-950/10">
        <TooltipProvider delayDuration={300}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <FolderGit2 className="h-4 w-4 text-yellow-600 shrink-0" />
              <CardTitle className="text-sm font-medium truncate">{repo.storeName}</CardTitle>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Not linked on this machine</TooltipContent>
            </Tooltip>
          </CardHeader>
          <CardContent className="pb-3">
            <p className="text-xs text-muted-foreground font-mono truncate">{repo.storePath}</p>
            {repo.otherMachines.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {repo.otherMachines.slice(0, 2).map((m) => (
                  <div
                    key={m.machineId}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <Monitor className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {m.machineName}: <span className="font-mono">{m.localPath}</span>
                    </span>
                  </div>
                ))}
                {repo.otherMachines.length > 2 && (
                  <p className="text-[11px] text-muted-foreground">
                    +{repo.otherMachines.length - 2} more
                  </p>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="flex items-center justify-end gap-2 pt-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete from store</TooltipContent>
            </Tooltip>
            <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
              <Link className="h-3 w-3" />
              Link
            </Button>
          </CardFooter>
        </TooltipProvider>
      </Card>
      <LinkRepoDialog open={linkOpen} onOpenChange={setLinkOpen} onLinked={onLinked} repo={repo} />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        title={`Delete "${repo.storeName}" from store?`}
        description="This will permanently remove the store files and all machine mappings for this repository. Target repositories on other machines will not be affected."
        confirmLabel="Delete"
        variant="destructive"
      />
    </>
  );
}
