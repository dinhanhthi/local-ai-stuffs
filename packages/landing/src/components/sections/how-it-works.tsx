export function HowItWorksSection() {
  return (
    <section id="how" className="py-12 sm:py-16 md:py-20">
      <h2 className="text-3xl font-bold tracking-tight text-center mb-4">How It Works</h2>
      <p className="text-center text-muted-foreground mb-12">
        A background service watches your files and syncs them to a central git store.
      </p>

      {/* Desktop diagram (horizontal) */}
      <div className="hidden md:flex rounded-lg border border-border bg-card p-6 sm:p-10 flex-col items-center mb-8">
        <svg
          width="700"
          height="260"
          viewBox="0 0 700 260"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full max-w-2xl h-auto"
        >
          {/* Connections (rendered first so they appear behind boxes) */}
          <path
            d="M100 190 C 100 130, 250 80, 260 75"
            stroke="hsl(240 5% 35%)"
            strokeWidth="1.5"
            fill="none"
            className="flow-line"
          />
          <path
            d="M600 190 C 600 130, 450 80, 440 75"
            stroke="hsl(240 5% 35%)"
            strokeWidth="1.5"
            fill="none"
            className="flow-line"
          />
          {/* Central Store */}
          <rect
            x="250"
            y="30"
            width="200"
            height="80"
            rx="8"
            fill="hsl(240 10% 6%)"
            stroke="hsl(240 5% 26%)"
            strokeWidth="1.5"
          />
          <text
            x="350"
            y="62"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            fontWeight="600"
            textAnchor="middle"
          >
            Central Store
          </text>
          <text
            x="350"
            y="82"
            fill="hsl(240 5% 55%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
          >
            (Data Git Repo)
          </text>
          {/* Sync Engine */}
          <circle
            cx="350"
            cy="155"
            r="32"
            fill="hsl(240 10% 6%)"
            stroke="hsl(240 5% 26%)"
            strokeWidth="1.5"
          />
          <text
            x="350"
            y="150"
            fill="hsl(240 5% 65%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
          >
            Sync
          </text>
          <text
            x="350"
            y="168"
            fill="hsl(240 5% 65%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
          >
            Engine
          </text>
          {/* Target Repo A */}
          <rect
            x="30"
            y="190"
            width="140"
            height="50"
            rx="8"
            fill="hsl(240 10% 6%)"
            stroke="hsl(152 69% 31%)"
            strokeWidth="1.5"
          />
          <text
            x="100"
            y="220"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            textAnchor="middle"
          >
            Target Repo A
          </text>
          {/* Target Repo B */}
          <rect
            x="530"
            y="190"
            width="140"
            height="50"
            rx="8"
            fill="hsl(240 10% 6%)"
            stroke="hsl(152 69% 31%)"
            strokeWidth="1.5"
          />
          <text
            x="600"
            y="220"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            textAnchor="middle"
          >
            Target Repo B
          </text>
        </svg>
        <p className="text-sm text-muted-foreground mt-4">
          Files are synced bidirectionally. Changes in Repo A ⇄ Store ⇄ Repo B.
        </p>
      </div>

      {/* Mobile diagram (vertical) */}
      <div className="md:hidden rounded-lg border border-border bg-card p-6 mb-8">
        <div className="flex flex-col items-center gap-3">
          <div className="w-full rounded-lg border border-emerald-700 bg-muted/50 px-5 py-3.5 text-center">
            <span className="text-sm font-semibold">Target Repo A</span>
          </div>
          <div className="flex flex-col items-center text-muted-foreground">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
              />
            </svg>
          </div>
          <div className="w-full rounded-lg border border-border bg-muted/50 px-5 py-4 text-center">
            <span className="text-sm font-semibold">Central Store</span>
            <span className="block text-xs text-muted-foreground mt-0.5">(Local Git Repo)</span>
          </div>
          <div className="flex items-center justify-center h-14 w-14 rounded-full border border-border bg-muted/50">
            <span className="text-xs text-muted-foreground text-center leading-tight">
              Sync
              <br />
              Engine
            </span>
          </div>
          <div className="flex flex-col items-center text-muted-foreground">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth="1.5"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
              />
            </svg>
          </div>
          <div className="w-full rounded-lg border border-emerald-700 bg-muted/50 px-5 py-3.5 text-center">
            <span className="text-sm font-semibold">Target Repo B</span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-5 text-center">
          Files are synced bidirectionally. Changes in Repo A ⇄ Store ⇄ Repo B.
        </p>
      </div>

      {/* 3-Way Merge */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Step 1
          </div>
          <h3 className="text-base font-semibold mb-1">Base</h3>
          <p className="text-sm text-muted-foreground mb-3">Last known state</p>
          <div className="rounded-full bg-muted px-3 py-2">
            <code className="text-sm font-mono text-muted-foreground">v1.0</code>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Step 2
          </div>
          <h3 className="text-base font-semibold mb-1">Local Change</h3>
          <p className="text-sm text-muted-foreground mb-3">You edited rules in Repo A</p>
          <div className="rounded-full bg-muted px-3 py-2">
            <code className="text-sm font-mono text-yellow-400">v1.1 (Modified)</code>
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Step 3
          </div>
          <h3 className="text-base font-semibold mb-1">Auto-Merge</h3>
          <p className="text-sm text-muted-foreground mb-3">Syncs to Store w/o conflict</p>
          <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
            <span className="text-sm font-medium text-emerald-400">Synced</span>
          </div>
        </div>
      </div>
    </section>
  );
}
