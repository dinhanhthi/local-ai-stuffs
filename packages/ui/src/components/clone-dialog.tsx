import { useState, useMemo, useCallback } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useRepos } from '@/hooks/use-repos';
import { api, type CloneFileResult, type CloneRepoResult, type CloneResolution } from '@/lib/api';
import { diffHighlight } from '@/lib/diff-highlight';
import { ChevronDown, ChevronRight, Check, FilePlus, Equal, GitCompare } from 'lucide-react';
import { cn } from '../lib/utils';

interface CloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceRepoId: string;
  sourceRepoName: string;
  sourcePaths: string[];
}

type Step = 'select' | 'preview' | 'done';

interface ConflictResolutionState {
  action: 'overwrite' | 'skip' | 'manual';
  content?: string;
}

function getExtensions(filePath: string) {
  if (filePath.endsWith('.json')) return [json()];
  return [markdown()];
}

function StatusBadge({ status }: { status: CloneFileResult['status'] }) {
  switch (status) {
    case 'will_create':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
          <FilePlus className="h-3 w-3" /> New
        </span>
      );
    case 'already_same':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          <Equal className="h-3 w-3" /> Same
        </span>
      );
    case 'will_conflict':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
          <GitCompare className="h-3 w-3" /> Conflict
        </span>
      );
    case 'created':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
          <Check className="h-3 w-3" /> Created
        </span>
      );
    case 'skipped':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          Skipped
        </span>
      );
    case 'overwritten':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          <Check className="h-3 w-3" /> Overwritten
        </span>
      );
    case 'manual_saved':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
          <Check className="h-3 w-3" /> Saved
        </span>
      );
    default:
      return null;
  }
}

