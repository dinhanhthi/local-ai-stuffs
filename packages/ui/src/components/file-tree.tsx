import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SizeLabel } from '@/components/size-label';
import { type SizeThresholds } from '@/lib/utils';
import {
  ChevronRight,
  ClipboardPaste,
  Database,
  EyeOff,
  FileCode2,
  Folder,
  FolderOpen,
  FolderSymlink,
  GitBranch,
  Trash2,
} from 'lucide-react';
import {
  forwardRef,
  type ReactNode,
  type Ref,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';

export interface FileTreeItem {
  /** The full relative path (e.g. ".claude/config.json") */
  path: string;
  /** Optional extra content rendered after the file name (e.g. status badge) */
  suffix?: ReactNode;
  /** Optional status string used to compute aggregate folder status */
  status?: string;
  /** Whether this entry is a symlink */
  fileType?: 'file' | 'symlink';
  /** File size in bytes (used to compute aggregate folder sizes) */
  storeSize?: number;
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  file: FileTreeItem | null;
}

/** Collect all file statuses under a tree node recursively */
function collectStatuses(node: TreeNode): string[] {
  if (node.file) {
    return node.file.status ? [node.file.status] : [];
  }
  const statuses: string[] = [];
  for (const child of node.children.values()) {
    statuses.push(...collectStatuses(child));
  }
  return statuses;
}

/** Sum storeSize of all descendant files under a tree node */
function collectSize(node: TreeNode): number {
  if (node.file) {
    return node.file.storeSize ?? 0;
  }
  let total = 0;
  for (const child of node.children.values()) {
    total += collectSize(child);
  }
  return total;
}

/**
 * Compute an aggregate status for a folder:
 * - 'conflict' if any descendant is 'conflict'
 * - 'synced' if all descendants are 'synced'
 * - null otherwise (mixed pending states, etc.)
 */
function aggregateStatus(node: TreeNode): string | null {
  const statuses = collectStatuses(node);
  if (statuses.length === 0) return null;
  if (
    statuses.some((s) => s === 'conflict' || s === 'missing_in_store' || s === 'missing_in_target')
  )
    return 'conflict';
  if (statuses.every((s) => s === 'synced')) return 'synced';
  return null;
}

function buildTree(items: FileTreeItem[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: new Map(), file: null };

  for (const item of items) {
    const parts = item.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;

      if (isFile) {
        // Leaf node = file
        const node: TreeNode = {
          name: part,
          fullPath: item.path,
          children: new Map(),
          file: item,
        };
        current.children.set(`file:${part}`, node);
      } else {
        // Intermediate node = folder
        if (!current.children.has(`dir:${part}`)) {
          current.children.set(`dir:${part}`, {
            name: part,
            fullPath: parts.slice(0, i + 1).join('/'),
            children: new Map(),
            file: null,
          });
        }
        current = current.children.get(`dir:${part}`)!;
      }
    }
  }

  return root;
}

