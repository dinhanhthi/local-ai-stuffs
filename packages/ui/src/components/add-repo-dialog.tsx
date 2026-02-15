import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CircleCheck } from '@/components/ui/circle-check';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FolderBrowser } from '@/components/folder-browser';
import { api } from '@/lib/api';
import { FolderOpen } from 'lucide-react';

function nameFromPath(p: string): string {
  const trimmed = p.replace(/\/+$/, '');
  const last = trimmed.split('/').pop() || '';
  return last;
}

interface AddRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}

export function AddRepoDialog({ open, onOpenChange, onAdded }: AddRepoDialogProps) {
  const [localPath, setLocalPath] = useState('');
  const [name, setName] = useState('');
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await api.repos.create({
        localPath: localPath.trim(),
        name: name.trim() || undefined,
        applyTemplate,
      });
      setLocalPath('');
      setName('');
      setNameManuallyEdited(false);
      onOpenChange(false);
      onAdded();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const updatePath = (path: string) => {
    setLocalPath(path);
    if (!nameManuallyEdited) {
      setName(nameFromPath(path));
    }
  };

  const handleBrowseSelect = (path: string) => {
    updatePath(path);
    setBrowsing(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Repository</DialogTitle>
          <DialogDescription>
            Register a local Git repository to sync AI configuration files.
          </DialogDescription>
        </DialogHeader>

        {browsing ? (
          <FolderBrowser onSelect={handleBrowseSelect} onCancel={() => setBrowsing(false)} />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="localPath">Local Path</Label>
              <div className="flex gap-2">
                <Input
                  id="localPath"
                  placeholder="/path/to/your/repository"
                  value={localPath}
                  onChange={(e) => updatePath(e.target.value)}
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
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Display Name (optional)</Label>
              <Input
                id="name"
                placeholder="Auto-detected from path"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameManuallyEdited(true);
                }}
              />
            </div>

            <div className="flex items-center gap-2">
              <CircleCheck
                id="applyTemplate"
                checked={applyTemplate}
                onCheckedChange={(checked) => setApplyTemplate(checked)}
              />
              <Label htmlFor="applyTemplate">Apply default template</Label>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={loading || !localPath.trim()}>
                {loading ? 'Adding...' : 'Add Repository'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
