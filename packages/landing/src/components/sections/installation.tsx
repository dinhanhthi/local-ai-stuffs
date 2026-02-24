import { useState, useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';

hljs.registerLanguage('bash', bash);

function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  // Safe: input is hardcoded string literals, not user content
  const highlighted = useMemo(
    () => hljs.highlight(children, { language: 'bash' }).value,
    [children],
  );

  const handleCopy = () => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="relative rounded-lg border border-border/50 overflow-x-auto">
      <button
        onClick={handleCopy}
        className="absolute top-3 right-3 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
      <pre
        className="text-sm font-mono text-foreground/90 leading-relaxed hljs p-4 !bg-muted/50"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </div>
  );
}

export function InstallationSection() {
  return (
    <section id="install" className="py-12 sm:py-16 md:py-20 scroll-mt-10">
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