function sortedEntries(node: TreeNode): TreeNode[] {
  const entries = Array.from(node.children.values());
  // Folders first, then files, alphabetical within each group
  return entries.sort((a, b) => {
    const aIsDir = a.file === null;
    const bIsDir = b.file === null;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export interface FileTreeHandle {
  expandAll: () => void;
  collapseAll: () => void;
  isAllCollapsed: boolean;
}

interface FileTreeProps {
  items: FileTreeItem[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
  /** Render a suffix for a folder given its aggregate status (e.g. 'synced', 'conflict') */
  folderSuffix?: (status: string) => ReactNode;
  /** Called whenever the collapsed state changes */
  onCollapsedChange?: (allCollapsed: boolean) => void;
  /** Called when the clone button is clicked on a file/folder node */
  onClone?: (path: string, isFolder: boolean) => void;
  /** Called when user wants to add a path to ignore patterns */
  onIgnore?: (pattern: string) => void;
  /** Called when user wants to quick-resolve a conflict file from context menu */
  onResolve?: (path: string, resolution: 'keep_store' | 'keep_target') => void;
  /** Called when user wants to delete a file from store and target */
  onDelete?: (path: string) => void;
  /** Size thresholds for coloring file/folder sizes */
  sizeThresholds?: SizeThresholds;
  /** Whether to expand all folders on initial render (default: true) */
  initialExpanded?: boolean;
}

function getAllDirs(items: FileTreeItem[]): Set<string> {
  const dirs = new Set<string>();
  for (const item of items) {
    const parts = item.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/'));
    }
  }
  return dirs;
}

function TruncatedName({ name, fullPath }: { name: string; fullPath: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      const el = textRef.current;
      if (el && el.scrollWidth > el.clientWidth) {
        setOpen(true);
        return;
      }
    }
    setOpen(false);
  }, []);

  return (
    <Tooltip open={open} onOpenChange={handleOpenChange}>
      <TooltipTrigger asChild>
        <span ref={textRef} className="truncate font-mono text-xs">
          {name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        <span className="font-mono text-xs">{fullPath}</span>
      </TooltipContent>
    </Tooltip>
  );
}

export const FileTree = forwardRef(function FileTree(
  {
    items,
    selectedPath,
    onSelect,
    folderSuffix,
    onCollapsedChange,
    onClone,
    onIgnore,
    onResolve,
    onDelete,
    sizeThresholds,
    initialExpanded = true,
  }: FileTreeProps,
  ref: Ref<FileTreeHandle>,
) {
  // Track expanded folders; expand or collapse based on initialExpanded prop
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    initialExpanded ? getAllDirs(items) : new Set(),
  );

  const allDirs = getAllDirs(items);
  const isAllCollapsed = allDirs.size > 0 && expanded.size === 0;

  const updateExpanded = useCallback(
    (next: Set<string>) => {
      setExpanded(next);
      const allCollapsed = getAllDirs(items).size > 0 && next.size === 0;
      onCollapsedChange?.(allCollapsed);
    },
    [items, onCollapsedChange],
  );

  useImperativeHandle(
    ref,
    () => ({
      expandAll: () => updateExpanded(getAllDirs(items)),
      collapseAll: () => updateExpanded(new Set()),
      isAllCollapsed,
    }),
    [items, isAllCollapsed, updateExpanded],
  );

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        onCollapsedChange?.(getAllDirs(items).size > 0 && next.size === 0);
        return next;
      });
    },
    [items, onCollapsedChange],
  );

  const tree = buildTree(items);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-0.5">
        {sortedEntries(tree).map((node) => (
          <TreeNodeView
            key={node.fullPath}
            node={node}
            depth={0}
            expanded={expanded}
            selectedPath={selectedPath}
            onToggle={toggleFolder}
            onSelect={onSelect}
            folderSuffix={folderSuffix}
            onClone={onClone}
            onIgnore={onIgnore}
            onResolve={onResolve}
            onDelete={onDelete}
            sizeThresholds={sizeThresholds}
          />
        ))}
      </div>
    </TooltipProvider>
  );
});

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  expanded: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  folderSuffix?: (status: string) => ReactNode;
  onClone?: (path: string, isFolder: boolean) => void;
  onIgnore?: (pattern: string) => void;
  onResolve?: (path: string, resolution: 'keep_store' | 'keep_target') => void;
  onDelete?: (path: string) => void;
  sizeThresholds?: SizeThresholds;
}

