import { type ReactNode, useEffect, useRef, useState } from 'react';
import { BarChart3, ChevronsDownUp, ChevronsUpDown, AlertTriangle, Search, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toggle } from '@/components/ui/toggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface FileEditorLayoutProps {
  /** Title shown in the file list card header */
  listTitle: string;
  /** Optional actions rendered right of the list title */
  listActions?: ReactNode;
  /** Content rendered above file list items (e.g., new file form) */
  listPrefix?: ReactNode;
  /** The file list area (items, loading, empty states) */
  listContent: ReactNode;
  /** Currently selected file path - controls header styling */
  selectedFile: string | null;
  /**
   * Editor content as render function.
   * Receives toolbar portal target element for FileEditor.
   */
  children: (toolbarEl: HTMLDivElement | null) => ReactNode;
  /** Text shown when no file is selected */
  emptyText?: string;
  /** Callback to collapse all tree folders */
  onCollapseAll?: () => void;
  /** Callback to expand all tree folders */
  onExpandAll?: () => void;
  /** Whether tree is currently all collapsed (controls toggle icon) */
  isAllCollapsed?: boolean;
  /** Whether conflict-only filter is active */
  conflictFilter?: boolean;
  /** Callback to toggle conflict-only filter */
  onConflictFilterChange?: (enabled: boolean) => void;
  /** Whether there are any conflicts (hides button when false) */
  hasConflicts?: boolean;
  /** Whether largest-files filter is active */
  largestFilter?: boolean;
  /** Callback to toggle largest-files filter */
  onLargestFilterChange?: (enabled: boolean) => void;
  /** Current search query for filtering files */
  searchQuery?: string;
  /** Callback when search query changes */
  onSearchChange?: (query: string) => void;
}

export function FileEditorLayout({
  listTitle,
  listActions,
  listPrefix,
  listContent,
  selectedFile,
  children,
  emptyText = 'Select a file to edit',
  onCollapseAll,
  onExpandAll,
  isAllCollapsed,
  conflictFilter,
  onConflictFilterChange,
  largestFilter,
  onLargestFilterChange,
  searchQuery,
  onSearchChange,
}: FileEditorLayoutProps) {
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const showCollapseToggle = onCollapseAll && onExpandAll;

  useEffect(() => {
    if (searchOpen) {
      // Focus after the slide animation starts
      requestAnimationFrame(() => searchInputRef.current?.focus());
    } else {
      onSearchChange?.('');
    }
  }, [searchOpen]);

  return (
    <div className="grid gap-4 md:grid-cols-[2fr_3fr] grid-rows-[1fr] flex-1 min-h-0 overflow-hidden">
      {/* File list */}
      <Card className="overflow-hidden py-0 gap-0 flex flex-col min-w-0">
        <CardHeader
          className={`bg-muted/70 rounded-t-xl px-4 flex flex-row items-center justify-between space-y-0 shrink-0 h-12`}
        >
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            {listTitle}
          </CardTitle>
          <TooltipProvider delayDuration={300}>
            <div className="flex items-center gap-2">
              {onSearchChange && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant={searchOpen ? 'default' : 'outline'}
                      onClick={() => setSearchOpen((v) => !v)}
                    >
                      <Search className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Search files</TooltipContent>
                </Tooltip>
              )}
              {showCollapseToggle && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="outline"
                      onClick={isAllCollapsed ? onExpandAll : onCollapseAll}
                    >
                      {isAllCollapsed ? (
                        <ChevronsUpDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronsDownUp className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {isAllCollapsed ? 'Expand all' : 'Collapse all'}
                  </TooltipContent>
                </Tooltip>
              )}

              {onLargestFilterChange && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Toggle
                        size="icon-sm"
                        variant="outline"
                        pressed={largestFilter}
                        onPressedChange={onLargestFilterChange}
                      >
                        <BarChart3 className="h-3.5 w-3.5" />
                      </Toggle>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {largestFilter ? 'Show all files' : 'Show largest files'}
                  </TooltipContent>
                </Tooltip>
              )}
              {onConflictFilterChange && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Toggle
                        size="icon-sm"
                        variant="outline"
                        pressed={conflictFilter}
                        onPressedChange={onConflictFilterChange}
                      >
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </Toggle>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {conflictFilter ? 'Show all files' : 'Show conflicts only'}
                  </TooltipContent>
                </Tooltip>
              )}
              {listActions}
            </div>
          </TooltipProvider>
        </CardHeader>
        <div
          className={`overflow-hidden transition-all duration-200 ease-in-out shrink-0 ${
            searchOpen ? 'max-h-12' : 'max-h-0'
          }`}
        >
          <div className="px-2 py-1.5 border-b flex items-center gap-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              value={searchQuery ?? ''}
              onChange={(e) => onSearchChange?.(e.target.value)}
              placeholder="Search files..."
              className="h-7 text-xs border-none shadow-none focus-visible:ring-0 px-1"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearchOpen(false);
              }}
            />
            {searchQuery && (
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-5 w-5 shrink-0"
                onClick={() => onSearchChange?.('')}
              >
                <X className="h-3 w-3" />
              </Button>
            )}
          </div>
        </div>
        <CardContent className="px-2 pt-2 overflow-y-auto overflow-x-hidden flex-1 min-h-0">
          {listPrefix}
          {listContent}
        </CardContent>
      </Card>

      {/* Editor */}
      <Card className="flex flex-col overflow-hidden py-0 gap-0 min-w-0">
        <CardHeader
          className={`bg-muted/70 rounded-t-xl px-4 flex flex-row items-center justify-between space-y-0 h-12`}
        >
          <CardTitle
            className={`truncate ${
              selectedFile
                ? 'text-xs font-mono font-normal text-muted-foreground'
                : 'text-sm font-semibold text-muted-foreground uppercase tracking-wide'
            }`}
          >
            {selectedFile ?? 'Editor'}
          </CardTitle>
          {selectedFile && <div ref={setToolbarEl} className="flex gap-2" />}
        </CardHeader>
        <CardContent className="flex-1 min-h-0 px-0 rounded-none">
          {selectedFile ? (
            children(toolbarEl)
          ) : (
            <div className="flex p-4 text-sm text-muted-foreground">{emptyText}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
