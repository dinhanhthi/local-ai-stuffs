import { useState, useEffect, useCallback, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { cn } from '@/lib/utils';
import docContent from '../../../../docs/documentation.md?raw';

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

function TableOfContents({ toc }: { toc: TocItem[] }) {
  const [activeId, setActiveId] = useState('');

  const handleClick = useCallback((id: string) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  useEffect(() => {
    if (toc.length === 0) return;

    const handleScroll = () => {
      const headings = toc
        .map((item) => document.getElementById(item.id))
        .filter(Boolean) as HTMLElement[];

      let current = '';
      for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        if (rect.top <= 100) {
          current = heading.id;
        }
      }
      setActiveId(current);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener('scroll', handleScroll);
  }, [toc]);

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

export function DocsPage() {
  const toc = useMemo(() => extractToc(docContent), []);

  return (
    <div className="mx-auto max-w-5xl w-full px-4 sm:px-6 lg:px-8">
      {/* Main content */}
      <main className="lg:mr-64 py-8">
        <article className="max-w-5xl mx-auto">
          <div className="prose prose-sm max-w-none">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}
            >
              {docContent}
            </Markdown>
          </div>
        </article>
      </main>

      {/* Right sidebar - TOC (hidden on small screens) */}
      {toc.length > 0 && (
        <aside className="hidden lg:block fixed top-[65px] right-[max(1rem,calc((100vw-64rem)/2))] w-56">
          <div className="py-8 pl-8">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
              On this page
            </h3>
            <div className="max-h-[calc(100vh-65px-53px-68px)] overflow-y-auto">
              <TableOfContents toc={toc} />
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
