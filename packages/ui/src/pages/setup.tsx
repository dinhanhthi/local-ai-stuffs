import { FolderBrowser } from '@/components/folder-browser';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';

export function SetupPage() {
  const [dataDir, setDataDir] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBrowseSelect = (path: string) => {
    setDataDir(path);
    setBrowsing(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dataDir.trim()) return;

    setLoading(true);
    setError(null);

    try {
      await api.setup.initialize(dataDir.trim());
      // Reload the page so the app detects configured state
      window.location.reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-background">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center space-y-4">
          <div className="mx-auto">
            <img src="/logo.svg" alt="AI Sync" className="h-12 w-12" />
          </div>
          <CardTitle className="text-lg">Welcome to AI Sync</CardTitle>
          <CardDescription>
            Choose a directory to store your AI configuration files. This directory will be
            initialized as a Git repository.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {browsing ? (
            <FolderBrowser onSelect={handleBrowseSelect} onCancel={() => setBrowsing(false)} />
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="dataDir" className="text-xs">
                  Data Directory
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="dataDir"
                    placeholder="/path/to/your/ai-store"
                    value={dataDir}
                    onChange={(e) => setDataDir(e.target.value)}
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
                <p className="text-[11px] text-muted-foreground">
                  This directory will contain your synced AI files and database.
                </p>
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={loading || !dataDir.trim()} className="w-full">
                {loading ? 'Initializing...' : 'Initialize'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
