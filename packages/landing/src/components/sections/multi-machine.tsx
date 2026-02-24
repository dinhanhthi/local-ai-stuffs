export function MultiMachineSection() {
  return (
    <section className="py-20">
      <h2 className="text-3xl font-bold tracking-tight text-center mb-4">Work Across Machines</h2>
      <p className="text-center text-muted-foreground mb-12 max-w-2xl mx-auto">
        Your store is just a Git repo. Push it to GitHub (private) and pull it on another machine.
        All machines are tracked in the settings store.
      </p>

      {/* Desktop diagram (horizontal) */}
      <div className="hidden md:flex rounded-lg border border-border bg-card p-6 sm:p-10 flex-col items-center">
        <svg
          width="700"
          height="220"
          viewBox="0 0 700 220"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="w-full max-w-2xl h-auto"
        >
          {/* Cloud */}
          <ellipse
            cx="350"
            cy="45"
            rx="55"
            ry="28"
            fill="hsl(240 10% 6%)"
            stroke="hsl(240 5% 26%)"
            strokeWidth="1.5"
          />
          <text
            x="350"
            y="49"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            fontWeight="600"
            textAnchor="middle"
          >
            Cloud Git
          </text>
          {/* Machine A */}
          <rect
            x="80"
            y="140"
            width="120"
            height="60"
            rx="8"
            fill="hsl(240 10% 6%)"
            stroke="hsl(240 5% 26%)"
            strokeWidth="1.5"
          />
          <text
            x="140"
            y="168"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            fontWeight="600"
            textAnchor="middle"
          >
            Machine A
          </text>
          <text
            x="140"
            y="188"
            fill="hsl(240 5% 55%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
          >
            (Mac)
          </text>
          {/* Machine B */}
          <rect
            x="500"
            y="140"
            width="120"
            height="60"
            rx="8"
            fill="hsl(240 10% 6%)"
            stroke="hsl(240 5% 26%)"
            strokeWidth="1.5"
          />
          <text
            x="560"
            y="168"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="16"
            fontWeight="600"
            textAnchor="middle"
          >
            Machine B
          </text>
          <text
            x="560"
            y="188"
            fill="hsl(240 5% 55%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
          >
            (Linux)
          </text>
          {/* Connectors */}
          <line
            x1="140"
            y1="140"
            x2="305"
            y2="60"
            stroke="hsl(240 5% 35%)"
            strokeWidth="1.5"
            strokeDasharray="5"
          />
          <line
            x1="560"
            y1="140"
            x2="395"
            y2="60"
            stroke="hsl(240 5% 35%)"
            strokeWidth="1.5"
            strokeDasharray="5"
          />
          <text
            x="222"
            y="88"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
            transform="rotate(-26, 222, 88)"
          >
            git push/pull
          </text>
          <text
            x="478"
            y="88"
            fill="hsl(0 0% 98%)"
            fontFamily="Inter, sans-serif"
            fontSize="14"
            textAnchor="middle"
            transform="rotate(26, 478, 88)"
          >
            git push/pull
          </text>
        </svg>
      </div>

      {/* Mobile diagram (vertical) */}
      <div className="md:hidden rounded-lg border border-border bg-card p-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-full rounded-lg border border-border bg-muted/50 px-5 py-3.5 text-center">
            <span className="text-sm font-semibold">Machine A</span>
            <span className="block text-xs text-muted-foreground mt-0.5">(Mac)</span>
          </div>
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
            <span className="text-xs">git push/pull</span>
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
                d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
              />
            </svg>
          </div>
          <div className="w-full rounded-lg border border-border bg-muted/50 px-5 py-4 text-center">
            <span className="text-sm font-semibold">Cloud Git</span>
          </div>
          <div className="flex flex-col items-center gap-1 text-muted-foreground">
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
                d="M12 4.5v15m0 0 6.75-6.75M12 19.5l-6.75-6.75"
              />
            </svg>
            <span className="text-xs">git push/pull</span>
          </div>
          <div className="w-full rounded-lg border border-border bg-muted/50 px-5 py-3.5 text-center">
            <span className="text-sm font-semibold">Machine B</span>
            <span className="block text-xs text-muted-foreground mt-0.5">(Linux)</span>
          </div>
        </div>
      </div>
    </section>
  );
}
