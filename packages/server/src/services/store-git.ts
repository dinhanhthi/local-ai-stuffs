import { simpleGit, type SimpleGit } from 'simple-git';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';

const execFileAsync = promisify(execFile);

let git: SimpleGit | null = null;

// Batched commit state: accumulate messages and flush after a debounce window
const COMMIT_DEBOUNCE_MS = 2000;
const pendingMessages: string[] = [];
let commitTimer: ReturnType<typeof setTimeout> | null = null;
let flushPromise: Promise<void> | null = null;

// Pass through env vars so child git processes inherit the user's SSH agent & home dir.
// macOS/Linux: SSH_AUTH_SOCK, HOME
// Windows: USERPROFILE, SSH_AUTH_SOCK (if using OpenSSH agent)
function createGit(basePath: string): SimpleGit {
  const env: Record<string, string> = {};
  const passthrough = ['SSH_AUTH_SOCK', 'HOME', 'USERPROFILE', 'GIT_SSH_COMMAND', 'GIT_SSH'];
  for (const key of passthrough) {
    if (process.env[key]) {
      env[key] = process.env[key]!;
    }
  }
  return simpleGit({ baseDir: basePath }).env(env);
}

export async function initStoreRepo(): Promise<void> {
  // Ensure store directories exist
  await fs.mkdir(config.storeReposPath, { recursive: true });
  await fs.mkdir(`${config.storeReposPath}/_default`, { recursive: true });
  await fs.mkdir(path.join(config.storePath, 'services'), { recursive: true });
  await fs.mkdir(`${config.storePath}/.db`, { recursive: true });

  git = createGit(config.storePath);

  // Check if already a git repo
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
    // Create initial .gitignore (ignore .db/ and .DS_Store)
    await fs.writeFile(`${config.storePath}/.gitignore`, '.db/\n.DS_Store\n', 'utf-8');
    await git.add('.');
    await git.commit('Initial store setup');
  }

  // Ensure .db/ and .DS_Store are always in .gitignore (for stores created before this rule existed)
  const gitignorePath = `${config.storePath}/.gitignore`;
  const requiredEntries = ['.db/', '.DS_Store'];
  try {
    let content = await fs.readFile(gitignorePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim());
    const missing = requiredEntries.filter(
      (entry) => !lines.includes(entry) && !lines.includes(entry.replace('/', '')),
    );
    if (missing.length > 0) {
      const separator = content.endsWith('\n') ? '' : '\n';
      content += separator + missing.join('\n') + '\n';
      await fs.writeFile(gitignorePath, content, 'utf-8');
    }
  } catch {
    // No .gitignore exists — create one
    await fs.writeFile(gitignorePath, requiredEntries.join('\n') + '\n', 'utf-8');
  }

  // Ensure machines.json exists
  const machinesPath = path.join(config.storePath, 'machines.json');
  try {
    await fs.access(machinesPath);
  } catch {
    await fs.writeFile(
      machinesPath,
      JSON.stringify({ machines: {}, repos: {}, services: {} }, null, 2) + '\n',
      'utf-8',
    );
  }
}

export async function commitStoreChanges(message: string): Promise<void> {
  if (!git) {
    git = createGit(config.storePath);
  }

  const status = await git.status();
  if (status.files.length === 0) return;

  await git.add('.');
  await git.commit(message);
}

/**
 * Build a single commit message from a batch of messages.
 * De-duplicates identical messages and appends count if > 1.
 */
function buildBatchMessage(messages: string[]): string {
  const counts = new Map<string, number>();
  for (const msg of messages) {
    counts.set(msg, (counts.get(msg) ?? 0) + 1);
  }
  const lines: string[] = [];
  for (const [msg, count] of counts) {
    lines.push(count > 1 ? `${msg} (x${count})` : msg);
  }
  return lines.join('\n');
}

/**
 * Queue a commit message for batched commit. The actual commit is debounced —
 * all messages accumulated within the debounce window are flushed as a single commit.
 */
export function queueStoreCommit(message: string): void {
  pendingMessages.push(message);

  // Reset debounce timer on every new message
  if (commitTimer) clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    flushPendingCommits().catch((err) => {
      console.error('Batched auto-commit failed:', err);
    });
  }, COMMIT_DEBOUNCE_MS);
}

