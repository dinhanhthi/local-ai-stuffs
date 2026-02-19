import notifier from 'node-notifier';
import type Database from 'better-sqlite3';
import type { ConflictWithDetails } from '../types/index.js';

// Track conflict IDs that have already been notified (in-memory).
// When a conflict is resolved, remove its tracked file from the set
// so a new conflict on the same file will trigger a fresh notification.
const notifiedTrackedFiles = new Set<string>();

function isEnabled(db: Database.Database): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'desktop_notifications'").get() as
    | { value: string }
    | undefined;
  // Default to enabled if not set
  return row ? row.value === 'true' : true;
}

export function sendConflictNotification(
  db: Database.Database,
  conflict: ConflictWithDetails,
): void {
  try {
    if (!isEnabled(db)) return;

    // Only notify once per tracked file until it's resolved
    if (notifiedTrackedFiles.has(conflict.trackedFileId)) return;
    notifiedTrackedFiles.add(conflict.trackedFileId);

    const target = conflict.repoName || conflict.serviceName || 'Unknown';
    notifier.notify({
      title: 'AI Sync — New Conflict',
      message: `${target}: ${conflict.relativePath}`,
    });
  } catch {
    // Never let notification errors break sync
  }
}

export function clearNotifiedConflict(trackedFileId: string): void {
  notifiedTrackedFiles.delete(trackedFileId);
}
