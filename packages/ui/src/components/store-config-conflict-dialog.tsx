import { useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { Toggle } from '@/components/ui/toggle';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { WrapText, AlertTriangle } from 'lucide-react';
import { api, type StoreConfigConflict } from '@/lib/api';
import { toast } from 'sonner';
import { diffHighlight } from '@/lib/diff-highlight';

interface StoreConfigConflictDialogProps {
  conflicts: StoreConfigConflict[];
  onResolved: () => void;
}

interface SingleConflictResolverProps {
  conflict: StoreConfigConflict;
  onResolved: (file: StoreConfigConflict['file']) => void;
}

function SingleConflictResolver({ conflict, onResolved }: SingleConflictResolverProps) {
  const [resolving, setResolving] = useState(false);
  const [manualContent, setManualContent] = useState(conflict.content);
  const [wordWrap, setWordWrap] = useState(true);
  const wrapExt = wordWrap ? [EditorView.lineWrapping] : [];

  const oursExtensions = useMemo(
    () => [json(), ...diffHighlight(conflict.ours, conflict.theirs, 'a'), ...wrapExt],
    [conflict.ours, conflict.theirs, wordWrap],
  );

  const theirsExtensions = useMemo(
    () => [json(), ...diffHighlight(conflict.theirs, conflict.ours, 'b'), ...wrapExt],
    [conflict.ours, conflict.theirs, wordWrap],
  );

  const manualExtensions = useMemo(() => [json(), ...wrapExt], [wordWrap]);

  const handleResolve = async (content: string) => {
    setResolving(true);
    try {
      await api.store.resolveConfig(conflict.file, content);
      toast.success(`Resolved conflict in ${conflict.file}`);
      onResolved(conflict.file);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to resolve conflict');
    } finally {
      setResolving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Toggle
            size="icon-sm"
            variant="outline"
            pressed={wordWrap}
            onPressedChange={setWordWrap}
            aria-label="Toggle word wrap"
          >
            <WrapText className="h-3.5 w-3.5" />
          </Toggle>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={() => handleResolve(conflict.ours)}
          >
            Keep Local (Ours)
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={resolving}
            onClick={() => handleResolve(conflict.theirs)}
          >
            Keep Remote (Theirs)
          </Button>
          <Button size="sm" disabled={resolving} onClick={() => handleResolve(manualContent)}>
            Save Manual
          </Button>
        </div>
      </div>

      <Tabs defaultValue="ours" className="flex flex-col">
        <TabsList className="justify-start">
          <TabsTrigger className="text-xs" value="ours">
            Local Version (Ours)
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="theirs">
            Remote Version (Theirs)
          </TabsTrigger>
          <TabsTrigger className="text-xs" value="manual">
            Manual Edit
          </TabsTrigger>
        </TabsList>

        <TabsContent value="ours" className="mt-2 overflow-hidden rounded-md border">
          <CodeMirror
            value={conflict.ours}
            height="300px"
            theme={oneDark}
            extensions={oursExtensions}
            readOnly
          />
        </TabsContent>
        <TabsContent value="theirs" className="mt-2 overflow-hidden rounded-md border">
          <CodeMirror
            value={conflict.theirs}
            height="300px"
            theme={oneDark}
            extensions={theirsExtensions}
            readOnly
          />
        </TabsContent>
        <TabsContent value="manual" className="mt-2 overflow-hidden rounded-md border">
          <CodeMirror
            value={manualContent}
            height="300px"
            theme={oneDark}
            extensions={manualExtensions}
            onChange={setManualContent}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function StoreConfigConflictDialog({
  conflicts,
  onResolved,
}: StoreConfigConflictDialogProps) {
  const [remaining, setRemaining] = useState<StoreConfigConflict[]>(conflicts);

  const handleResolved = (file: StoreConfigConflict['file']) => {
    const next = remaining.filter((c) => c.file !== file);
    setRemaining(next);
    if (next.length === 0) {
      onResolved();
    }
  };

  const activeConflict = remaining[0];

  return (
    <Dialog open={remaining.length > 0}>
      <DialogContent className="max-w-3xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Config File Conflict Detected
          </DialogTitle>
          <DialogDescription>
            The pull resulted in a conflict in a store config file. You must resolve it before
            continuing.
            {remaining.length > 1 && (
              <span className="ml-1">
                ({remaining.length} files remaining:{' '}
                {remaining.map((c) => (
                  <Badge key={c.file} variant="outline" className="ml-1 text-xs">
                    {c.file}
                  </Badge>
                ))}
                )
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {activeConflict && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="font-mono text-xs">
                {activeConflict.file}
              </Badge>
            </div>
            <SingleConflictResolver conflict={activeConflict} onResolved={handleResolved} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
