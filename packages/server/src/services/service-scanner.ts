import path from 'node:path';
import { glob } from 'glob';
import { isSymlink, parentPathHasSymlink } from './repo-scanner.js';
import type { ScannedEntry } from './repo-scanner.js';

/**
 * Scan a service directory for files matching the given patterns.
 * Optionally accepts ignore patterns to exclude files from the results.
 *
 * Symlinks are handled the same way as in repo scanning:
 * - Regular files whose parent path traverses a symlink are excluded
 * - Root segments that are themselves symlinks are tracked as symlink entries
 */
export async function scanServiceFiles(
  servicePath: string,
  patterns: string[],
  ignorePatterns: string[] = [],
): Promise<ScannedEntry[]> {
  const found: ScannedEntry[] = [];
  const seenPaths = new Set<string>();

  const ignore = ['.DS_Store', '**/.DS_Store', ...ignorePatterns];

  // Collect root segments from patterns to check for symlinks
  const rootSegmentsToCheck = new Set<string>();

  for (const pattern of patterns) {
    const firstSlash = pattern.indexOf('/');
    const rootSegment = firstSlash === -1 ? pattern : pattern.substring(0, firstSlash);
    if (!rootSegment.includes('*') && !rootSegment.includes('?')) {
      rootSegmentsToCheck.add(rootSegment);
    }

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

  // Check root segments for symlinks (e.g. "skills" itself might be a symlink)
  for (const segment of rootSegmentsToCheck) {
    const fullPath = path.join(servicePath, segment);
    if (await isSymlink(fullPath)) {
      if (!seenPaths.has(segment)) {
        seenPaths.add(segment);
        filtered.push({ path: segment, isSymlink: true });
      }
    }
  }

  return filtered.sort((a, b) => a.path.localeCompare(b.path));
}
