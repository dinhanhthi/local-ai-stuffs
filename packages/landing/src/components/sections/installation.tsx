import { useState } from 'react';

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative rounded-lg border border-border bg-muted/50 p-4 overflow-x-auto">
      <button
        onClick={handleCopy}
        className="absolute top-3 right-3 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre className="text-sm font-mono text-foreground/90 leading-relaxed">{children}</pre>
    </div>
  );
}

export function InstallationSection() {
  return (
    <section id="install" className="py-20 scroll-mt-10">
      <h2 className="text-3xl font-bold tracking-tight text-center mb-12">
        Installation &amp; Usage
      </h2>

      <div className="mx-auto max-w-2xl space-y-8">
        <div>
          <h3 className="text-lg font-semibold mb-3">1. Install</h3>
          <CodeBlock>
            {`git clone https://github.com/dinhanhthi/ai-sync
cd ai-sync
pnpm install
pnpm build`}
          </CodeBlock>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-3">2. Run</h3>
          <CodeBlock>
            {`# Start the app
pnpm start

# Open http://localhost:2703`}
          </CodeBlock>
        </div>

        <div>
          <h3 className="text-lg font-semibold mb-3">3. Update</h3>
          <CodeBlock>
            {`git pull
pnpm install
pnpm build
pnpm start`}
          </CodeBlock>
        </div>
      </div>
    </section>
  );
}
