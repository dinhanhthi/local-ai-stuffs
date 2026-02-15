import fs from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { TrackedFile, ConflictWithDetails } from '../types/index.js';
import { config } from '../config.js';

interface ConflictRow {
  id: string;
  tracked_file_id: string;
  store_content: string | null;
  target_content: string | null;
  store_checksum: string;
  target_checksum: string;
  status: string;
  resolved_at: string | null;
  created_at: string;
  repo_id: string | null;
  service_config_id: string | null;
  relative_path: string;
}

interface TargetRow {
  id: string;
  name: string;
  local_path: string;
  store_path: string;
  status: string;
  type: 'repo' | 'service';
}

export async function createConflict(
  db: Database.Database,
  trackedFile: TrackedFile,
  storeFilePath: string,
  targetFilePath: string,
  syncStatus: string = 'conflict',
  baseContent?: string | null,
  mergedContent?: string | null,
): Promise<ConflictWithDetails | null> {
  // Read both file contents
  let storeContent: string | null = null;
  let targetContent: string | null = null;

  try {
    storeContent = await fs.readFile(storeFilePath, 'utf-8');
  } catch {
    // File may not exist
  }

  try {
    targetContent = await fs.readFile(targetFilePath, 'utf-8');
  } catch {
    // File may not exist
  }

  const conflictId = uuid();

  db.prepare(
    `
    INSERT INTO conflicts (id, tracked_file_id, store_content, target_content, base_content, merged_content, store_checksum, target_checksum, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `,
  ).run(
    conflictId,
    trackedFile.id,
    storeContent,
    targetContent,
    baseContent ?? null,
    mergedContent ?? null,
    trackedFile.storeChecksum || '',
    trackedFile.targetChecksum || '',
  );

  // Update tracked file status
  db.prepare('UPDATE tracked_files SET sync_status = ? WHERE id = ?').run(
    syncStatus,
    trackedFile.id,
  );

  // Fetch repo or service info for the response
  let repoId: string | null = null;
  let repoName: string | null = null;
  let serviceId: string | null = null;
  let serviceName: string | null = null;

  if (trackedFile.repoId) {
    const repo = db.prepare(`SELECT id, name FROM repos WHERE id = ?`).get(trackedFile.repoId) as
      | { id: string; name: string }
      | undefined;
    repoId = trackedFile.repoId;
    repoName = repo?.name || 'Unknown';
  } else if (trackedFile.serviceConfigId) {
    const svc = db
      .prepare(`SELECT id, name FROM service_configs WHERE id = ?`)
      .get(trackedFile.serviceConfigId) as { id: string; name: string } | undefined;
    serviceId = trackedFile.serviceConfigId;
    serviceName = svc?.name || 'Unknown';
  }

  return {
    id: conflictId,
    trackedFileId: trackedFile.id,
    storeContent,
    targetContent,
    baseContent: baseContent ?? null,
    mergedContent: mergedContent ?? null,
    storeChecksum: trackedFile.storeChecksum || '',
    targetChecksum: trackedFile.targetChecksum || '',
    status: 'pending',
    resolvedAt: null,
    createdAt: new Date().toISOString(),
    repoId,
    repoName,
    serviceId,
    serviceName,
    relativePath: trackedFile.relativePath,
  };
}

export async function resolveConflict(
  db: Database.Database,
  conflictId: string,
  resolution: 'keep_store' | 'keep_target' | 'manual' | 'delete',
  manualContent?: string,
): Promise<{
  storeFilePath: string;
  targetFilePath: string;
  content: string;
  repoName: string;
  deleted?: boolean;
} | null> {
  const conflict = db
    .prepare(
      `
    SELECT c.*, tf.repo_id, tf.service_config_id, tf.relative_path
    FROM conflicts c
    JOIN tracked_files tf ON c.tracked_file_id = tf.id
    WHERE c.id = ?
  `,
    )
    .get(conflictId) as ConflictRow | undefined;

  if (!conflict) return null;

  // Look up the target (repo or service config)
  let target: TargetRow | undefined;
  if (conflict.repo_id) {
    const repo = db
      .prepare('SELECT id, name, local_path, store_path, status FROM repos WHERE id = ?')
      .get(conflict.repo_id) as Omit<TargetRow, 'type'> | undefined;
    if (repo) target = { ...repo, type: 'repo' };
  } else if (conflict.service_config_id) {
    const svc = db
      .prepare('SELECT id, name, local_path, store_path, status FROM service_configs WHERE id = ?')
      .get(conflict.service_config_id) as Omit<TargetRow, 'type'> | undefined;
    if (svc) target = { ...svc, type: 'service' };
  }
  if (!target) return null;

  const storeBasePath =
    target.type === 'repo'
      ? path.join(config.storeReposPath, target.store_path.replace(/^repos\//, ''))
      : path.join(config.storeServicesPath, target.store_path.replace(/^services\//, ''));
  const storeFilePath = path.join(storeBasePath, conflict.relative_path);
  const targetFilePath = path.join(target.local_path, conflict.relative_path);

  let content: string;
  let resolvedStatus: string;
  let deleted = false;

  switch (resolution) {
    case 'keep_store': {
      // If store file was deleted, "keep store" means delete both sides
      let storeExists = true;
      try {
        await fs.access(storeFilePath);
      } catch {
        storeExists = false;
      }
      if (storeExists) {
        content = await fs.readFile(storeFilePath, 'utf-8');
      } else {
        content = '';
        deleted = true;
      }
      resolvedStatus = 'resolved_store';
      break;
    }
    case 'keep_target': {
      // If target file was deleted, "keep target" means delete both sides
      let targetExists = true;
      try {
        await fs.access(targetFilePath);
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        content = await fs.readFile(targetFilePath, 'utf-8');
      } else {
        content = '';
        deleted = true;
      }
      resolvedStatus = 'resolved_target';
      break;
    }
    case 'manual':
      content = manualContent || '';
      resolvedStatus = 'resolved_manual';
      break;
    case 'delete':
      content = '';
      resolvedStatus = 'resolved_delete';
      break;
  }

  // Update conflict record
  db.prepare(
    `
    UPDATE conflicts SET status = ?, resolved_at = datetime('now') WHERE id = ?
  `,
  ).run(resolvedStatus, conflictId);

  // Update tracked file status back to synced
  db.prepare(
    `
    UPDATE tracked_files SET sync_status = 'synced', last_synced_at = datetime('now') WHERE id = ?
  `,
  ).run(conflict.tracked_file_id);

  return {
    storeFilePath,
    targetFilePath,
    content,
    repoName: target.name,
    deleted,
  };
}
