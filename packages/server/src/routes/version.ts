import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../../package.json'), 'utf-8'),
);
const CURRENT_VERSION: string = rootPkg.version;

const GITHUB_REPO = 'dinhanhthi/ai-sync';
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

interface CachedRelease {
  latest: string;
  releaseUrl: string;
  checkedAt: number;
}

let cachedRelease: CachedRelease | null = null;

function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.replace(/^v/, '').split('.').map(Number);
  const c = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function fetchLatestRelease(): Promise<CachedRelease | null> {
  if (cachedRelease && Date.now() - cachedRelease.checkedAt < CACHE_TTL) {
    return cachedRelease;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': 'ai-sync' },
    });
    if (!res.ok) return cachedRelease;

    const data = (await res.json()) as { tag_name: string; html_url: string };
    cachedRelease = {
      latest: data.tag_name.replace(/^v/, ''),
      releaseUrl: data.html_url,
      checkedAt: Date.now(),
    };
    return cachedRelease;
  } catch {
    return cachedRelease;
  }
}

export function registerVersionRoutes(app: FastifyInstance): void {
  app.get('/api/version', async () => {
    const release = await fetchLatestRelease();
    const latest = release?.latest ?? null;
    return {
      current: CURRENT_VERSION,
      latest,
      updateAvailable: latest ? isNewerVersion(latest, CURRENT_VERSION) : false,
      releaseUrl: release?.releaseUrl ?? null,
    };
  });
}
