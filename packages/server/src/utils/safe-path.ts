import path from 'node:path';

/**
 * Safely join a base directory with untrusted path segments.
 * Throws if the resolved path escapes the base directory (path traversal).
 */
export function safeJoin(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new PathTraversalError(segments.join('/'));
  }
  return resolved;
}

/**
 * Validate that a symlink target is safe (relative, no escaping).
 * Throws if the target is absolute or contains segments that could escape.
 */
export function validateSymlinkTarget(target: string): void {
  if (path.isAbsolute(target)) {
    throw new SymlinkTargetError('Symlink target must be a relative path');
  }
  const normalized = path.normalize(target);
  if (normalized.startsWith('..')) {
    throw new SymlinkTargetError('Symlink target must not escape the base directory');
  }
}

export class PathTraversalError extends Error {
  constructor(attemptedPath: string) {
    super(`Path traversal detected: ${attemptedPath}`);
    this.name = 'PathTraversalError';
  }
}

export class SymlinkTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SymlinkTargetError';
  }
}
