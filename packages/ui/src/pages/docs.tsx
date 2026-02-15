import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { cn } from '@/lib/utils';
import { BookOpen } from 'lucide-react';

const docModules = import.meta.glob('../../../../docs/*.md', {
  query: '?raw',
  eager: true,
}) as Record<string, { default: string }>;

interface DocEntry {
  slug: string;
  title: string;
  content: string;
}

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function extractTitle(content: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1] : 'Untitled';
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

const docs: DocEntry[] = Object.entries(docModules)
  .map(([path, mod]) => {
    const slug = path.split('/').pop()!.replace(/\.md$/, '');
    const content = mod.default;
    return { slug, title: extractTitle(content), content };
  })
  .sort((a, b) => {
    const order = ['intro', 'how-to', 'changelog'];
    const ai = order.indexOf(a.slug);
    const bi = order.indexOf(b.slug);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.title.localeCompare(b.title);
  });

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

export function DocsPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const getSlugFromHash = useCallback(() => {
    const hash = location.hash.replace('#', '');
    if (hash && docs.some((d) => d.slug === hash)) return hash;
    return docs[0]?.slug ?? '';
  }, [location.hash]);

  const [activeSlug, setActiveSlug] = useState(getSlugFromHash);
  const activeDoc = docs.find((d) => d.slug === activeSlug);
  const contentRef = useRef<HTMLElement>(null);

  const toc = useMemo(() => (activeDoc ? extractToc(activeDoc.content) : []), [activeDoc]);

  // Sync activeSlug when hash changes (e.g. browser back/forward)
  useEffect(() => {
    const slug = getSlugFromHash();
    if (slug !== activeSlug) setActiveSlug(slug);
  }, [location.hash, getSlugFromHash]);

  const handleSelectDoc = useCallback(
    (slug: string) => {
      setActiveSlug(slug);
      navigate(`/docs#${slug}`, { replace: true });
    },
    [navigate],
  );

  // Scroll content to top when switching docs
  useEffect(() => {
    contentRef.current?.scrollTo(0, 0);
  }, [activeSlug]);

  return (
    <div className="flex flex-1 min-h-0 gap-0 overflow-hidden">
      {/* Left sidebar - doc outline */}
      <aside className="w-56 shrink-0 border-r border-border/80 bg-muted/30 overflow-y-auto">
        <div className="p-4 pb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Documentation
          </h3>
        </div>
        <nav className="px-2 pb-4 flex flex-col gap-2">
          {docs.map((doc) => (
            <button
              key={doc.slug}
              onClick={() => handleSelectDoc(doc.slug)}
              className={cn(
                'w-full text-left px-3 py-2 rounded-full text-sm transition-colors',
                activeSlug === doc.slug
                  ? 'bg-white border border-border/80 shadow-sm font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              {doc.title}
            </button>
          ))}
        </nav>
      </aside>

      {/* Center content - markdown render */}
      <main ref={contentRef} className="flex-1 min-w-0 overflow-y-auto">
        {activeDoc ? (
          <article className="max-w-2xl mx-auto px-8 py-8">
            <div className="prose prose-sm prose-neutral max-w-none">
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}
              >
                {activeDoc.content}
              </Markdown>
            </div>
          </article>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-3">
            <BookOpen className="h-12 w-12 opacity-30" />
            <p className="text-sm">No documentation available</p>
          </div>
        )}
      </main>

      {/* Right sidebar - table of contents (hidden on small screens) */}
      {activeDoc && toc.length > 0 && (
        <aside className="hidden lg:block w-52 shrink-0 border-l border-border/80 overflow-y-auto">
          <div className="p-4 pb-2">
            <h3 className="text-xs mt-2 font-semibold uppercase tracking-wider text-muted-foreground">
              On this page
            </h3>
          </div>
          <div className="px-4 pb-4">
            <TableOfContents toc={toc} contentRef={contentRef} />
          </div>
        </aside>
      )}
    </div>
  );
}
