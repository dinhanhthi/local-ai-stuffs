import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { api, type RepoPatternEntry } from '@/lib/api';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Eraser, Save, Loader2, ShieldCheck } from 'lucide-react';
import { PatternList } from '@/components/pattern-list';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SettingRow, CheckboxSettingRow } from '@/components/setting-rows';
import { toast } from 'sonner';

interface RepoSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoId: string;
  repoName: string;
}

type SettingsEntry = { value: string; source: 'global' | 'local' };

export function RepoSettingsDialog({
  open,
  onOpenChange,
  repoId,
  repoName,
}: RepoSettingsDialogProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<Record<string, SettingsEntry>>({});
  const [filePatterns, setFilePatterns] = useState<RepoPatternEntry[]>([]);
  const [ignorePatterns, setIgnorePatterns] = useState<RepoPatternEntry[]>([]);
  const [newFilePattern, setNewFilePattern] = useState('');
  const [newIgnorePattern, setNewIgnorePattern] = useState('');
  const [activeTab, setActiveTab] = useState('general');
  const [applyingGitignore, setApplyingGitignore] = useState(false);
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [showApplyAfterSave, setShowApplyAfterSave] = useState(false);
  const [cleaningIgnored, setCleaningIgnored] = useState(false);
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const globalSettingsRef = useRef<Record<string, string>>({});

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const [data, globalData] = await Promise.all([
        api.repos.getSettings(repoId),
        api.settings.get(),
      ]);
      globalSettingsRef.current = globalData.settings;
      setSettings(data.settings);
      setFilePatterns(data.filePatterns);
      setIgnorePatterns(data.ignorePatterns);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }, [repoId]);

  useEffect(() => {
    if (open) fetchSettings();
  }, [open, fetchSettings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Build settings overrides: only send entries that differ from global
      const settingsPayload: Record<string, string | null> = {};
      for (const [key, entry] of Object.entries(settings)) {
        if (entry.source === 'local') {
          settingsPayload[key] = entry.value;
        }
      }

      await api.repos.updateSettings(repoId, {
        settings: settingsPayload,
        filePatterns,
        ignorePatterns,
      });
      toast.success('Repository settings saved');
      setShowApplyAfterSave(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    const globalValue = globalSettingsRef.current[key];
    const source = globalValue === value ? 'global' : 'local';
    setSettings((prev) => ({
      ...prev,
      [key]: { value, source },
    }));
  };

  const resetSetting = async (key: string) => {
    try {
      const globalData = await api.settings.get();
      const globalValue = globalData.settings[key];
      if (globalValue !== undefined) {
        setSettings((prev) => ({
          ...prev,
          [key]: { value: globalValue, source: 'global' },
        }));
      }
    } catch {
      setSettings((prev) => {
        const copy = { ...prev };
        if (copy[key]) {
          copy[key] = { ...copy[key], source: 'global' };
        }
        return copy;
      });
    }
  };

  const handleApplyGitignore = async () => {
    setApplyingGitignore(true);
    try {
      const result = await api.repos.applyGitignore(repoId);
      const parts: string[] = [];
      if (result.addedPatterns.length > 0)
        parts.push(`${result.addedPatterns.length} pattern(s) added`);
      if (result.removedFromGit.length > 0)
        parts.push(`${result.removedFromGit.length} file(s) untracked from git`);
      toast.success(parts.length > 0 ? parts.join(', ') : '.gitignore is already up to date');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply .gitignore');
    } finally {
      setApplyingGitignore(false);
    }
  };

  const handleCleanIgnored = async (scope: 'both' | 'target' | 'store' = 'both') => {
    setCleaningIgnored(true);
    try {
      const result = await api.repos.cleanIgnored(repoId, scope);
      if (result.removed > 0) {
        const where =
          scope === 'both' ? 'both locations' : scope === 'target' ? 'target repo' : 'store';
        toast.success(
          `Removed ${result.removed} ignored file${result.removed > 1 ? 's' : ''} from ${where}`,
        );
      } else {
        toast.info('No tracked files match the ignore patterns');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clean failed');
    } finally {
      setCleaningIgnored(false);
      setShowCleanConfirm(false);
    }
  };

  const toggleFilePattern = (index: number) => {
    setFilePatterns((prev) =>
      prev.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)),
    );
  };

  const removeFilePattern = (index: number) => {
    const p = filePatterns[index];
    if (p.source === 'local') {
      setFilePatterns((prev) => prev.filter((_, i) => i !== index));
    }
  };

  const addFilePattern = () => {
    const trimmed = newFilePattern.trim();
    if (!trimmed) return;
    if (filePatterns.some((p) => p.pattern === trimmed)) {
      toast.error('Pattern already exists');
      return;
    }
    const firstGlobalIndex = filePatterns.findIndex((p) => p.source === 'global');
    setFilePatterns((prev) => {
      const newEntry: RepoPatternEntry = { pattern: trimmed, enabled: true, source: 'local' };
      if (firstGlobalIndex === -1) return [...prev, newEntry];
      return [...prev.slice(0, firstGlobalIndex), newEntry, ...prev.slice(firstGlobalIndex)];
    });
    setNewFilePattern('');
  };

  const toggleIgnorePattern = (index: number) => {
    setIgnorePatterns((prev) =>
      prev.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)),
    );
  };

  const removeIgnorePattern = (index: number) => {
    const p = ignorePatterns[index];
    if (p.source === 'local') {
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
      const newEntry: RepoPatternEntry = { pattern: trimmed, enabled: true, source: 'local' };
      if (firstGlobalIndex === -1) return [...prev, newEntry];
      return [...prev.slice(0, firstGlobalIndex), newEntry, ...prev.slice(firstGlobalIndex)];
    });
    setNewIgnorePattern('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-base">Repository Settings</DialogTitle>
          <DialogDescription className="font-mono text-xs">{repoName}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            Loading settings...
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 gap-4">
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
              <TabsList className="self-start h-7">
                <TabsTrigger value="general" className="text-xs px-2.5 py-1">
                  General
                </TabsTrigger>
                <TabsTrigger value="file-patterns" className="text-xs px-2.5 py-1">
                  AI File Patterns
                </TabsTrigger>
                <TabsTrigger value="ignore-patterns" className="text-xs px-2.5 py-1">
                  Ignore Patterns
                </TabsTrigger>
              </TabsList>

              <div className="relative h-80 mt-2">
                <TabsContent
                  forceMount
                  value="general"
                  className="absolute inset-0 mt-0 overflow-y-auto data-[state=inactive]:hidden"
                >
                  <div className="space-y-4 py-2">
                    <div className="text-xs text-muted-foreground">
                      Override global settings for this repository. Reset to use the global value.
                    </div>

                    <div className="space-y-3">
                      <div className="text-sm font-medium">Sync timing and behavior</div>
                      <SettingRow
                        label="Sync Interval (ms)"
                        settingKey="sync_interval_ms"
                        type="number"
                        value={settings.sync_interval_ms?.value ?? ''}
                        source={settings.sync_interval_ms?.source}
                        onChange={(v) => updateSetting('sync_interval_ms', v)}
                        onReset={() => resetSetting('sync_interval_ms')}
                      />

                      <SettingRow
                        label="Watch Debounce (ms)"
                        settingKey="watch_debounce_ms"
                        type="number"
                        value={settings.watch_debounce_ms?.value ?? ''}
                        source={settings.watch_debounce_ms?.source}
                        onChange={(v) => updateSetting('watch_debounce_ms', v)}
                        onReset={() => resetSetting('watch_debounce_ms')}
                      />

                      <CheckboxSettingRow
                        label="Auto Sync"
                        settingKey="auto_sync"
                        checked={settings.auto_sync?.value === 'true'}
                        source={settings.auto_sync?.source}
                        onCheckedChange={(c) => updateSetting('auto_sync', c ? 'true' : 'false')}
                        onReset={() => resetSetting('auto_sync')}
                      />

                      <CheckboxSettingRow
                        label="Auto-commit store changes"
                        settingKey="auto_commit_store"
                        checked={settings.auto_commit_store?.value === 'true'}
                        source={settings.auto_commit_store?.source}
                        onCheckedChange={(c) =>
                          updateSetting('auto_commit_store', c ? 'true' : 'false')
                        }
                        onReset={() => resetSetting('auto_commit_store')}
                      />
                    </div>
                  </div>
                </TabsContent>

                <TabsContent
                  forceMount
                  value="file-patterns"
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:hidden"
                >
                  <p className="text-xs text-muted-foreground py-2">
                    Override which AI file patterns are active for this repository. These patterns
                    will be synced between the local store and the target repository.
                  </p>
                  <PatternList
                    patterns={filePatterns}
                    onToggle={toggleFilePattern}
                    onRemove={removeFilePattern}
                    newPattern={newFilePattern}
                    onNewPatternChange={setNewFilePattern}
                    onAdd={addFilePattern}
                    placeholder=".new-tool/**"
                  />
                </TabsContent>

                <TabsContent
                  forceMount
                  value="ignore-patterns"
                  className="absolute inset-0 mt-0 flex flex-col data-[state=inactive]:hidden"
                >
                  <p className="text-xs text-muted-foreground py-2">
                    Override which ignore patterns are active for this repository.
                  </p>
                  <PatternList
                    patterns={ignorePatterns}
                    onToggle={toggleIgnorePattern}
                    onRemove={removeIgnorePattern}
                    newPattern={newIgnorePattern}
                    onNewPatternChange={setNewIgnorePattern}
                    onAdd={addIgnorePattern}
                    placeholder="build/**"
                  />
                </TabsContent>
              </div>
            </Tabs>

            <div className="flex items-center gap-2 pt-2 shrink-0">
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
              {activeTab === 'file-patterns' && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setShowApplyConfirm(true)}
                        disabled={applyingGitignore}
                      >
                        {applyingGitignore ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                        Apply to .gitignore
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      Add these patterns to the target repo's .gitignore and untrack matching files
                      from git overthere.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {activeTab === 'ignore-patterns' && (
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="sm"
                        className="ml-auto"
                        onClick={() => setShowCleanConfirm(true)}
                        disabled={cleaningIgnored}
                      >
                        {cleaningIgnored ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Eraser className="h-3.5 w-3.5" />
                        )}
                        Clean files
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-xs">
                      Remove tracked files matching these ignore patterns from both store and
                      target.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        )}
      </DialogContent>

      <ConfirmDialog
        open={showApplyConfirm}
        onOpenChange={setShowApplyConfirm}
        onConfirm={handleApplyGitignore}
        title="Update target .gitignore file"
        description="This will update the .gitignore file in the target repository to include these AI file patterns, and untrack any matching files from git. Local pattern overrides will be respected. Existing .gitignore entries outside the managed block will not be affected."
        confirmLabel="Apply to .gitignore"
      />

      <ConfirmDialog
        open={showApplyAfterSave}
        onOpenChange={setShowApplyAfterSave}
        onConfirm={handleApplyGitignore}
        title="Update target .gitignore file?"
        description="Settings have been saved. Would you like to update the .gitignore file in the target repository to reflect the new patterns?"
        confirmLabel="Apply to .gitignore"
      />

      <AlertDialog open={showCleanConfirm} onOpenChange={setShowCleanConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clean ignored files</AlertDialogTitle>
            <AlertDialogDescription>
              Remove tracked files matching the enabled ignore patterns for this repository. This
              action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCleanIgnored('target')}
              disabled={cleaningIgnored}
            >
              Clean target only
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleCleanIgnored('store')}
              disabled={cleaningIgnored}
            >
              Clean store only
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleCleanIgnored('both')}
              disabled={cleaningIgnored}
            >
              {cleaningIgnored ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Clean both
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
