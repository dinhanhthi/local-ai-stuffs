import fs from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';

const MARKER_COMMENT = '# AI config files (managed by AI Sync)';
const MARKER_END = '# End AI Sync managed';
const LEGACY_MARKER_COMMENT = '# AI config files (managed by local-ai-stuffs)';

/**
 * Get the root-level gitignore patterns needed for a set of file paths.
 * e.g. "CLAUDE.md" -> "CLAUDE.md", ".cursor/rules/main.mdc" -> ".cursor/"
 */
function getIgnorePatternsFromPaths(filePaths: string[]): string[] {
  const patterns = new Set<string>();
  for (const fp of filePaths) {
    const firstSegment = fp.split('/')[0];
    if (firstSegment.includes('.') || !fp.includes('/')) {
      // It's a file at root level (e.g. CLAUDE.md, .cursorrules)
      patterns.add(firstSegment);
    } else {
      // It's inside a directory (e.g. .cursor/rules/...) -> ignore the dir
      patterns.add(firstSegment + '/');
    }
  }
  return [...patterns].sort();
}

/**
 * Convert file patterns (glob patterns from settings) to root-level gitignore patterns.
 * e.g. ".claude/**" -> ".claude/", "CLAUDE.md" -> "CLAUDE.md", ".github/copilot-instructions.md" -> ".github/copilot-instructions.md"
 */
function getIgnorePatternsFromFilePatterns(filePatterns: string[]): string[] {
  const patterns = new Set<string>();
  for (const fp of filePatterns) {
    // Strip glob suffixes like /** or /*
    const cleaned = fp.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
    const firstSegment = cleaned.split('/')[0];
    if (cleaned.includes('/')) {
      // Multi-segment path (e.g. ".github/copilot-instructions.md") -> keep as-is
      patterns.add(cleaned);
    } else if (firstSegment.startsWith('.') && fp.includes('/**')) {
      // Directory pattern (e.g. ".claude/**") -> ".claude/"
      patterns.add(firstSegment + '/');
    } else {
      // Root-level file or glob (e.g. "CLAUDE.md", ".cursorrules", ".aider*")
      patterns.add(cleaned);
    }
  }
  return [...patterns].sort();
}

/**
 * Sync the managed block in .gitignore to contain exactly the given patterns.
 * Adds new patterns, removes patterns no longer needed, and only touches
 * lines within the managed block (between start and end markers).
 */
export async function syncManagedGitignoreBlock(
  repoPath: string,
  desiredPatterns: string[],
): Promise<void> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf-8');
  } catch {
    // File doesn't exist yet
  }

  const sorted = [...new Set(desiredPatterns)].sort();

  const hasMarker = content.includes(MARKER_COMMENT) || content.includes(LEGACY_MARKER_COMMENT);
  if (hasMarker) {
    const lines = content.split('\n');
    const markerIdx = lines.findIndex(
      (l) => l.trim() === MARKER_COMMENT || l.trim() === LEGACY_MARKER_COMMENT,
    );

    // Find end of managed block: either the end marker or first empty line (legacy)
    let endIdx = markerIdx + 1;
    let hasEndMarker = false;
    while (endIdx < lines.length) {
      if (lines[endIdx].trim() === MARKER_END) {
        hasEndMarker = true;
        break;
      }
      if (lines[endIdx].trim() === '') break;
      endIdx++;
    }

    // Replace the managed block content (keep start marker, replace patterns, ensure end marker)
    const beforeBlock = lines.slice(0, markerIdx);
    const afterBlock = lines.slice(hasEndMarker ? endIdx + 1 : endIdx);

    const newBlock =
      sorted.length > 0
        ? [MARKER_COMMENT, ...sorted, MARKER_END]
        : // Remove entire block if no patterns
          [];

    const newLines = [...beforeBlock, ...newBlock, ...afterBlock];
    content = newLines.join('\n');
  } else if (sorted.length > 0) {
    // No existing block — create new managed block at end
    const block = `\n${MARKER_COMMENT}\n${sorted.join('\n')}\n${MARKER_END}\n`;
    content = content.trimEnd() + '\n' + block;
  }

  await fs.writeFile(gitignorePath, content, 'utf-8');
}

/**
 * Remove AI files from git tracking (git rm --cached) while keeping them locally.
 * This ensures files are untracked by git after being added to .gitignore.
 */
export async function removeFromGitTracking(
  repoPath: string,
  filePaths: string[],
): Promise<string[]> {
  const git = simpleGit(repoPath);
  const removed: string[] = [];

  for (const filePath of filePaths) {
    try {
      // Check if file is tracked by git
      const result = await git.raw(['ls-files', filePath]);
      if (result.trim()) {
        // File is tracked, remove from git index but keep local copy
        await git.raw(['rm', '--cached', filePath]);
        removed.push(filePath);
      }
    } catch {
      // File not tracked or other error, skip
    }
  }

  return removed;
}

/**
 * Full gitignore setup for a repo: sync managed block and remove from git tracking.
 * Uses both tracked file paths and enabled file patterns from settings to ensure
 * all configured AI patterns are in .gitignore even if no matching files exist yet.
 * Patterns that are disabled/removed will be removed from the managed block.
 */
export async function setupGitignore(
  repoPath: string,
  trackedFiles: string[],
  filePatterns?: string[],
): Promise<{ addedPatterns: string[]; removedFromGit: string[] }> {
  // When filePatterns is provided, use it as the sole source of truth for .gitignore entries.
  // This ensures disabled patterns are removed. Fall back to tracked file paths only when
  // filePatterns is not available (legacy callers).
  const desiredPatterns = filePatterns
    ? [...new Set(getIgnorePatternsFromFilePatterns(filePatterns))].sort()
    : getIgnorePatternsFromPaths(trackedFiles);

  // Read current managed block to compute what was added
  const currentManaged = await readManagedPatterns(repoPath);
  await syncManagedGitignoreBlock(repoPath, desiredPatterns);
  const addedPatterns = desiredPatterns.filter((p) => !currentManaged.includes(p));

  const removedFromGit = await removeFromGitTracking(repoPath, trackedFiles);

  return { addedPatterns, removedFromGit };
}

/**
 * Read patterns currently in the managed block of .gitignore.
 */
async function readManagedPatterns(repoPath: string): Promise<string[]> {
  const gitignorePath = path.join(repoPath, '.gitignore');
  let content = '';
  try {
    content = await fs.readFile(gitignorePath, 'utf-8');
  } catch {
    return [];
  }

  const hasMarker = content.includes(MARKER_COMMENT) || content.includes(LEGACY_MARKER_COMMENT);
  if (!hasMarker) return [];

  const lines = content.split('\n');
  const markerIdx = lines.findIndex(
    (l) => l.trim() === MARKER_COMMENT || l.trim() === LEGACY_MARKER_COMMENT,
  );

  const patterns: string[] = [];
  for (let i = markerIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '' || trimmed === MARKER_END) break;
    if (!trimmed.startsWith('#')) patterns.push(trimmed);
  }
  return patterns;
}
