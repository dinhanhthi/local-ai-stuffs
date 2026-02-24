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

/**
 * Resolve the remote name for the current branch.
 * Checks branch tracking config first, then falls back to the first available remote.
 */
async function resolveRemote(): Promise<string | null> {
  if (!git) {
    git = createGit(config.storePath);
  }
  const remotes = await git.getRemotes();
  if (remotes.length === 0) return null;

  // Prefer the remote tracked by the current branch
  try {
    const branch = await git.branchLocal();
    const trackingRemote = await git
      .raw(['config', `branch.${branch.current}.remote`])
      .then((r) => r.trim());
    if (trackingRemote && remotes.some((r) => r.name === trackingRemote)) {
      return trackingRemote;
    }
  } catch {
    // No tracking config — fall through
  }

  // Fall back to 'origin' if it exists, otherwise use the first remote
  return remotes.find((r) => r.name === 'origin')?.name ?? remotes[0].name;
}

export interface StoreConfigConflict {
  file: 'sync-settings.json' | 'machines.json';
  content: string; // raw content with git conflict markers
  ours: string; // content of the "ours" (HEAD) side
  theirs: string; // content of the "theirs" (incoming) side
}

export interface PullResult {
  pulled: boolean;
  message: string;
  storeConflicts?: StoreConfigConflict[];
}

/** Parse conflict markers from a conflicted file, returning ours and theirs content. */
function parseConflictSides(content: string): { ours: string; theirs: string } {
  // Collect lines from each side by scanning conflict blocks
  const oursLines: string[] = [];
  const theirsLines: string[] = [];
  let inOurs = false;
  let inTheirs = false;

  for (const line of content.split('\n')) {
    if (line.startsWith('<<<<<<<')) {
      inOurs = true;
      inTheirs = false;
    } else if (line.startsWith('=======')) {
      inOurs = false;
      inTheirs = true;
    } else if (line.startsWith('>>>>>>>')) {
      inOurs = false;
      inTheirs = false;
    } else if (inOurs) {
      oursLines.push(line);
    } else if (inTheirs) {
      theirsLines.push(line);
    } else {
      // Context lines outside conflict blocks — include in both
      oursLines.push(line);
      theirsLines.push(line);
    }
  }

  return { ours: oursLines.join('\n'), theirs: theirsLines.join('\n') };
}

export async function pullStoreChanges(): Promise<PullResult> {
  const remote = await resolveRemote();
  if (!remote) {
    return { pulled: false, message: 'No remote configured' };
  }

  if (!git) {
    git = createGit(config.storePath);
  }

  const branch = await git.branchLocal();
  try {
    await git.pull(remote, branch.current);
  } catch (err) {
    // If git pull itself throws (e.g. merge conflict), check status for conflicted files
    const status = await git.status();
    const conflictedPaths = status.conflicted;

    const knownConfigFiles = ['sync-settings.json', 'machines.json'] as const;
    const storeConflicts: StoreConfigConflict[] = [];

    for (const filePath of conflictedPaths) {
      const basename = path.basename(filePath) as (typeof knownConfigFiles)[number];
      if (!knownConfigFiles.includes(basename)) continue;

      const fullPath = path.join(config.storePath, filePath);
      let content = '';
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch {
        continue;
      }

      const { ours, theirs } = parseConflictSides(content);
      storeConflicts.push({ file: basename, content, ours, theirs });
    }

    if (storeConflicts.length > 0) {
      return {
        pulled: true,
        message: `Pulled from ${remote}/${branch.current} with config conflicts`,
        storeConflicts,
      };
    }

    // Re-throw if no config conflicts (other errors like network issues)
    throw err;
  }

  return { pulled: true, message: `Pulled from ${remote}/${branch.current}` };
}

/**
 * Resolve a store config conflict by writing the chosen content to disk,
 * then staging and committing the resolution.
 */
export async function resolveStoreConfigConflict(
  file: 'sync-settings.json' | 'machines.json',
  content: string,
): Promise<void> {
  if (!git) {
    git = createGit(config.storePath);
  }

  const fullPath = path.join(config.storePath, file);
  await fs.writeFile(fullPath, content, 'utf-8');
  await git.add(file);

  // Check if all conflicts are resolved before committing
  const status = await git.status();
  if (status.conflicted.length === 0) {
    await git.commit(`Resolve conflict in ${file}`);
  }
}

export async function pushStoreChanges(): Promise<{ pushed: boolean; message: string }> {
  const remote = await resolveRemote();
  if (!remote) {
    return { pushed: false, message: 'No remote configured' };
  }

  const branch = await git!.branchLocal();
  await git!.push(remote, branch.current);
  return { pushed: true, message: `Pushed to ${remote}/${branch.current}` };
}

export async function getStoreRemoteUrl(): Promise<string | null> {
  if (!git) {
    git = createGit(config.storePath);
  }

  const remote = await resolveRemote();
  if (!remote) return null;

  const remotes = await git.getRemotes(true);
  const match = remotes.find((r) => r.name === remote);
  if (!match?.refs?.fetch) return null;

  // Convert SSH URL to HTTPS URL for browser opening
  const url = match.refs.fetch;
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
