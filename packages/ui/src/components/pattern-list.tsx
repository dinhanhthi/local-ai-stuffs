import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { CircleCheck } from '@/components/ui/circle-check';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Search, X } from 'lucide-react';

export interface PatternItem {
  pattern: string;
  enabled: boolean;
  source?: 'global' | 'local' | 'default' | 'custom' | 'user';
}

interface PatternListProps {
  patterns: PatternItem[];
  onToggle: (index: number) => void;
  onRemove: (index: number) => void;
  newPattern: string;
  onNewPatternChange: (value: string) => void;
  onAdd: () => void;
  placeholder: string;
}

export function PatternList({
  patterns,
  onToggle,
  onRemove,
  newPattern,
  onNewPatternChange,
  onAdd,
  placeholder,
}: PatternListProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const query = searchQuery.toLowerCase();
  const filtered = patterns
    .map((p, i) => ({ ...p, originalIndex: i }))
    .filter((p) => !query || p.pattern.toLowerCase().includes(query));

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-3">
      <div className="flex gap-2 items-center shrink-0">
        <Input
          placeholder={placeholder}
          value={newPattern}
          onChange={(e) => onNewPatternChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          className="text-xs font-mono h-8"
        />
        <Button size="icon-sm" variant="outline" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-sm"
                variant={searchOpen ? 'default' : 'outline'}
                onClick={() => {
                  setSearchOpen((v) => !v);
                  if (searchOpen) setSearchQuery('');
                }}
              >
                <Search className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Search patterns</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      {searchOpen && (
        <div className="flex gap-2 items-center shrink-0">
          <Input
            ref={searchInputRef}
            placeholder="Filter patterns…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setSearchOpen(false);
                setSearchQuery('');
              }
            }}
            className="text-xs font-mono h-7"
          />
          {searchQuery && (
            <button
              className="text-muted-foreground hover:text-foreground h-5 w-5 inline-flex items-center justify-center rounded-sm shrink-0"
              onClick={() => setSearchQuery('')}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
      <div className="space-y-1.5 flex-1 min-h-0 overflow-y-auto bg-accent/20 border-border border rounded-md p-2">
        {filtered.map((p, fi) => {
          const canRemove =
            !p.source || p.source === 'local' || p.source === 'custom' || p.source === 'user';
          const prevSource = fi > 0 ? filtered[fi - 1].source : undefined;
          const showSeparator =
            !query &&
            ((p.source === 'global' && prevSource === 'local') ||
              (p.source === 'default' && prevSource === 'custom') ||
              (p.source === 'default' && prevSource === 'user'));
          return (
            <div key={`${p.pattern}-${p.originalIndex}`}>
              {showSeparator && <div className="border-t border-border my-1.5" />}
              <div className="flex items-center gap-2 group">
                <CircleCheck
                  checked={p.enabled}
                  onCheckedChange={() => onToggle(p.originalIndex)}
                />
                {p.source && <SourceBadge source={p.source} />}
                <span className="flex-1 font-mono text-xs">{p.pattern}</span>
                {canRemove && (
                  <TooltipProvider delayDuration={300}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground h-5 w-5 inline-flex items-center justify-center rounded-sm"
                          onClick={() => onRemove(p.originalIndex)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>Remove</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
            </div>
          );
        })}
        {query && filtered.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-2">No matching patterns</p>
        )}
      </div>
    </div>
  );
}

export function SourceBadge({
  source,
}: {
  source: 'global' | 'local' | 'default' | 'custom' | 'user';
}) {
  const isSecondary = source === 'global' || source === 'default';
  return (
    <Badge
      variant={isSecondary ? 'secondary' : 'default'}
      className="text-[10px] px-1.5 py-0 h-4 leading-none"
    >
      {source}
    </Badge>
  );
}
