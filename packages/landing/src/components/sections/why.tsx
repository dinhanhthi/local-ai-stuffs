export function WhySection() {
  const cards = [
    {
      title: 'One Central Store',
      description:
        'All AI config files live in a single git repo you control. No more scattered files across dozens of projects.',
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
      title: 'Auto Sync & Merge',
      description:
        'Edit in your repo or the dashboard — changes sync both ways. A git-based 3-way merge handles conflicts automatically.',
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
      title: 'Private & Portable',
      description:
        'Configs stay out of public repos. Clone the store on a new machine and everything reconnects automatically.',
      color: 'text-amber-400',
      bg: 'bg-amber-400/10',
      icon: (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
        />
      ),
    },
  ];

  return (
    <section id="why" className="py-20 animate-fade-up delay-200">
      <h2 className="text-3xl font-bold tracking-tight text-center mb-12">Why AI Sync?</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {cards.map((card) => (
          <div
            key={card.title}
            className="rounded-lg border border-border bg-card p-6 transition-colors hover:border-muted-foreground/50"
          >
            <div className={`mb-3 flex h-10 w-10 items-center justify-center rounded-md ${card.bg}`}>
              <svg
                className={`h-5 w-5 ${card.color}`}
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
              >
                {card.icon}
              </svg>
            </div>
            <h3 className="text-base font-semibold mb-2">{card.title}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{card.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
