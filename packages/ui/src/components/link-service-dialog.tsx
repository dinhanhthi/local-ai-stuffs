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
import type { UnlinkedStoreService } from '@/lib/api';
import { FolderOpen, CheckCircle, AlertCircle, Monitor } from 'lucide-react';

interface LinkServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
  service: UnlinkedStoreService;
}

export function LinkServiceDialog({
  open,
  onOpenChange,
  onLinked,
  service,
}: LinkServiceDialogProps) {
  const [localPath, setLocalPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  // Determine best initial path: suggestedPath > defaultPath > empty
  const initialPath = service.suggestedPath || service.defaultPath || '';
  const suggestedPathExists = service.suggestedPath ? service.pathExists : false;

  useEffect(() => {
    if (open) {
      setLocalPath(initialPath);
      setError(null);
    }
  }, [open, initialPath]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.machines.linkService({
        storePath: service.storePath,
        localPath: localPath.trim(),
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

  const displayName = service.serviceName || service.storeName;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Service</DialogTitle>
          <DialogDescription>
            Link the service <strong>{displayName}</strong> to a local path on this machine.
          </DialogDescription>
        </DialogHeader>

        {browsing ? (
          <FolderBrowser onSelect={handleBrowseSelect} onCancel={() => setBrowsing(false)} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground text-xs">Store path</Label>
              <p className="text-sm font-mono bg-muted px-3 py-1.5 rounded">{service.storePath}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="linkServicePath">Local Path</Label>
              <div className="flex gap-2">
                <Input
                  id="linkServicePath"
                  placeholder="/path/to/service/directory"
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
              {service.suggestedPath && (
                <div className="flex items-center gap-1 text-xs">
                  {suggestedPathExists ? (
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
              {!service.suggestedPath && service.defaultPath && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span>Default path for this platform</span>
                </div>
              )}
            </div>

            {service.otherMachines.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-muted-foreground text-xs">Linked on other machines</Label>
                <div className="space-y-1">
                  {service.otherMachines.map((m) => (
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
                {loading ? 'Linking...' : 'Link Service'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
