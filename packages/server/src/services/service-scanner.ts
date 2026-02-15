import path from 'node:path';
import { glob } from 'glob';
import { isSymlink, parentPathHasSymlink } from './repo-scanner.js';
import type { ScannedEntry } from './repo-scanner.js';

/**
 * Scan a service directory for files matching the given patterns.
 * Optionally accepts ignore patterns to exclude files from the results.
 */
export async function scanServiceFiles(
  servicePath: string,
  patterns: string[],
  ignorePatterns: string[] = [],
): Promise<ScannedEntry[]> {
  const found: ScannedEntry[] = [];
  const seenPaths = new Set<string>();

  const ignore = ['.DS_Store', '**/.DS_Store', ...ignorePatterns];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: servicePath,
      nodir: true,
      dot: true,
      follow: false,
      ignore,
    });

    for (const match of matches) {
      if (!seenPaths.has(match)) {
        seenPaths.add(match);
        const matchIsSymlink = await isSymlink(path.join(servicePath, match));
        found.push({ path: match, isSymlink: matchIsSymlink });
      }
    }
  }

  // Filter out files whose parent path traverses a symlink
  const filtered: ScannedEntry[] = [];
  for (const entry of found) {
    if (!(await parentPathHasSymlink(servicePath, entry.path))) {
      filtered.push(entry);
    }
  }

  return filtered.sort((a, b) => a.path.localeCompare(b.path));
}
