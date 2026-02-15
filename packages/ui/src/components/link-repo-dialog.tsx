import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderBrowser } from '@/components/folder-browser';
import { api } from '@/lib/api';
import type { UnlinkedStoreRepo } from '@/lib/api';
import { FolderOpen, CheckCircle, AlertCircle, Monitor } from 'lucide-react';

interface LinkRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
  repo: UnlinkedStoreRepo;
}

export function LinkRepoDialog({ open, onOpenChange, onLinked, repo }: LinkRepoDialogProps) {
  const [localPath, setLocalPath] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (open) {
      setLocalPath(repo.suggestedPath || '');
      setName(repo.storeName);
      setError(null);
    }
  }, [open, repo]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.machines.linkRepo({
        storePath: repo.storePath,
        localPath: localPath.trim(),
        name: name.trim() || undefined,
      });
      onOpenChange(false);
      onLinked();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleBrowseSelect = (path: string) => {
    setLocalPath(path);
    setBrowsing(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Repository</DialogTitle>
          <DialogDescription>
            Link the store repository <strong>{repo.storeName}</strong> to a local path on this
            machine.
          </DialogDescription>
        </DialogHeader>

        {browsing ? (
          <FolderBrowser onSelect={handleBrowseSelect} onCancel={() => setBrowsing(false)} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">Store path</Label>
              <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded">{repo.storePath}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkLocalPath">Local Path</Label>
              <div className="flex gap-2">
                <Input
                  id="linkLocalPath"
                  placeholder="/path/to/your/repository"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  className="font-mono text-xs"
                  required
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setBrowsing(true)}
                  title="Browse folders"
                >
                  <FolderOpen className="h-4 w-4" />
                </Button>
              </div>
              {repo.suggestedPath && (
                <div className="flex items-center gap-1 text-xs">
                  {repo.pathExists ? (
                    <>
                      <CheckCircle className="h-3 w-3 text-green-600" />
                      <span className="text-green-600">Suggested path exists</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-3 w-3 text-yellow-600" />
                      <span className="text-yellow-600">
                        Suggested path not found on this machine
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkName">Display Name</Label>
              <Input id="linkName" value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            {repo.otherMachines.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">Linked on other machines</Label>
                <div className="space-y-1">
                  {repo.otherMachines.map((m) => (
                    <div
                      key={m.machineId}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      <Monitor className="h-3 w-3 shrink-0" />
                      <span className="font-medium">{m.machineName}</span>
                      <span className="font-mono truncate">{m.localPath}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !localPath.trim()}>
                {loading ? 'Linking...' : 'Link Repository'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