function ConflictItem({
  file,
  targetRepoId,
  resolution,
  onResolutionChange,
}: {
  file: CloneFileResult;
  targetRepoId: string;
  resolution: ConflictResolutionState;
  onResolutionChange: (
    targetRepoId: string,
    relativePath: string,
    resolution: ConflictResolutionState,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const sourceExts = useMemo(
    () => [
      ...getExtensions(file.relativePath),
      ...diffHighlight(file.sourceContent ?? '', file.existingContent ?? '', 'a'),
      EditorView.lineWrapping,
    ],
    [file.sourceContent, file.existingContent, file.relativePath],
  );

  const existingExts = useMemo(
    () => [
      ...getExtensions(file.relativePath),
      ...diffHighlight(file.existingContent ?? '', file.sourceContent ?? '', 'b'),
      EditorView.lineWrapping,
    ],
    [file.sourceContent, file.existingContent, file.relativePath],
  );

  const manualExts = useMemo(
    () => [...getExtensions(file.relativePath), EditorView.lineWrapping],
    [file.relativePath],
  );

  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-accent/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <span className="font-mono truncate">{file.relativePath}</span>
        <span className="ml-auto shrink-0">
          <StatusBadge status="will_conflict" />
        </span>
      </button>
      {expanded && (
        <div className="border-t border-amber-500/20 p-3 space-y-3">
          <Tabs defaultValue="source" className="w-full">
            <TabsList className="justify-start">
              <TabsTrigger className="text-xs" value="source">
                Source
              </TabsTrigger>
              <TabsTrigger className="text-xs" value="existing">
                Existing
              </TabsTrigger>
              {resolution.action === 'manual' && (
                <TabsTrigger className="text-xs" value="manual">
                  Manual Edit
                </TabsTrigger>
              )}
            </TabsList>
            <TabsContent value="source" className="mt-2 overflow-hidden rounded-md border">
              <CodeMirror
                value={file.sourceContent ?? ''}
                height="200px"
                theme={oneDark}
                extensions={sourceExts}
                readOnly
              />
            </TabsContent>
            <TabsContent value="existing" className="mt-2 overflow-hidden rounded-md border">
              <CodeMirror
                value={file.existingContent ?? ''}
                height="200px"
                theme={oneDark}
                extensions={existingExts}
                readOnly
              />
            </TabsContent>
            {resolution.action === 'manual' && (
              <TabsContent value="manual" className="mt-2 overflow-hidden rounded-md border">
                <CodeMirror
                  value={resolution.content ?? file.sourceContent ?? ''}
                  height="200px"
                  theme={oneDark}
                  extensions={manualExts}
                  onChange={(val) =>
                    onResolutionChange(targetRepoId, file.relativePath, {
                      action: 'manual',
                      content: val,
                    })
                  }
                />
              </TabsContent>
            )}
          </Tabs>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">Resolution:</span>
            {(['overwrite', 'skip', 'manual'] as const).map((action) => (
              <label key={action} className="flex items-center gap-1.5 cursor-pointer">
                <CircleCheck
                  checked={resolution.action === action}
                  onCheckedChange={() =>
                    onResolutionChange(targetRepoId, file.relativePath, {
                      action,
                      content:
                        action === 'manual'
                          ? (resolution.content ?? file.sourceContent ?? '')
                          : undefined,
                    })
                  }
                />
                <span className="capitalize">
                  {action === 'overwrite'
                    ? 'Overwrite (Keep source)'
                    : action === 'skip'
                      ? 'Keep existing'
                      : 'Manual edit'}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function CloneDialog({
  open,
  onOpenChange,
  sourceRepoId,
  sourceRepoName,
  sourcePaths,
}: CloneDialogProps) {
  const { repos } = useRepos();
  const [step, setStep] = useState<Step>('select');
  const [selectedRepoIds, setSelectedRepoIds] = useState<Set<string>>(new Set());
  const [previewResults, setPreviewResults] = useState<CloneRepoResult[]>([]);
  const [executeResults, setExecuteResults] = useState<CloneRepoResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolutions, setResolutions] = useState<Map<string, ConflictResolutionState>>(new Map());

  const availableRepos = useMemo(
    () => repos.filter((r) => r.id !== sourceRepoId),
    [repos, sourceRepoId],
  );

  const toggleRepo = useCallback((repoId: string) => {
    setSelectedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

  const handleResolutionChange = useCallback(
    (targetRepoId: string, relativePath: string, res: ConflictResolutionState) => {
      setResolutions((prev) => {
        const next = new Map(prev);
        next.set(`${targetRepoId}:${relativePath}`, res);
        return next;
      });
    },
    [],
  );

  const handlePreview = async () => {
    setLoading(true);
    try {
      const data = await api.clone.preview(sourceRepoId, sourcePaths, Array.from(selectedRepoIds));
      setPreviewResults(data.results);
      // Initialize resolutions for conflicts with default 'overwrite'
      const newResolutions = new Map<string, ConflictResolutionState>();
      for (const repo of data.results) {
        for (const file of repo.files) {
          if (file.status === 'will_conflict') {
            newResolutions.set(`${repo.targetRepoId}:${file.relativePath}`, {
              action: 'overwrite',
            });
          }
        }
      }
      setResolutions(newResolutions);
      setStep('preview');
    } finally {
      setLoading(false);
    }
  };

  const handleClone = async () => {
    setLoading(true);
    try {
      const cloneResolutions: CloneResolution[] = [];
      for (const [key, res] of resolutions) {
        const [targetRepoId, ...pathParts] = key.split(':');
        const relativePath = pathParts.join(':');
        cloneResolutions.push({
          targetRepoId,
          relativePath,
          action: res.action,
          content: res.content,
        });
      }
      const data = await api.clone.execute(
        sourceRepoId,
        sourcePaths,
        Array.from(selectedRepoIds),
        cloneResolutions,
      );
      setExecuteResults(data.results);
      setStep('done');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after animation
    setTimeout(() => {
      setStep('select');
      setSelectedRepoIds(new Set());
      setPreviewResults([]);
      setExecuteResults([]);
      setResolutions(new Map());
    }, 200);
  };

  const pathLabel = sourcePaths.length === 1 ? sourcePaths[0] : `${sourcePaths.length} items`;

  // Count totals for done step
  const doneSummary = useMemo(() => {
    let created = 0;
    let skipped = 0;
    let overwritten = 0;
    let manualSaved = 0;
    for (const repo of executeResults) {
      for (const file of repo.files) {
        if (file.status === 'created') created++;
        else if (file.status === 'skipped') skipped++;
        else if (file.status === 'overwritten') overwritten++;
        else if (file.status === 'manual_saved') manualSaved++;
      }
    }
    return { created, skipped, overwritten, manualSaved };
  }, [executeResults]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col p-2">
        <DialogHeader className="p-2">
          <DialogTitle>
            {step === 'select' ? 'Clone to repositories' : step === 'preview' ? 'Preview' : 'Done'}
          </DialogTitle>
          <DialogDescription>
            {step === 'select'
              ? `Clone "${pathLabel}" from ${sourceRepoName}`
              : step === 'preview'
                ? 'Review changes before cloning'
                : null}
          </DialogDescription>
        </DialogHeader>

        <div
          className={cn('flex-1 min-h-0', {
            'overflow-y-auto border-border border rounded-md': step !== 'done',
            'flex flex-col': step === 'done',
          })}
        >
          {step === 'select' && (
            <div className="space-y-1 divide-y divide-border">
              {availableRepos.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  No other repositories available
                </p>
              ) : (
                availableRepos.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => toggleRepo(repo.id)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                  >
                    <CircleCheck
                      checked={selectedRepoIds.has(repo.id)}
                      className="pointer-events-none"
                    />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{repo.name}</div>
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {repo.localPath}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          )}

          {step === 'preview' && (
            <div className="divide-y divide-border">
              {previewResults.map((repo) => {
                const newCount = repo.files.filter((f) => f.status === 'will_create').length;
                const sameCount = repo.files.filter((f) => f.status === 'already_same').length;
                const conflictCount = repo.files.filter((f) => f.status === 'will_conflict').length;

                return (
                  <div key={repo.targetRepoId} className="p-3">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium">{repo.targetRepoName}</h4>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        {newCount > 0 && (
                          <span className="text-green-600 dark:text-green-400">{newCount} new</span>
                        )}
                        {sameCount > 0 && <span>{sameCount} same</span>}
                        {conflictCount > 0 && (
                          <span className="text-amber-600 dark:text-amber-400">
                            {conflictCount} conflict{conflictCount > 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      {repo.files.map((file) => {
                        if (file.status === 'will_conflict') {
                          const key = `${repo.targetRepoId}:${file.relativePath}`;
                          return (
                            <ConflictItem
                              key={file.relativePath}
                              file={file}
                              targetRepoId={repo.targetRepoId}
                              resolution={resolutions.get(key) ?? { action: 'overwrite' }}
                              onResolutionChange={handleResolutionChange}
                            />
                          );
                        }
                        return (
                          <div
                            key={file.relativePath}
                            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
                          >
                            <span className="font-mono truncate">{file.relativePath}</span>
                            <span className="ml-auto shrink-0">
                              <StatusBadge status={file.status} />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {step === 'done' && (
            <div className="flex flex-col items-center justify-center gap-4 flex-1 min-h-0">
              <div className="flex flex-col items-center justify-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15">
                  <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div className="text-center space-y-1">
                  <div className="text-sm font-medium">Clone completed</div>
                  <div className="text-xs text-muted-foreground space-x-2">
                    {doneSummary.created > 0 && <span>{doneSummary.created} created</span>}
                    {doneSummary.overwritten > 0 && (
                      <span>{doneSummary.overwritten} overwritten</span>
                    )}
                    {doneSummary.manualSaved > 0 && (
                      <span>{doneSummary.manualSaved} manually saved</span>
                    )}
                    {doneSummary.skipped > 0 && <span>{doneSummary.skipped} skipped</span>}
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-0 w-full border-border border rounded-md divide-y divide-border flex-1 min-h-0 overflow-y-auto">
                {executeResults.map((repo) => (
                  <div key={repo.targetRepoId} className="w-full p-3">
                    <h4 className="text-xs font-medium text-muted-foreground">
                      {repo.targetRepoName}
                    </h4>
                    {repo.files.map((file) => (
                      <div
                        key={file.relativePath}
                        className="flex items-center gap-2 rounded-md px-3 py-1 text-xs"
                      >
                        <span className="font-mono truncate">{file.relativePath}</span>
                        <span className="ml-auto shrink-0">
                          <StatusBadge status={file.status} />
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="p-2">
          {step === 'select' && (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={handlePreview} disabled={selectedRepoIds.size === 0 || loading}>
                {loading ? 'Checking...' : 'Next'}
              </Button>
            </>
          )}
          {step === 'preview' && (
            <>
              <Button variant="outline" onClick={() => setStep('select')}>
                Back
              </Button>
              <Button onClick={handleClone} disabled={loading}>
                {loading ? 'Cloning...' : 'Clone'}
              </Button>
            </>
          )}
          {step === 'done' && <Button onClick={handleClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
