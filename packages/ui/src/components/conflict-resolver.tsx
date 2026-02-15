import { useMemo, useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { RefreshCw, WrapText, ChevronDown, Trash2 } from 'lucide-react';
import { api, type ConflictDetail } from '@/lib/api';
import { diffHighlight } from '@/lib/diff-highlight';

interface ConflictResolverProps {
  conflict: ConflictDetail;
  onResolved: () => void;
  onRefresh?: () => void;
  toolbarTarget?: HTMLElement | null;
}

function getExtensions(filePath: string) {
  if (filePath.endsWith('.json')) return [json()];
  return [markdown()];
}

function getPlaceholder(content: string | null): string | null {
  if (content === '') {
    return '(file exists but its content is empty)';
  }
  return null;
}

function RemovedNotice({ side }: { side: 'store' | 'target' }) {
  const label = side === 'store' ? 'store' : 'target folder';
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Trash2 className="h-10 w-10 opacity-30" />
      <p className="text-sm">This file has been removed from the {label}</p>
    </div>
  );
}

export function ConflictResolver({
  conflict,
  onResolved,
  onRefresh,
  toolbarTarget,
}: ConflictResolverProps) {
  const [resolving, setResolving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Pre-fill manual editor: use merged content (with conflict markers) if available,
  // otherwise fall back to store content
  const [manualContent, setManualContent] = useState(
    conflict.mergedContent || conflict.storeContent || '',
  );
  const [wordWrap, setWordWrap] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState('500px');

  // Keep manual editor in sync when conflict content refreshes (e.g. file changed on disk)
  useEffect(() => {
    setManualContent(conflict.mergedContent || conflict.storeContent || '');
  }, [conflict.storeContent, conflict.mergedContent]);

  // Always stop the refresh spinner when the conflict prop updates (even if content is unchanged)
  useEffect(() => {
    setRefreshing(false);
  }, [conflict]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      setEditorHeight(`${entry.contentRect.height}px`);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const storeText = conflict.storeContent ?? '';
  const targetText = conflict.targetContent ?? '';
  const baseText = conflict.baseContent ?? '';

  const wrapExt = wordWrap ? [EditorView.lineWrapping] : [];

  const storeExtensions = useMemo(
    () => [
      ...getExtensions(conflict.relativePath),
      ...diffHighlight(storeText, targetText, 'a'),
      ...wrapExt,
    ],
    [conflict.relativePath, storeText, targetText, wordWrap],
  );

  const targetExtensions = useMemo(
    () => [
      ...getExtensions(conflict.relativePath),
      ...diffHighlight(targetText, storeText, 'b'),
      ...wrapExt,
    ],
    [conflict.relativePath, storeText, targetText, wordWrap],
  );

  const baseExtensions = useMemo(
    () => [...getExtensions(conflict.relativePath), ...wrapExt],
    [conflict.relativePath, wordWrap],
  );

  const manualExtensions = useMemo(
    () => [...getExtensions(conflict.relativePath), ...wrapExt],
    [conflict.relativePath, wordWrap],
  );

  const handleResolve = async (resolution: string) => {
    setResolving(true);
    try {
      await api.conflicts.resolve(
        conflict.id,
        resolution,
        resolution === 'manual' ? manualContent : undefined,
      );
      onResolved();
    } finally {
      setResolving(false);
    }
  };

  const toolbar = (
    <div className="flex gap-2">
      {onRefresh && (
        <Button
          size="icon-sm"
          variant="outline"
          onClick={() => {
            setRefreshing(true);
            onRefresh();
          }}
          disabled={refreshing}
          aria-label="Refresh conflict"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </Button>
      )}
      <Toggle
        size="icon-sm"
        variant="outline"
        pressed={wordWrap}
        onPressedChange={setWordWrap}
        aria-label="Toggle word wrap"
      >
        <WrapText className="h-3.5 w-3.5" />
      </Toggle>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" disabled={resolving}>
            Action <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => handleResolve('keep_store')}>
            Keep Store
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleResolve('keep_target')}>
            Keep Target
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => handleResolve('manual')}>Save Manual</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive" onClick={() => handleResolve('delete')}>
            Delete File
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <Tabs defaultValue="store" className="flex min-h-0 flex-1 flex-col pt-2">
        <div className="px-2">
          <TabsList className="justify-start">
            <TabsTrigger className="text-xs" value="store">
              Store Version
            </TabsTrigger>
            <TabsTrigger className="text-xs" value="target">
              Target Version
            </TabsTrigger>
            {conflict.baseContent !== null && (
              <TabsTrigger className="text-xs" value="base">
                Base Version
              </TabsTrigger>
            )}
            <TabsTrigger className="text-xs" value="manual">
              Manual Edit
            </TabsTrigger>
          </TabsList>
        </div>
        <div ref={containerRef} className="min-h-0 flex-1">
          <TabsContent value="store" className="mt-2 h-full overflow-hidden rounded-md border">
            {conflict.storeContent === null ? (
              <RemovedNotice side="store" />
            ) : (
              <CodeMirror
                value={getPlaceholder(conflict.storeContent) ?? storeText}
                height={editorHeight}
                theme={oneDark}
                extensions={storeExtensions}
                readOnly
              />
            )}
          </TabsContent>
          <TabsContent value="target" className="mt-2 h-full overflow-hidden rounded-md border">
            {conflict.targetContent === null ? (
              <RemovedNotice side="target" />
            ) : (
              <CodeMirror
                value={getPlaceholder(conflict.targetContent) ?? targetText}
                height={editorHeight}
                theme={oneDark}
                extensions={targetExtensions}
                readOnly
              />
            )}
          </TabsContent>
          {conflict.baseContent !== null && (
            <TabsContent value="base" className="mt-2 h-full overflow-hidden rounded-md border">
              <CodeMirror
                value={baseText}
                height={editorHeight}
                theme={oneDark}
                extensions={baseExtensions}
                readOnly
              />
            </TabsContent>
          )}
          <TabsContent value="manual" className="mt-2 h-full overflow-hidden rounded-md border">
            <CodeMirror
              value={manualContent}
              height={editorHeight}
              theme={oneDark}
              extensions={manualExtensions}
              onChange={setManualContent}
            />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