function TreeNodeView({
  node,
  depth,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
  folderSuffix,
  onClone,
  onIgnore,
  onResolve,
  onDelete,
  sizeThresholds,
}: TreeNodeViewProps) {
  const isDir = node.file === null;
  const isExpanded = expanded.has(node.fullPath);
  const isSelected = !isDir && selectedPath === node.fullPath;
  const indent = depth * 16;

  if (isDir) {
    // Position the vertical guide line aligned with the chevron center
    const guideLeft = indent + 8 + 6; // paddingLeft + half of chevron width (12/2)
    const dirStatus = folderSuffix ? aggregateStatus(node) : null;
    const dirSize = collectSize(node);

    const folderContent = (
      <div style={{ paddingLeft: `${indent}px` }} className="group/node">
        <button
          onClick={() => onToggle(node.fullPath)}
          className="w-full min-w-0 flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-left hover:bg-accent transition-colors"
        >
          <ChevronRight
            className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
          />
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <TruncatedName name={node.name} fullPath={node.fullPath} />
          {onClone && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClone(node.fullPath, true);
                  }}
                  className="shrink-0 ml-auto opacity-0 group-hover/node:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
                >
                  <ClipboardPaste className="h-4 w-4 text-muted-foreground/70 hover:text-foreground" />
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">Clone to other repos</TooltipContent>
            </Tooltip>
          )}
          {(dirSize > 0 || dirStatus) && (
            <span className={`shrink-0 flex items-center gap-1.5 ${onClone ? '' : 'ml-auto'}`}>
              {dirSize > 0 && (
                <SizeLabel bytes={dirSize} sizeThresholds={sizeThresholds} className="shrink-0" />
              )}
              {dirStatus && <span className="shrink-0">{folderSuffix?.(dirStatus)}</span>}
            </span>
          )}
        </button>
      </div>
    );

    return (
      <>
        {onIgnore || onDelete ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{folderContent}</ContextMenuTrigger>
            <ContextMenuContent>
              {onIgnore && (
                <ContextMenuItem onClick={() => onIgnore(`${node.fullPath}/**`)}>
                  <EyeOff className="h-3.5 w-3.5" />
                  Untrack folder
                </ContextMenuItem>
              )}
              {onDelete && onIgnore && <ContextMenuSeparator />}
              {onDelete && (
                <ContextMenuItem
                  className="text-destructive focus:text-destructive"
                  onClick={() => onDelete(`${node.fullPath}/**`)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete from both sides
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          folderContent
        )}
        {isExpanded && (
          <div className="relative">
            <div
              className="absolute top-0 bottom-0 border-l border-border/60"
              style={{ left: `${guideLeft}px` }}
            />
            {sortedEntries(node).map((child) => (
              <TreeNodeView
                key={child.fullPath}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                selectedPath={selectedPath}
                onToggle={onToggle}
                onSelect={onSelect}
                folderSuffix={folderSuffix}
                onClone={onClone}
                onIgnore={onIgnore}
                onResolve={onResolve}
                onDelete={onDelete}
                sizeThresholds={sizeThresholds}
              />
            ))}
          </div>
        )}
      </>
    );
  }

  // File node — extra 7px (chevron width + gap) to align with folder names
  const fileIndent = indent + 7;

  const fileContent = (
    <div style={{ paddingLeft: `${fileIndent}px` }} className="group/node">
      <button
        onClick={() => onSelect(node.fullPath)}
        className={`w-full min-w-0 flex items-center gap-1.5 rounded-full px-2 py-1 text-sm text-left hover:bg-accent transition-colors ${
          isSelected ? 'bg-accent' : ''
        }`}
      >
        {node.file?.fileType === 'symlink' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <FolderSymlink className="h-3.5 w-3.5 shrink-0" />
            </TooltipTrigger>
            <TooltipContent side="top">Symbolic link</TooltipContent>
          </Tooltip>
        ) : (
          <FileCode2 className="h-3.5 w-3.5 shrink-0" />
        )}
        <TruncatedName name={node.name} fullPath={node.fullPath} />
        {onClone && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="button"
                tabIndex={-1}
                onClick={(e) => {
                  e.stopPropagation();
                  onClone(node.fullPath, false);
                }}
                className="shrink-0 ml-auto opacity-0 group-hover/node:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
              >
                <ClipboardPaste className="h-4 w-4 text-muted-foreground/70 hover:text-foreground" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">Clone to other repos</TooltipContent>
          </Tooltip>
        )}
        {node.file?.suffix && (
          <span className={`shrink-0 ${onClone ? '' : 'ml-auto'}`}>{node.file.suffix}</span>
        )}
      </button>
    </div>
  );

  const isConflict =
    node.file?.status === 'conflict' ||
    node.file?.status === 'missing_in_store' ||
    node.file?.status === 'missing_in_target';
  const hasContextMenu = onIgnore || onDelete || (onResolve && isConflict);

  if (hasContextMenu) {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{fileContent}</ContextMenuTrigger>
        <ContextMenuContent>
          {onResolve && isConflict && (
            <>
              <ContextMenuItem onClick={() => onResolve(node.fullPath, 'keep_store')}>
                <Database className="h-3.5 w-3.5" />
                Keep changes from store
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onResolve(node.fullPath, 'keep_target')}>
                <GitBranch className="h-3.5 w-3.5" />
                Keep changes from target
              </ContextMenuItem>
            </>
          )}
          {onIgnore && (
            <ContextMenuItem onClick={() => onIgnore(node.fullPath)}>
              <EyeOff className="h-3.5 w-3.5" />
              Untrack file
            </ContextMenuItem>
          )}
          {onDelete && onIgnore && <ContextMenuSeparator />}
          {onDelete && (
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(node.fullPath)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete from both sides
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return fileContent;
}
