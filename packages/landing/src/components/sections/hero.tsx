export function HeroSection() {
  return (
    <section className="py-12 sm:py-16 md:py-20 text-center animate-fade-up delay-100">
      <img src="/logo.svg" alt="AI Sync logo" className="mx-auto mb-6 h-20 w-20" />
      <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-tight mb-6">
        Sync Your AI Configs
        <br />
        <span className="bg-gradient-to-r from-indigo-400 to-emerald-400 bg-clip-text text-transparent">
          Across All Your Machines
        </span>
      </h1>
      <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-10 leading-relaxed">
        A central store for{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono text-emerald-400">
          CLAUDE.md
        </code>
        ,{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono text-emerald-400">
          .claude
        </code>
        ,{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono text-emerald-400">
          .cursorrules
        </code>
        ,{' '}
        <code className="rounded bg-muted px-1.5 py-0.5 text-sm font-mono text-emerald-400">
          GEMINI.md
        </code>{' '}
        and more. Bidirectional sync keeps every repo and machine in lockstep &mdash; private,
        automatic, conflict-free.
      </p>
      <div className="flex items-center justify-center gap-3">
        <a
          href="#install"
          className="inline-flex items-center rounded-full bg-primary text-primary-foreground px-6 py-2.5 text-sm font-medium hover:bg-primary/90 transition-colors cursor-pointer"
        >
          Get Started
        </a>
        <a
          href="#how"
          className="inline-flex items-center rounded-full border border-border bg-background px-6 py-2.5 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
        >
          Learn More
        </a>
      </div>
    </section>
  );
}
