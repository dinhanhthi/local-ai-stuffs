import { ConfirmDialog } from '@/components/confirm-dialog';
import { PatternList } from '@/components/pattern-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SettingRow, CheckboxSettingRow } from '@/components/setting-rows';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, type FilePattern, type MachineInfo } from '@/lib/api';
import { useMachine } from '@/hooks/use-machines';
import { Check, Copy, Eraser, Loader2, Monitor, Save, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

function stripIds(patterns: FilePattern[]) {
  return patterns.map(({ pattern, enabled }) => ({ pattern, enabled }));
}

const settingsTabs = ['general', 'file-patterns', 'ignore-patterns', 'machine'] as const;

export function SettingsPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const getTabFromHash = useCallback(() => {
    const hash = location.hash.replace('#', '');
    if (hash && (settingsTabs as readonly string[]).includes(hash)) return hash;
    return 'general';
  }, [location.hash]);

  const [activeTab, setActiveTab] = useState(getTabFromHash);

  useEffect(() => {
    const tab = getTabFromHash();
    if (tab !== activeTab) setActiveTab(tab);
  }, [location.hash, getTabFromHash]);

  const handleTabChange = useCallback(
    (value: string) => {
      setActiveTab(value);
      navigate(`/settings#${value}`, { replace: true });
    },
    [navigate],
  );

  const [settings, setSettings] = useState<Record<string, string>>({});
  const [patterns, setPatterns] = useState<FilePattern[]>([]);
  const [ignorePatterns, setIgnorePatterns] = useState<FilePattern[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [newIgnorePattern, setNewIgnorePattern] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [savingPatterns, setSavingPatterns] = useState(false);
  const [savingIgnorePatterns, setSavingIgnorePatterns] = useState(false);
  const [cleaningIgnored, setCleaningIgnored] = useState(false);
  const [showCleanConfirm, setShowCleanConfirm] = useState(false);
  const [applyingGitignore, setApplyingGitignore] = useState(false);
  const [showApplyGitignoreConfirm, setShowApplyGitignoreConfirm] = useState(false);

  const { machineName, machineId, updateName } = useMachine();
  const [editingName, setEditingName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [nameEditing, setNameEditing] = useState(false);
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [copiedId, setCopiedId] = useState(false);

  useEffect(() => {
    api.machines
      .list()
      .then((data) => setMachines(data.machines))
      .catch(() => {});
  }, []);

  const savedSettings = useRef<string>('');
  const savedPatterns = useRef<string>('');
  const savedIgnorePatterns = useRef<string>('');

  const settingsDirty = JSON.stringify(settings) !== savedSettings.current;
  const patternsDirty = JSON.stringify(stripIds(patterns)) !== savedPatterns.current;
  const ignorePatternsDirty =
    JSON.stringify(stripIds(ignorePatterns)) !== savedIgnorePatterns.current;

  const snapshotSettings = useCallback((s: Record<string, string>) => {
    savedSettings.current = JSON.stringify(s);
  }, []);
  const snapshotPatterns = useCallback((p: FilePattern[]) => {
    savedPatterns.current = JSON.stringify(stripIds(p));
  }, []);
  const snapshotIgnorePatterns = useCallback((p: FilePattern[]) => {
    savedIgnorePatterns.current = JSON.stringify(stripIds(p));
  }, []);

  useEffect(() => {
    const fetchAll = async () => {
      setLoading(true);
      try {
        const [settingsData, patternsData, ignorePatternsData] = await Promise.all([
          api.settings.get(),
          api.patterns.get(),
          api.ignorePatterns.get(),
        ]);
        setSettings(settingsData.settings);
        setPatterns(patternsData.patterns);
        setIgnorePatterns(ignorePatternsData.patterns);
        snapshotSettings(settingsData.settings);
        snapshotPatterns(patternsData.patterns);
        snapshotIgnorePatterns(ignorePatternsData.patterns);
      } finally {
        setLoading(false);
      }
    };
    fetchAll();
  }, [snapshotSettings, snapshotPatterns, snapshotIgnorePatterns]);

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    try {
      await api.settings.update(settings);
      snapshotSettings(settings);
    } finally {
      setSavingSettings(false);
    }
  };

  const handleSavePatterns = async () => {
    setSavingPatterns(true);
    try {
      await api.patterns.update(patterns);
      snapshotPatterns(patterns);
    } finally {
      setSavingPatterns(false);
    }
  };

  const handleSaveIgnorePatterns = async () => {
    setSavingIgnorePatterns(true);
    try {
      await api.ignorePatterns.update(ignorePatterns);
      snapshotIgnorePatterns(ignorePatterns);
    } finally {
      setSavingIgnorePatterns(false);
    }
  };

  const handleCancelSettings = () => {
    setSettings(JSON.parse(savedSettings.current));
  };

  const handleCancelPatterns = () => {
    setPatterns(JSON.parse(savedPatterns.current));
  };

  const handleCancelIgnorePatterns = () => {
    setIgnorePatterns(JSON.parse(savedIgnorePatterns.current));
  };

  const handleAddPattern = () => {
    if (!newPattern.trim()) return;
    setPatterns([...patterns, { pattern: newPattern.trim(), enabled: true }]);
    setNewPattern('');
  };

  const handleRemovePattern = (index: number) => {
    setPatterns(patterns.filter((_, i) => i !== index));
  };

  const handleTogglePattern = (index: number) => {
    setPatterns(patterns.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)));
  };

  const handleCleanIgnored = async () => {
    setCleaningIgnored(true);
    try {
      const result = await api.ignorePatterns.clean();
      if (result.removed > 0) {
        toast.success(`Removed ${result.removed} ignored file${result.removed > 1 ? 's' : ''}`);
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

  const handleApplyGitignore = async () => {
    setApplyingGitignore(true);
    try {
      const result = await api.applyGitignore();
      const parts: string[] = [];
      parts.push(`${result.reposProcessed} repo(s) processed`);
      if (result.totalAdded > 0) parts.push(`${result.totalAdded} pattern(s) added`);
      if (result.totalRemoved > 0) parts.push(`${result.totalRemoved} file(s) untracked from git`);
      toast.success(parts.join(', '));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply .gitignore');
    } finally {
      setApplyingGitignore(false);
    }
  };

  const handleAddIgnorePattern = () => {
    if (!newIgnorePattern.trim()) return;
    setIgnorePatterns([...ignorePatterns, { pattern: newIgnorePattern.trim(), enabled: true }]);
    setNewIgnorePattern('');
  };

  const handleRemoveIgnorePattern = (index: number) => {
    setIgnorePatterns(ignorePatterns.filter((_, i) => i !== index));
  };

  const handleToggleIgnorePattern = (index: number) => {
    setIgnorePatterns(
      ignorePatterns.map((p, i) => (i === index ? { ...p, enabled: !p.enabled } : p)),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-4 md:p-6">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <p className="text-sm text-muted-foreground">Configure sync behavior and file patterns.</p>
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-4 pb-4 md:px-6 md:pb-6">
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="flex flex-col flex-1 min-h-0"
        >
          <TabsList className="self-start">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="file-patterns">AI File Patterns</TabsTrigger>
            <TabsTrigger value="ignore-patterns">Ignore Patterns</TabsTrigger>
            <TabsTrigger value="machine">Machine</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="flex-1 min-h-0 overflow-y-auto">
            <div className="max-w-lg py-2">
              <div className="space-y-3 pb-4">
                <div className="text-sm font-medium">Sync timing and behavior</div>
                <SettingRow
                  label="Sync Interval (ms)"
                  settingKey="sync_interval_ms"
                  type="number"
                  value={settings.sync_interval_ms || '5000'}
                  onChange={(v) => setSettings({ ...settings, sync_interval_ms: v })}
                />
                <SettingRow
                  label="Watch Debounce (ms)"
                  settingKey="watch_debounce_ms"
                  type="number"
                  value={settings.watch_debounce_ms || '300'}
                  onChange={(v) => setSettings({ ...settings, watch_debounce_ms: v })}
                />
                <CheckboxSettingRow
                  label="Auto Sync"
                  settingKey="auto_sync"
                  checked={settings.auto_sync === 'true'}
                  onCheckedChange={(checked) =>
                    setSettings({ ...settings, auto_sync: checked ? 'true' : 'false' })
                  }
                />
                <CheckboxSettingRow
                  label="Auto-commit store changes"
                  settingKey="auto_commit_store"
                  checked={settings.auto_commit_store === 'true'}
                  onCheckedChange={(checked) =>
                    setSettings({ ...settings, auto_commit_store: checked ? 'true' : 'false' })
                  }
                />
              </div>

              <div className="py-4 border-t">
                <p className="text-sm mb-3">
                  Store size thresholds for warnings and sync blocking.
                </p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="size_warning" className="text-xs text-yellow-600">
                      Warning (MB)
                    </Label>
                    <Input
                      id="size_warning"
                      type="number"
                      min="1"
                      value={settings.size_warning_mb || '20'}
                      onChange={(e) =>
                        setSettings({ ...settings, size_warning_mb: e.target.value })
                      }
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="size_danger" className="text-xs text-destructive">
                      Danger (MB)
                    </Label>
                    <Input
                      id="size_danger"
                      type="number"
                      min="1"
                      value={settings.size_danger_mb || '50'}
                      onChange={(e) => setSettings({ ...settings, size_danger_mb: e.target.value })}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label
                      htmlFor="size_blocked"
                      className="text-xs text-destructive font-semibold"
                    >
                      Block sync (MB)
                    </Label>
                    <Input
                      id="size_blocked"
                      type="number"
                      min="1"
                      value={settings.size_blocked_mb || '100'}
                      onChange={(e) =>
                        setSettings({ ...settings, size_blocked_mb: e.target.value })
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Apply .gitignore</p>
                    <p className="text-xs text-muted-foreground">
                      Re-apply managed .gitignore block and untrack files from git for all active
                      repos
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowApplyGitignoreConfirm(true)}
                    disabled={applyingGitignore}
                  >
                    {applyingGitignore ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Apply
                  </Button>
                </div>
              </div>

              <div className="flex gap-2 mt-6">
                <Button
                  onClick={handleCancelSettings}
                  disabled={!settingsDirty}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveSettings}
                  disabled={savingSettings || !settingsDirty}
                  size="sm"
                >
                  {savingSettings ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="file-patterns" className="flex-1 min-h-0 flex flex-col">
            <div className="max-w-lg flex flex-col flex-1 min-h-0">
              <p className="text-sm py-2">Glob patterns for files to watch and sync.</p>
              <PatternList
                patterns={patterns}
                onToggle={handleTogglePattern}
                onRemove={handleRemovePattern}
                newPattern={newPattern}
                onNewPatternChange={setNewPattern}
                onAdd={handleAddPattern}
                placeholder=".new-tool/**"
              />
              <div className="flex gap-2 pt-3">
                <Button
                  onClick={handleCancelPatterns}
                  disabled={!patternsDirty}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSavePatterns}
                  disabled={savingPatterns || !patternsDirty}
                  size="sm"
                >
                  {savingPatterns ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="ignore-patterns" className="flex-1 min-h-0 flex flex-col">
            <div className="max-w-lg flex flex-col flex-1 min-h-0">
              <div className="flex items-center justify-between py-2">
                <p className="text-sm">Files matching these patterns will be excluded from sync.</p>
                <Button
                  onClick={() => setShowCleanConfirm(true)}
                  disabled={cleaningIgnored}
                  size="sm"
                  variant="outline"
                >
                  {cleaningIgnored ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Eraser className="h-3.5 w-3.5" />
                  )}
                  Apply
                </Button>
              </div>
              <PatternList
                patterns={ignorePatterns}
                onToggle={handleToggleIgnorePattern}
                onRemove={handleRemoveIgnorePattern}
                newPattern={newIgnorePattern}
                onNewPatternChange={setNewIgnorePattern}
                onAdd={handleAddIgnorePattern}
                placeholder=".DS_Store"
              />
              <div className="flex gap-2 pt-3">
                <Button
                  onClick={handleCancelIgnorePatterns}
                  disabled={!ignorePatternsDirty}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleSaveIgnorePatterns}
                  disabled={savingIgnorePatterns || !ignorePatternsDirty}
                  size="sm"
                >
                  {savingIgnorePatterns ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="machine" className="flex-1 min-h-0 overflow-y-auto">
            <div className="max-w-lg py-2 space-y-6">
              <div className="space-y-3">
                <div className="text-sm font-medium">This machine</div>
                <div className="space-y-2">
                  <Label htmlFor="machine-name" className="text-xs">
                    Machine Name
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="machine-name"
                      value={nameEditing ? editingName : machineName || ''}
                      onChange={(e) => {
                        if (!nameEditing) setNameEditing(true);
                        setEditingName(e.target.value);
                      }}
                      onFocus={() => {
                        if (!nameEditing) {
                          setEditingName(machineName || '');
                          setNameEditing(true);
                        }
                      }}
                      placeholder="e.g. MacBook Pro"
                    />
                    {nameEditing && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setNameEditing(false)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          disabled={
                            savingName || !editingName.trim() || editingName === machineName
                          }
                          onClick={async () => {
                            setSavingName(true);
                            try {
                              await updateName(editingName.trim());
                              setNameEditing(false);
                              toast.success('Machine name updated');
                              api.machines
                                .list()
                                .then((data) => setMachines(data.machines))
                                .catch(() => {});
                            } catch (err) {
                              toast.error(
                                err instanceof Error ? err.message : 'Failed to update name',
                              );
                            } finally {
                              setSavingName(false);
                            }
                          }}
                        >
                          {savingName ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Save className="h-3.5 w-3.5" />
                          )}
                          Save
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Machine ID</Label>
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-mono bg-muted px-2 py-1.5 rounded border select-all">
                      {machineId || '—'}
                    </code>
                    {machineId && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(machineId);
                          setCopiedId(true);
                          setTimeout(() => setCopiedId(false), 2000);
                        }}
                        title="Copy machine ID"
                      >
                        {copiedId ? (
                          <Check className="h-3 w-3 text-green-600" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {machines.length > 0 && (
                <div className="space-y-3 border-t pt-4">
                  <div className="text-sm font-medium">Known machines</div>
                  <div className="space-y-2">
                    {machines.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
                      >
                        <Monitor className="h-4 w-4 text-muted-foreground shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{m.name}</span>
                            {m.isCurrent && (
                              <span className="text-[10px] font-medium bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                                current
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground font-mono truncate">
                            {m.id}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground shrink-0">
                          {new Date(m.lastSeen).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={showCleanConfirm}
        onOpenChange={setShowCleanConfirm}
        onConfirm={handleCleanIgnored}
        title="Clean ignored files"
        description="This will remove all currently tracked files that match the enabled ignore patterns from both the store and target locations. This action cannot be undone."
        confirmLabel="Clean"
        variant="destructive"
      />

      <ConfirmDialog
        open={showApplyGitignoreConfirm}
        onOpenChange={setShowApplyGitignoreConfirm}
        onConfirm={handleApplyGitignore}
        title="Apply .gitignore to all repos"
        description="This will update the .gitignore file in all active target repositories and untrack any AI config files from git. Each repo's local pattern overrides will be respected. Existing .gitignore entries outside the managed block will not be affected."
        confirmLabel="Apply"
      />
    </div>
  );
}