/**
 * Immediately flush all pending commit messages into a single git commit.
 * Safe to call even when the queue is empty (no-op).
 */
export async function flushPendingCommits(): Promise<void> {
  // If a flush is already in progress, wait for it and re-check
  if (flushPromise) {
    await flushPromise;
  }

  if (pendingMessages.length === 0) return;

  const doFlush = async () => {
    if (commitTimer) {
      clearTimeout(commitTimer);
      commitTimer = null;
    }

    const messages = pendingMessages.splice(0);
    if (messages.length === 0) return;

    const commitMsg = buildBatchMessage(messages);
    await commitStoreChanges(commitMsg);
  };

  flushPromise = doFlush();
  try {
    await flushPromise;
  } finally {
    flushPromise = null;
  }
}

/**
 * Cancel the pending commit timer (for graceful shutdown).
 */
export function cancelPendingCommitTimer(): void {
  if (commitTimer) {
    clearTimeout(commitTimer);
    commitTimer = null;
  }
}

export async function pushStoreChanges(): Promise<{ pushed: boolean; message: string }> {
  if (!git) {
    git = createGit(config.storePath);
  }

  const remotes = await git.getRemotes();
  if (remotes.length === 0) {
    return { pushed: false, message: 'No remote configured' };
  }

  const branch = await git.branchLocal();
  await git.push('origin', branch.current);
  return { pushed: true, message: `Pushed to origin/${branch.current}` };
}

export async function getStoreRemoteUrl(): Promise<string | null> {
  if (!git) {
    git = createGit(config.storePath);
  }

  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin');
  if (!origin?.refs?.fetch) return null;

  // Convert SSH URL to HTTPS URL for browser opening
  const url = origin.refs.fetch;
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return url.replace(/\.git$/, '');
}

export function getStoreGit(): SimpleGit {
  if (!git) {
    git = createGit(config.storePath);
  }
  return git;
}

/**
 * Get the last committed content of a file from the store git repo.
 * Returns null if the file has no git history (new file or empty repo).
 */
export async function getCommittedContent(relativePath: string): Promise<string | null> {
  if (!git) {
    git = createGit(config.storePath);
  }
  try {
    return await git.raw(['show', `HEAD:${relativePath}`]);
  } catch {
    // File doesn't exist in git history (new file or no commits yet)
    return null;
  }
}

/**
 * Ensure all store changes are committed before using git for comparison.
 * This prevents stale HEAD when files were written but not yet committed.
 * Flushes any pending batched commits first.
 */
export async function ensureStoreCommitted(): Promise<void> {
  // Flush any queued batched messages first
  await flushPendingCommits();

  if (!git) {
    git = createGit(config.storePath);
  }
  const status = await git.status();
  if (status.files.length > 0) {
    await git.add('.');
    await git.commit('Auto-commit before sync comparison');
  }
}

/**
 * Perform a 3-way merge using `git merge-file`.
 * Works on temp files — does NOT require being inside a git repo.
 *
 * @returns merged content and whether it has conflict markers
 */
export async function gitMergeFile(
  base: string,
  store: string,
  target: string,
): Promise<{ content: string; hasConflicts: boolean }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'las-merge-'));
  const basePath = path.join(tmpDir, 'base');
  const storePath = path.join(tmpDir, 'store');
  const targetPath = path.join(tmpDir, 'target');

  try {
    await Promise.all([
      fs.writeFile(basePath, base, 'utf-8'),
      fs.writeFile(storePath, store, 'utf-8'),
      fs.writeFile(targetPath, target, 'utf-8'),
    ]);

    try {
      // Exit code 0 = clean merge
      const { stdout } = await execFileAsync('git', [
        'merge-file',
        '--stdout',
        '-L',
        'store',
        '-L',
        'base',
        '-L',
        'target',
        storePath,
        basePath,
        targetPath,
      ]);
      return { content: stdout, hasConflicts: false };
    } catch (err: unknown) {
      const execErr = err as { code?: number; stdout?: string };
      if (execErr.code && execErr.code > 0 && execErr.stdout !== undefined) {
        // Positive exit code = number of conflicts, stdout has merged content with markers
        return { content: execErr.stdout, hasConflicts: true };
      }
      throw err;
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
