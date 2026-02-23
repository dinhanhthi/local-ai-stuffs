import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  // SQLite datetime('now') returns UTC without 'Z' suffix — append it so JS parses as UTC
  const normalized = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const date = new Date(normalized);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 60000) return 'Just now';
  if (diffMs < 3600000) return `${Math.floor(diffMs / 60000)}m ago`;
  if (diffMs < 86400000) return `${Math.floor(diffMs / 3600000)}h ago`;

  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;

  const diffWeeks = Math.floor(diffDays / 7);
  if (diffDays < 30) return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`;

  const diffMonths = Math.floor(diffDays / 30);
  if (diffDays < 365) return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`;

  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${mm}/${dd}/${yyyy}`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export type SizeLevel = 'normal' | 'warning' | 'danger' | 'blocked';

export const MB = 1024 * 1024;

export interface SizeThresholds {
  warningMB: number;
  dangerMB: number;
  blockedMB: number;
}

export const DEFAULT_SIZE_THRESHOLDS: SizeThresholds = {
  warningMB: 20,
  dangerMB: 50,
  blockedMB: 100,
};

export function getSizeLevel(
  bytes: number,
  thresholds: SizeThresholds = DEFAULT_SIZE_THRESHOLDS,
): SizeLevel {
  if (bytes > thresholds.blockedMB * MB) return 'blocked';
  if (bytes > thresholds.dangerMB * MB) return 'danger';
  if (bytes > thresholds.warningMB * MB) return 'warning';
  return 'normal';
}

const SIZE_COLOR_CLASSES: Record<SizeLevel, string> = {
  normal: 'text-muted-foreground/60',
  warning: 'text-amber-500',
  danger: 'text-red-500',
  blocked: 'text-violet-500 font-medium',
};

export function sizeColorClass(
  bytes: number,
  thresholds: SizeThresholds = DEFAULT_SIZE_THRESHOLDS,
): string {
  return SIZE_COLOR_CLASSES[getSizeLevel(bytes, thresholds)];
}

/**
 * Compute the set of file paths belonging to the top N largest entries
 * (individual files + aggregated folders, ranked by size).
 */
export function computeLargestPaths(
  files: { relativePath: string; storeSize?: number }[],
  topN = 10,
): Set<string> {
  if (files.length === 0) return new Set();

  const entries: { path: string; size: number; isFile: boolean }[] = [];
  const folderSizes = new Map<string, number>();

  for (const f of files) {
    if (f.storeSize && f.storeSize > 0) {
      entries.push({ path: f.relativePath, size: f.storeSize, isFile: true });
    }
    const parts = f.relativePath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      folderSizes.set(dir, (folderSizes.get(dir) ?? 0) + (f.storeSize ?? 0));
    }
  }
  for (const [dir, size] of folderSizes) {
    if (size > 0) entries.push({ path: dir, size, isFile: false });
  }

  const top = entries.sort((a, b) => b.size - a.size).slice(0, topN);

  const paths = new Set<string>();
  for (const entry of top) {
    if (entry.isFile) {
      paths.add(entry.path);
    } else {
      for (const f of files) {
        if (f.relativePath.startsWith(entry.path + '/')) {
          paths.add(f.relativePath);
        }
      }
    }
  }
  return paths;
}
