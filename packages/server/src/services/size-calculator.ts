import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Calculate total size of a directory recursively (in bytes).
 * Returns 0 if the directory doesn't exist.
 */
export async function getDirectorySize(dirPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += await getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        total += stat.size;
      }
      // Skip symlinks — they're just pointers, negligible size
    }
  } catch {
    // Directory doesn't exist or is inaccessible
  }
  return total;
}

/**
 * Get individual file sizes for tracked files in a store directory.
 * Returns a Map of relativePath → size in bytes.
 */
export async function getFileSizes(
  storeBase: string,
  relativePaths: string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const relPath of relativePaths) {
    try {
      const fullPath = path.join(storeBase, relPath);
      const stat = await fs.lstat(fullPath);
      sizes.set(relPath, stat.isFile() ? stat.size : 0);
    } catch {
      sizes.set(relPath, 0);
    }
  }
  return sizes;
}

/** Default block threshold: 100 MB in bytes */
export const DEFAULT_BLOCK_THRESHOLD_MB = 100;

export const MB = 1024 * 1024;

/** Get sync block threshold in bytes from DB setting, falling back to default */
export function getSyncBlockThreshold(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'size_blocked_mb'").get() as
    | { value: string }
    | undefined;
  const mb = row ? Number(row.value) : DEFAULT_BLOCK_THRESHOLD_MB;
  return (mb > 0 ? mb : DEFAULT_BLOCK_THRESHOLD_MB) * MB;
}
