import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type Database from 'better-sqlite3';
import {
  expandIgnorePatterns,
  getIgnorePatterns,
  getRepoEnabledFilePatterns,
  getRepoIgnorePatterns,
} from '../db/index.js';

export interface ScannedEntry {
  path: string;
  isSymlink: boolean;
}

/**
 * Check if a path itself (the final segment) is a symlink.
 */
export async function isSymlink(fullPath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(fullPath);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Check if any PARENT segment in a relative path is a symlink within the given base directory.
 * Does NOT check the final segment itself — only intermediate directories.
 */
export async function parentPathHasSymlink(
  basePath: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split('/');
  let current = basePath;
  // Check all segments except the last one (which is the entry itself)
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function scanRepoForAIFiles(
  repoPath: string,
  db: Database.Database,
  repoId?: string,
): Promise<ScannedEntry[]> {
  const enabledPatterns = repoId
    ? getRepoEnabledFilePatterns(db, repoId).map((p) => ({ pattern: p }))
    : (db.prepare('SELECT pattern FROM file_patterns WHERE enabled = 1').all() as {
        pattern: string;
      }[]);
  const patterns = enabledPatterns;

  const rawIgnore = repoId ? getRepoIgnorePatterns(db, repoId) : getIgnorePatterns(db);
  const ignorePatterns = expandIgnorePatterns(rawIgnore);
  const found: ScannedEntry[] = [];
  const seenPaths = new Set<string>();

  // Collect root segments from patterns to check for symlinks.
  // e.g. ".cursor/**" → root segment is ".cursor"
  // e.g. "CLAUDE.md" → root segment is "CLAUDE.md"
  const rootSegmentsToCheck = new Set<string>();

  for (const { pattern } of patterns) {
    const firstSlash = pattern.indexOf('/');
    const rootSegment = firstSlash === -1 ? pattern : pattern.substring(0, firstSlash);
    // Only check non-glob segments
    if (!rootSegment.includes('*') && !rootSegment.includes('?')) {
      rootSegmentsToCheck.add(rootSegment);
    }

    // Glob for regular files (follow: false to not follow symlinks)
    const matches = await glob(pattern, {
      cwd: repoPath,
      nodir: true,
      dot: true,
      follow: false,
      ignore: ignorePatterns,
    });

    for (const match of matches) {
      if (!seenPaths.has(match)) {
        seenPaths.add(match);
        const matchIsSymlink = await isSymlink(path.join(repoPath, match));
        found.push({ path: match, isSymlink: matchIsSymlink });
      }
    }
  }

  // Filter out any regular file paths whose parent traverses through a symlink
  const filtered: ScannedEntry[] = [];
  for (const entry of found) {
    if (!(await parentPathHasSymlink(repoPath, entry.path))) {
      filtered.push(entry);
    }
  }

  // Check root segments for symlinks (e.g. .cursor itself might be a symlink)
  for (const segment of rootSegmentsToCheck) {
    const fullPath = path.join(repoPath, segment);
    if (await isSymlink(fullPath)) {
      // Add the symlink entry itself if not already tracked
      if (!seenPaths.has(segment)) {
        seenPaths.add(segment);
        filtered.push({ path: segment, isSymlink: true });
      }
    }
  }

  return filtered.sort((a, b) => a.path.localeCompare(b.path));
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a symlink exists (even if broken) using lstat.
 */
export async function symlinkExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function getFileMtime(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function getSymlinkMtime(filePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.mtime.toISOString();
  } catch {
    return null;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export function deriveStoreName(localPath: string): string {
  // Use the last two path segments joined with --
  // e.g. /Users/thi/git/ideta/DocumentAnalysis -> ideta--DocumentAnalysis
  // e.g. /Users/thi/git/my-project -> my-project
  const parts = localPath.split(path.sep).filter(Boolean);
  const name = parts[parts.length - 1];
  const parent = parts[parts.length - 2];

  // If parent looks like a common git root (git, repos, projects, src, home dirs),
  // just use the repo name
  const commonRoots = ['git', 'repos', 'projects', 'src', 'code', 'workspace', 'dev'];
  if (parent && !commonRoots.includes(parent.toLowerCase())) {
    return `${parent}--${name}`;
  }
  return name;
}
