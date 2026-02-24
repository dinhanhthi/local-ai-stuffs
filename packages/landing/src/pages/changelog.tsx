import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { cn } from '@/lib/utils';
import changelogContent from '../../../../docs/changelog.md?raw';

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function extractToc(content: string): TocItem[] {
  const headingRegex = /^(#{2,4})\s+(.+)$/gm;
  const items: TocItem[] = [];
  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    const text = match[2].replace(/\*\*/g, '').replace(/`/g, '');
    const id = text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
    items.push({ id, text, level: match[1].length });
  }
  return items;
}

function TableOfContents({
  toc,
  contentRef,
}: {
  toc: TocItem[];
  contentRef: React.RefObject<HTMLElement | null>;
}) {
  const [activeId, setActiveId] = useState('');

  const handleClick = useCallback(
    (id: string) => {
      const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    [contentRef],
  );

  useEffect(() => {
    const container = contentRef.current;
    if (!container || toc.length === 0) return;

    const handleScroll = () => {
      const headings = toc
        .map((item) => container.querySelector(`#${CSS.escape(item.id)}`))
        .filter(Boolean) as HTMLElement[];

      let current = '';
      for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        if (rect.top - containerRect.top <= 80) {
          current = heading.id;
        }
      }
      setActiveId(current);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [toc, contentRef]);

  if (toc.length === 0) return null;

  return (
    <nav className="flex flex-col gap-0.5">
      {toc.map((item) => (
        <button
          key={item.id}
          onClick={() => handleClick(item.id)}
          className={cn(
            'text-left text-xs leading-relaxed py-0.5 transition-colors truncate',
            item.level === 2 && 'pl-0',
            item.level === 3 && 'pl-3',
            item.level === 4 && 'pl-6',
            activeId === item.id
              ? 'text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {item.text}
        </button>
      ))}
    </nav>
  );
}

export function ChangelogPage() {
  const contentRef = useRef<HTMLElement>(null);
  const toc = useMemo(() => extractToc(changelogContent), []);

  return (
    <div className="flex flex-1 min-h-0 mx-auto max-w-6xl w-full px-4 sm:px-6 lg:px-8">
      {/* Main content */}
      <main ref={contentRef} className="flex-1 min-w-0 overflow-y-auto py-8">
        <article className="max-w-3xl mx-auto">
          <div className="prose prose-sm max-w-none">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}
            >
              {changelogContent}
            </Markdown>
          </div>
        </article>
      </main>

      {/* Right sidebar - TOC */}
      {toc.length > 0 && (
        <aside className="hidden lg:block w-56 shrink-0 overflow-y-auto py-8 pl-8">
          <div className="sticky top-8">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              Versions
            </h3>
            <TableOfContents toc={toc} contentRef={contentRef} />
          </div>
        </aside>
      )}
    </div>
  );
}
