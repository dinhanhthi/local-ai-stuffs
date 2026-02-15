import { useState, useEffect } from 'react';
import { api, type BrowseResult } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Folder, ArrowUp, GitBranch, FolderPlus, Check, X, RefreshCw } from 'lucide-react';

interface FolderBrowserProps {
  onSelect: (path: string) => void;
  onCancel: () => void;
  showDotFiles?: boolean;
}

export function FolderBrowser({ onSelect, onCancel, showDotFiles }: FolderBrowserProps) {
  const [data, setData] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [manualPath, setManualPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  const browse = async (dirPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browse(dirPath, { showDotFiles });
      setData(result);
      setManualPath(result.current);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    browse();
  }, []);

  const handleManualGo = () => {
    if (manualPath.trim()) {
      browse(manualPath.trim());
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !data) return;
    setError(null);
    try {
      const result = await api.mkdir(data.current, newFolderName.trim());
      setCreating(false);
      setNewFolderName('');
      // Navigate into the newly created folder
      browse(result.path);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <div className="space-y-3">
      {/* Path input with Go button */}
      <div className="flex gap-2 items-center">
        <Input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleManualGo()}
          placeholder="/path/to/directory"
          className="font-mono text-xs"
        />
        <Button size="sm" variant="outline" onClick={handleManualGo}>
          View
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {data && (
        <>
          {/* Current path info */}
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground font-mono text-xs truncate flex-1">
              {data.current}
            </span>
            {data.isGitRepo && (
              <Badge variant="success" className="shrink-0">
                <GitBranch className="h-3 w-3 mr-1" />
                Git repo
              </Badge>
            )}
          </div>

          {/* Directory listing */}
          <div className="border rounded-md max-h-60 overflow-y-auto">
            {/* Go up */}
            {data.parent !== data.current && (
              <button
                onClick={() => browse(data.parent)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors border-b"
              >
                <ArrowUp className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">..</span>
              </button>
            )}

            {loading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">Loading...</div>
            ) : data.dirs.length === 0 ? (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No subdirectories
              </div>
            ) : (
              data.dirs.map((dir) => (
                <button
                  key={dir.path}
                  onClick={() => browse(dir.path)}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors"
                >
                  <Folder className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{dir.name}</span>
                </button>
              ))
            )}
          </div>

          {/* New folder inline input */}
          {creating && (
            <div className="flex gap-2">
              <Input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewFolderName('');
                  }
                }}
                placeholder="Folder name"
                className="text-sm"
                autoFocus
              />
              <Button
                size="icon"
                variant="ghost"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim()}
              >
                <Check className="h-4 w-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => {
                  setCreating(false);
                  setNewFolderName('');
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2 mt-6">
            <Button size="sm" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="outline" onClick={() => browse(data.current)}>
                    <RefreshCw className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Refresh</TooltipContent>
              </Tooltip>
              {!creating && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button size="icon-sm" variant="outline" onClick={() => setCreating(true)}>
                      <FolderPlus className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>New folder</TooltipContent>
                </Tooltip>
              )}
            </TooltipProvider>
            <Button size="sm" onClick={() => onSelect(data.current)}>
              Select this folder
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
