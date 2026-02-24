const features = [
  {
    title: 'Centralized Management',
    description: (
      <>
        Keep your <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">CLAUDE.md</code>,{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.claude</code>,{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">GEMINI.md</code> and more
        in one safe place.
      </>
    ),
    color: 'text-indigo-400',
    bg: 'bg-indigo-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
      />
    ),
  },
  {
    title: 'Bidirectional Sync',
    description: 'Edit in your repo OR in the dashboard. Changes propagate everywhere.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 0 0-3.7-3.7 48.678 48.678 0 0 0-7.324 0 4.006 4.006 0 0 0-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 0 0 3.7 3.7 48.656 48.656 0 0 0 7.324 0 4.006 4.006 0 0 0 3.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3-3 3"
      />
    ),
  },
  {
    title: 'Multi-Machine',
    description: 'Works across Mac, Linux, and Windows. Syncs path mappings automatically.',
    color: 'text-cyan-400',
    bg: 'bg-cyan-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0V12a2.25 2.25 0 0 1-2.25 2.25h-13.5A2.25 2.25 0 0 1 3 12V5.25"
      />
    ),
  },
  {
    title: 'Web Dashboard',
    description: 'A beautiful local UI to manage repos, view files, and resolve conflicts.',
    color: 'text-violet-400',
    bg: 'bg-violet-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25a2.25 2.25 0 0 1-2.25-2.25v-2.25Z"
      />
    ),
  },
  {
    title: 'Git Integration',
    description: (
      <>
        Automatically manages{' '}
        <code className="rounded bg-muted px-1 py-0.5 text-xs font-mono">.gitignore</code> in target
        repos so your personal configs stay personal.
      </>
    ),
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
      />
    ),
  },
  {
    title: 'Conflict Resolution',
    description: 'Visual 3-way merge tool for when you edit the same file on two machines.',
    color: 'text-rose-400',
    bg: 'bg-rose-400/10',
    icon: (
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z"
      />
    ),
  },
];

export function FeaturesSection() {
  return (
    <section className="py-20">
      <h2 className="text-3xl font-bold tracking-tight text-center mb-12">Main Features</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="rounded-lg border border-border bg-card p-6 transition-colors hover:border-muted-foreground/50"
          >
            <div
              className={`mb-3 flex h-10 w-10 items-center justify-center rounded-md ${feature.bg}`}
            >
              <svg
                className={`h-5 w-5 ${feature.color}`}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
              >
                {feature.icon}
              </svg>
            </div>
            <h3 className="font-semibold mb-1.5">{feature.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
