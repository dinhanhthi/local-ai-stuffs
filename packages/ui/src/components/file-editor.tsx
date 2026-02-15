import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView, keymap, type KeyBinding } from '@codemirror/view';
import { EditorSelection } from '@codemirror/state';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { Save, WrapText } from 'lucide-react';

interface FileEditorProps {
  content: string;
  filePath: string;
  onSave: (content: string) => Promise<void>;
  toolbarTarget?: HTMLElement | null;
}

function wrapSelection(view: EditorView, before: string, after: string): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const replacement = before + selected + after;
    return {
      changes: { from: range.from, to: range.to, insert: replacement },
      range: selected
        ? EditorSelection.range(range.from, range.from + replacement.length)
        : EditorSelection.cursor(range.from + before.length),
    };
  });
  view.dispatch(changes);
  return true;
}

function wrapLink(view: EditorView): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const replacement = `[${selected}](url)`;
    const urlStart = range.from + selected.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: replacement },
      range: EditorSelection.range(urlStart, urlStart + 3),
    };
  });
  view.dispatch(changes);
  return true;
}

function getMarkdownKeybindings(): KeyBinding[] {
  return [
    { key: 'Mod-b', run: (view) => wrapSelection(view, '**', '**') },
    { key: 'Mod-i', run: (view) => wrapSelection(view, '*', '*') },
    { key: 'Mod-Shift-x', run: (view) => wrapSelection(view, '~~', '~~') },
    { key: 'Mod-e', run: (view) => wrapSelection(view, '`', '`') },
    { key: 'Mod-Shift-k', run: (view) => wrapLink(view) },
  ];
}

function isMarkdownFile(filePath: string) {
  return filePath.endsWith('.md') || filePath.endsWith('.mdc');
}

function getExtensions(filePath: string) {
  if (filePath.endsWith('.json')) return [json()];
  if (filePath.endsWith('.md') || filePath.endsWith('.mdc')) return [markdown()];
  return [markdown()]; // default to markdown
}

export function FileEditor({ content, filePath, onSave, toolbarTarget }: FileEditorProps) {
  const [value, setValue] = useState(content);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [wordWrap, setWordWrap] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const [editorHeight, setEditorHeight] = useState('500px');

  useEffect(() => {
    setValue(content);
    setDirty(false);
  }, [content]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      setEditorHeight(`${entry.contentRect.height}px`);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleChange = useCallback(
    (val: string) => {
      setValue(val);
      setDirty(val !== content);
    },
    [content],
  );

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(value);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(handleSave);
  saveRef.current = handleSave;

  const toggleWordWrapRef = useRef(() => setWordWrap((v) => !v));
  toggleWordWrapRef.current = () => setWordWrap((v) => !v);

  const editorKeymap = useRef([
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveRef.current();
          return true;
        },
      },
      ...(isMarkdownFile(filePath) ? getMarkdownKeybindings() : []),
    ]),
    EditorView.domEventHandlers({
      keydown: (event) => {
        if (event.altKey && event.code === 'KeyZ') {
          event.preventDefault();
          toggleWordWrapRef.current();
          return true;
        }
        return false;
      },
    }),
  ]);

  const toolbar = (
    <div className="flex gap-2">
      <Toggle
        size="icon-sm"
        variant="outline"
        pressed={wordWrap}
        onPressedChange={setWordWrap}
        aria-label="Toggle word wrap"
      >
        <WrapText className="size-4" />
      </Toggle>
      <Button size="sm" onClick={handleSave} disabled={!dirty || saving}>
        <Save className="size-4 mr-1" />
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarTarget && createPortal(toolbar, toolbarTarget)}
      <div ref={containerRef} className="min-h-0 flex-1 rounded-none border overflow-hidden">
        <CodeMirror
          value={value}
          height={editorHeight}
          theme={oneDark}
          extensions={[
            ...getExtensions(filePath),
            ...(wordWrap ? [EditorView.lineWrapping] : []),
            ...editorKeymap.current,
          ]}
          onChange={handleChange}
        />
      </div>
    </div>
  );
}
