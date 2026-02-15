import { useState, useEffect, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { FileEditor } from '@/components/file-editor';
import { FileEditorLayout } from '@/components/file-editor-layout';
import { FileTree, type FileTreeItem } from '@/components/file-tree';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Plus } from 'lucide-react';

export function TemplatesPage() {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [newFileName, setNewFileName] = useState('');
  const [showNewFile, setShowNewFile] = useState(false);

  const treeItems: FileTreeItem[] = useMemo(() => files.map((f) => ({ path: f })), [files]);

  const fetchFiles = async () => {
    setLoading(true);
    try {
      const data = await api.templates.listFiles();
      setFiles(data.files);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  const handleSelectFile = async (filePath: string) => {
    setSelectedFile(filePath);
    setFileContent(null);
    try {
      const data = await api.templates.getFile(filePath);
      setFileContent(data.content);
    } catch {
      setFileContent(null);
    }
  };

  const handleSave = async (content: string) => {
    if (!selectedFile) return;
    await api.templates.updateFile(selectedFile, content);
  };

  const handleCreateFile = async () => {
    if (!newFileName.trim()) return;
    await api.templates.createFile(newFileName.trim(), '');
    setNewFileName('');
    setShowNewFile(false);
    await fetchFiles();
    await handleSelectFile(newFileName.trim());
  };

  return (
    <div className="flex flex-1 min-h-0 flex-col gap-6 overflow-hidden p-4 md:p-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Default Template</h2>
        <p className="text-sm text-muted-foreground">
          Template files applied when registering new repositories.
        </p>
      </div>

      <FileEditorLayout
        listTitle="Template Files"
        listActions={
          <Button size="icon-sm" variant="ghost" onClick={() => setShowNewFile(true)}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        }
        listPrefix={
          showNewFile ? (
            <div className="flex gap-2 mb-2 px-2">
              <Input
                placeholder="CLAUDE.md"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFile()}
                className="text-xs"
              />
              <Button size="sm" onClick={handleCreateFile}>
                Add
              </Button>
            </div>
          ) : undefined
        }
        listContent={
          loading ? (
            <p className="text-sm text-muted-foreground p-2">Loading...</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-muted-foreground p-2">No template files yet</p>
          ) : (
            <FileTree items={treeItems} selectedPath={selectedFile} onSelect={handleSelectFile} />
          )
        }
        selectedFile={selectedFile}
        emptyText="Select a template file to edit"
      >
        {(toolbarEl) =>
          fileContent !== null ? (
            <FileEditor
              content={fileContent}
              filePath={selectedFile!}
              onSave={handleSave}
              toolbarTarget={toolbarEl}
            />
          ) : null
        }
      </FileEditorLayout>
    </div>
  );
}
