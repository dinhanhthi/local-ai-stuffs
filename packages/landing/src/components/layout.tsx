import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/docs', label: 'Docs' },
  { to: '/changelog', label: 'Changelog' },
  { href: '/#install', label: 'Install', homeAnchor: '#install' },
];

function NavLink({
  item,
  isHome,
  onClick,
}: {
  item: (typeof navItems)[number];
  isHome: boolean;
  onClick?: () => void;
}) {
  const location = useLocation();
  const className = 'text-sm text-muted-foreground hover:text-foreground transition-colors';

  if (item.to) {
    const active = location.pathname === item.to;
    return (
      <Link to={item.to} onClick={onClick} className={cn(className, active && 'text-foreground')}>
        {item.label}
      </Link>
    );
  }

  if (isHome) {
    return (
      <a href={item.homeAnchor} onClick={onClick} className={className}>
        {item.label}
      </a>
    );
  }

  return (
    <Link to={item.href!} onClick={onClick} className={className}>
      {item.label}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isHome = location.pathname === '/';

  // Scroll to hash target or top on route change
  useEffect(() => {
    if (location.hash) {
      const el = document.querySelector(location.hash);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
        return;
      }
    }
    window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  return (
    <div className="flex flex-col min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border/50 animate-fade-up">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 flex items-center justify-between py-4">
          <Link
            to="/"
            className="flex items-center gap-2 text-xl font-bold tracking-tight whitespace-nowrap"
          >
            <img src="/logo.svg" alt="AI Sync logo" className="h-7 w-7" />
            AI Sync
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs h-fit font-medium text-muted-foreground">
              v{__APP_VERSION__}
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {/* Desktop nav */}
            <nav className="hidden md:flex items-center gap-6">
              {navItems.map((item) => (
                <NavLink key={item.label} item={item} isHome={isHome} />
              ))}
            </nav>
            {/* GitHub icon */}
            <a
              href="https://github.com/dinhanhthi/ai-sync"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center h-9 w-9 text-muted-foreground hover:text-foreground transition-colors"
              title="GitHub"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
            {/* Mobile burger */}
            <button
              onClick={() => setMenuOpen(!menuOpen)}
              className="md:hidden inline-flex items-center justify-center rounded-full border border-border h-9 w-9 text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
              aria-label="Toggle menu"
            >
              {menuOpen ? (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth="1.5"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
                  />
                </svg>
              )}
            </button>
          </div>
        </div>
        {/* Mobile menu */}
        {menuOpen && (
          <nav className="md:hidden border-t border-border/50 bg-background/80 backdrop-blur-md">
            <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 flex flex-col gap-3 pb-4 pt-3">
              {navItems.map((item) => (
                <div key={item.label} className="px-1 py-1.5">
                  <NavLink item={item} isHome={isHome} onClick={() => setMenuOpen(false)} />
                </div>
              ))}
            </div>
          </nav>
        )}
      </header>

      {/* Spacer for fixed header */}
      <div className="h-[65px]" />

      {/* Main content */}
      <div className="flex-1 pb-[53px]">{children}</div>

      {/* Footer */}
      <footer className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/50 bg-background/80 backdrop-blur-md py-3">
        <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
          <p className="text-center text-sm text-muted-foreground">
            &copy; {new Date().getFullYear()} AI Sync. Built for developers by{' '}
            <a
              href="https://dinhanhthi.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:text-primary transition-colors"
            >
              Anh-Thi Dinh
            </a>
            .
          </p>
        </div>
      </footer>
    </div>
  );
}
