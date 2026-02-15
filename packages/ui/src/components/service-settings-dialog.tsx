import { PatternList } from '@/components/pattern-list';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { api, type ServicePatternEntry, type ServiceIgnorePatternEntry } from '@/lib/api';
import { Loader2, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

interface ServiceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceId: string;
  serviceName: string;
}

export function ServiceSettingsDialog({
  open,
  onOpenChange,
  serviceId,
  serviceName,
}: ServiceSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [patterns, setPatterns] = useState<ServicePatternEntry[]>([]);
  const [ignorePatterns, setIgnorePatterns] = useState<ServiceIgnorePatternEntry[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [newIgnorePattern, setNewIgnorePattern] = useState('');

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.services.getSettings(serviceId);
      setPatterns(data.patterns);
      setIgnorePatterns(data.ignorePatterns);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [serviceId]);

  useEffect(() => {
    if (open) fetchSettings();
  }, [open, fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.services.updateSettings(serviceId, { patterns, ignorePatterns });
      toast.success('Service settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const togglePattern = (index: number) => {
    setPatterns((prev) => prev.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)));
  };

  const removePattern = (index: number) => {
    const p = patterns[index];
    if (p.source === 'custom') {
      setPatterns((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const addPattern = () => {
    const trimmed = newPattern.trim();
    if (!trimmed) return;
    if (patterns.some((p) => p.pattern === trimmed)) {
      toast.error('Pattern already exists');
      return;
    }
    const firstDefaultIndex = patterns.findIndex((p) => p.source === 'default');
    setPatterns((prev) => {
      const newEntry: ServicePatternEntry = { pattern: trimmed, enabled: true, source: 'custom' };
      if (firstDefaultIndex === -1) return [...prev, newEntry];
      return [...prev.slice(0, firstDefaultIndex), newEntry, ...prev.slice(firstDefaultIndex)];
    });
    setNewPattern('');
  };

  const toggleIgnorePattern = (index: number) => {
    setIgnorePatterns((prev) =>
      prev.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)),
    );
  };

  const removeIgnorePattern = (index: number) => {
    const p = ignorePatterns[index];
    if (p.source === 'custom') {
      setIgnorePatterns((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const addIgnorePattern = () => {
    const trimmed = newIgnorePattern.trim();
    if (!trimmed) return;
    if (ignorePatterns.some((p) => p.pattern === trimmed)) {
      toast.error('Pattern already exists');
      return;
    }
    const firstGlobalIndex = ignorePatterns.findIndex((p) => p.source === 'global');
    setIgnorePatterns((prev) => {
      const newEntry: ServiceIgnorePatternEntry = {
        pattern: trimmed,
        enabled: true,
        source: 'custom',
      };
      if (firstGlobalIndex === -1) return [...prev, newEntry];
      return [...prev.slice(0, firstGlobalIndex), newEntry, ...prev.slice(firstGlobalIndex)];
    });
    setNewIgnorePattern('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">Service Settings - {serviceName}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading settings...
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 gap-4">
            <Tabs defaultValue="file-patterns" className="flex flex-col">
              <TabsList className="self-start h-7">
                <TabsTrigger value="file-patterns" className="text-xs px-2.5 py-1">
                  File Patterns
                </TabsTrigger>
                <TabsTrigger value="ignore-patterns" className="text-xs px-2.5 py-1">
                  Ignore Patterns
                </TabsTrigger>
              </TabsList>

              <div className="relative h-80 mt-2">
                <TabsContent
                  forceMount
                  value="file-patterns"
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:hidden"
                >
                  <p className="text-xs text-muted-foreground py-2">
                    Configure which file patterns are synced for this service. Toggle off default
                    patterns to exclude them, or add custom patterns to include more files.
                  </p>
                  <PatternList
                    patterns={patterns}
                    onToggle={togglePattern}
                    onRemove={removePattern}
                    newPattern={newPattern}
                    onNewPatternChange={setNewPattern}
                    onAdd={addPattern}
                    placeholder="custom-folder/**"
                  />
                </TabsContent>

                <TabsContent
                  forceMount
                  value="ignore-patterns"
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:hidden"
                >
                  <p className="text-xs text-muted-foreground py-2">
                    Override which ignore patterns are active for this service. Files matching these
                    patterns will be excluded from syncing.
                  </p>
                  <PatternList
                    patterns={ignorePatterns}
                    onToggle={toggleIgnorePattern}
                    onRemove={removeIgnorePattern}
                    newPattern={newIgnorePattern}
                    onNewPatternChange={setNewIgnorePattern}
                    onAdd={addIgnorePattern}
                    placeholder="logs/**"
                  />
                </TabsContent>
              </div>
            </Tabs>

            <div className="flex justify-end gap-2 pt-2 shrink-0">
              <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
