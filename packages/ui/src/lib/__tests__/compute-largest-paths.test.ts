import { describe, it, expect } from 'vitest';
import { computeLargestPaths } from '../utils';

const file = (relativePath: string, storeSize?: number) => ({ relativePath, storeSize });

describe('computeLargestPaths', () => {
  it('returns empty set for empty input', () => {
    expect(computeLargestPaths([])).toEqual(new Set());
  });

  it('returns empty set when all files have zero or undefined size', () => {
    const files = [file('a.txt', 0), file('b.txt'), file('c.txt', 0)];
    expect(computeLargestPaths(files)).toEqual(new Set());
  });

  it('returns the single file when only one file has size', () => {
    const files = [file('a.txt', 100), file('b.txt', 0)];
    const result = computeLargestPaths(files);
    expect(result).toEqual(new Set(['a.txt']));
  });

  it('ranks individual files by size descending', () => {
    const files = [file('small.txt', 10), file('big.txt', 1000), file('medium.txt', 500)];
    const result = computeLargestPaths(files, 2);
    // Top 2: big.txt (1000) and medium.txt (500)
    expect(result.has('big.txt')).toBe(true);
    expect(result.has('medium.txt')).toBe(true);
    expect(result.has('small.txt')).toBe(false);
  });

  it('aggregates folder sizes from child files', () => {
    const files = [file('docs/a.txt', 100), file('docs/b.txt', 200), file('src/index.ts', 50)];
    // Folder "docs" = 300, files: docs/a.txt=100, docs/b.txt=200, src/index.ts=50, folder "src"=50
    // Top 2: docs (300), docs/b.txt (200) => paths include docs/a.txt, docs/b.txt
    const result = computeLargestPaths(files, 2);
    expect(result.has('docs/a.txt')).toBe(true);
    expect(result.has('docs/b.txt')).toBe(true);
  });

  it('includes all files under a top-ranked folder', () => {
    const files = [
      file('big-folder/a.txt', 50),
      file('big-folder/b.txt', 50),
      file('big-folder/c.txt', 50),
      file('small.txt', 10),
    ];
    // folder big-folder = 150, individual files are 50 each, small.txt = 10
    // Top 1: big-folder (150) — should include all 3 children
    const result = computeLargestPaths(files, 1);
    expect(result.has('big-folder/a.txt')).toBe(true);
    expect(result.has('big-folder/b.txt')).toBe(true);
    expect(result.has('big-folder/c.txt')).toBe(true);
    expect(result.has('small.txt')).toBe(false);
  });

  it('handles nested folders aggregating at each level', () => {
    const files = [file('a/b/c.txt', 100), file('a/b/d.txt', 200), file('x.txt', 50)];
    // Folders: a/b = 300, a = 300
    // Top 3: a (300), a/b (300), a/b/d.txt (200)
    const result = computeLargestPaths(files, 3);
    expect(result.has('a/b/c.txt')).toBe(true);
    expect(result.has('a/b/d.txt')).toBe(true);
  });

  it('defaults to topN = 10', () => {
    // 15 files, each 10 bytes
    const files = Array.from({ length: 15 }, (_, i) => file(`file${i}.txt`, 10));
    const result = computeLargestPaths(files);
    // All 15 are same size but only 10 entries in top — since they're all root-level
    // files with no folders, all 15 compete. Top 10 out of 15 individual files.
    expect(result.size).toBe(10);
  });

  it('mixes files and folders in ranking', () => {
    const files = [file('docs/readme.md', 10), file('docs/guide.md', 10), file('huge.bin', 500)];
    // Entries: docs/readme.md=10, docs/guide.md=10, huge.bin=500, docs=20
    // Top 2: huge.bin (500), docs (20)
    const result = computeLargestPaths(files, 2);
    expect(result.has('huge.bin')).toBe(true);
    expect(result.has('docs/readme.md')).toBe(true);
    expect(result.has('docs/guide.md')).toBe(true);
  });

  it('root-level files without folders are included correctly', () => {
    const files = [file('root.txt', 999)];
    const result = computeLargestPaths(files);
    expect(result).toEqual(new Set(['root.txt']));
  });

  it('handles files with undefined storeSize gracefully', () => {
    const files = [file('a.txt', undefined), file('b.txt', 100)];
    const result = computeLargestPaths(files);
    expect(result.has('b.txt')).toBe(true);
    expect(result.has('a.txt')).toBe(false);
  });
});
