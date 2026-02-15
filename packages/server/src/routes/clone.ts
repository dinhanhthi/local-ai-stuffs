import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
import { contentChecksum } from '../services/checksum.js';
import { getFileMtime, ensureDir, fileExists, isSymlink } from '../services/repo-scanner.js';
import type { Repo, TrackedFile } from '../types/index.js';
import type { AppState } from '../app-state.js';
import { mapRow, mapRows } from '../db/index.js';

interface CloneResolution {
  targetRepoId: string;
  relativePath: string;
  action: 'overwrite' | 'skip' | 'manual';
  content?: string;
}

interface CloneRequest {
  sourceRepoId: string;
  paths: string[];
  targetRepoIds: string[];
  dryRun: boolean;
  resolutions?: CloneResolution[];
}

interface CloneFileResult {
  relativePath: string;
  status:
    | 'will_create'
    | 'already_same'
    | 'will_conflict'
    | 'created'
    | 'skipped'
    | 'overwritten'
    | 'manual_saved';
  sourceContent?: string;
  existingContent?: string;
}

interface CloneRepoResult {
  targetRepoId: string;
  targetRepoName: string;
  files: CloneFileResult[];
}

export function registerCloneRoutes(app: FastifyInstance, state: AppState): void {
  app.post<{ Body: CloneRequest }>('/api/clone', async (req, reply) => {
    if (!state.db || !state.syncEngine) {
      return reply.code(503).send({ error: 'Not configured' });
    }
    const db = state.db;
    const syncEngine = state.syncEngine;

    const { sourceRepoId, paths, targetRepoIds, dryRun, resolutions } = req.body;

    if (!sourceRepoId || !paths?.length || !targetRepoIds?.length) {
      return reply.code(400).send({ error: 'sourceRepoId, paths, and targetRepoIds are required' });
    }

    // Validate source repo
    const sourceRepo = mapRow<Repo>(
      db.prepare('SELECT * FROM repos WHERE id = ?').get(sourceRepoId),
    );
    if (!sourceRepo) {
      return reply.code(404).send({ error: 'Source repo not found' });
    }

    // Validate target repos
    const targetRepos: Repo[] = [];
    for (const tid of targetRepoIds) {
      const repo = mapRow<Repo>(db.prepare('SELECT * FROM repos WHERE id = ?').get(tid));
      if (!repo) {
        return reply.code(404).send({ error: `Target repo ${tid} not found` });
      }
      targetRepos.push(repo);
    }

    // Expand paths: resolve folders to their tracked files
    const expandedPaths = new Set<string>();
    for (const p of paths) {
      // Check if this is a tracked file directly
      const directFile = mapRow<TrackedFile>(
        db
          .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
          .get(sourceRepoId, p),
      );
      if (directFile) {
        expandedPaths.add(p);
      }
      // Also check for files under this path (folder expansion)
      const children = mapRows<TrackedFile>(
        db
          .prepare("SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path LIKE ? || '/%'")
          .all(sourceRepoId, p),
      );
      for (const child of children) {
        expandedPaths.add(child.relativePath);
      }
    }

    if (expandedPaths.size === 0) {
      return reply.code(400).send({ error: 'No files found for the given paths' });
    }

    const sourceStoreName = sourceRepo.storePath.replace(/^repos\//, '');

    // Build resolution lookup for execute mode
    const resolutionMap = new Map<string, CloneResolution>();
    if (resolutions) {
      for (const r of resolutions) {
        resolutionMap.set(`${r.targetRepoId}:${r.relativePath}`, r);
      }
    }

    const results: CloneRepoResult[] = [];

    for (const targetRepo of targetRepos) {
      const targetStoreName = targetRepo.storePath.replace(/^repos\//, '');
      const repoResult: CloneRepoResult = {
        targetRepoId: targetRepo.id,
        targetRepoName: targetRepo.name,
        files: [],
      };

      for (const relativePath of expandedPaths) {
        const sourceFilePath = path.join(config.storeReposPath, sourceStoreName, relativePath);

        const targetStoreFilePath = path.join(config.storeReposPath, targetStoreName, relativePath);

        try {
          // Read source content
          const sourceIsSymlink = await isSymlink(sourceFilePath);
          let sourceContent: string;
          if (sourceIsSymlink) {
            sourceContent = await fs.readlink(sourceFilePath);
          } else {
            sourceContent = await fs.readFile(sourceFilePath, 'utf-8');
          }

          // Check if target already has this file
          const targetExists = await fileExists(targetStoreFilePath);

          if (!targetExists) {
            // File doesn't exist in target
            if (dryRun) {
              repoResult.files.push({ relativePath, status: 'will_create' });
            } else {
              await ensureDir(path.dirname(targetStoreFilePath));
              if (sourceIsSymlink) {
                await fs.symlink(sourceContent, targetStoreFilePath);
              } else {
                await fs.writeFile(targetStoreFilePath, sourceContent, 'utf-8');
              }

              // Create or update tracked file record
              const existingTracked = mapRow<TrackedFile>(
                db
                  .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
                  .get(targetRepo.id, relativePath),
              );

              const checksum = contentChecksum(sourceContent);
              const mtime = await getFileMtime(targetStoreFilePath);

              if (existingTracked) {
                db.prepare(
                  `UPDATE tracked_files SET store_checksum = ?, store_mtime = ?, sync_status = 'pending_to_target' WHERE id = ?`,
                ).run(checksum, mtime, existingTracked.id);
              } else {
                const fileId = uuid();
                db.prepare(
                  `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, store_mtime, sync_status)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending_to_target')`,
                ).run(
                  fileId,
                  targetRepo.id,
                  relativePath,
                  sourceIsSymlink ? 'symlink' : 'file',
                  checksum,
                  mtime,
                );
              }

              repoResult.files.push({ relativePath, status: 'created' });
            }
          } else {
            // File exists in target — compare content
            const targetIsSymlink = await isSymlink(targetStoreFilePath);
            let existingContent: string;
            if (targetIsSymlink) {
              existingContent = await fs.readlink(targetStoreFilePath);
            } else {
              existingContent = await fs.readFile(targetStoreFilePath, 'utf-8');
            }

            if (sourceContent === existingContent) {
              repoResult.files.push({ relativePath, status: dryRun ? 'already_same' : 'skipped' });
            } else if (dryRun) {
              repoResult.files.push({
                relativePath,
                status: 'will_conflict',
                sourceContent,
                existingContent,
              });
            } else {
              // Execute mode — look up resolution
              const key = `${targetRepo.id}:${relativePath}`;
              const resolution = resolutionMap.get(key);

              if (!resolution || resolution.action === 'skip') {
                repoResult.files.push({ relativePath, status: 'skipped' });
              } else if (resolution.action === 'overwrite') {
                if (sourceIsSymlink) {
                  try {
                    await fs.unlink(targetStoreFilePath);
                  } catch {
                    /* may not exist */
                  }
                  await fs.symlink(sourceContent, targetStoreFilePath);
                } else {
                  await fs.writeFile(targetStoreFilePath, sourceContent, 'utf-8');
                }
                const checksum = contentChecksum(sourceContent);
                const mtime = await getFileMtime(targetStoreFilePath);
                await upsertTrackedFile(
                  db,
                  targetRepo.id,
                  relativePath,
                  sourceIsSymlink ? 'symlink' : 'file',
                  checksum,
                  mtime,
                );
                repoResult.files.push({ relativePath, status: 'overwritten' });
              } else if (resolution.action === 'manual' && resolution.content !== undefined) {
                await fs.writeFile(targetStoreFilePath, resolution.content, 'utf-8');
                const checksum = contentChecksum(resolution.content);
                const mtime = await getFileMtime(targetStoreFilePath);
                await upsertTrackedFile(db, targetRepo.id, relativePath, 'file', checksum, mtime);
                repoResult.files.push({ relativePath, status: 'manual_saved' });
              } else {
                repoResult.files.push({ relativePath, status: 'skipped' });
              }
            }
          }
        } catch {
          // Skip files that can't be read
          repoResult.files.push({ relativePath, status: 'skipped' });
        }
      }

      results.push(repoResult);

      // Trigger sync for this target repo after all files written
      if (!dryRun) {
        await syncEngine.syncRepo(targetRepo.id);
      }
    }

    return { results };
  });
}

function upsertTrackedFile(
  db: import('better-sqlite3').Database,
  repoId: string,
  relativePath: string,
  fileType: string,
  checksum: string,
  mtime: string | null,
): void {
  const existing = mapRow<TrackedFile>(
    db
      .prepare('SELECT * FROM tracked_files WHERE repo_id = ? AND relative_path = ?')
      .get(repoId, relativePath),
  );
  if (existing) {
    db.prepare(
      `UPDATE tracked_files SET store_checksum = ?, store_mtime = ?, sync_status = 'pending_to_target' WHERE id = ?`,
    ).run(checksum, mtime, existing.id);
  } else {
    const fileId = uuid();
    db.prepare(
      `INSERT INTO tracked_files (id, repo_id, relative_path, file_type, store_checksum, store_mtime, sync_status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending_to_target')`,
    ).run(fileId, repoId, relativePath, fileType, checksum, mtime);
  }
}
