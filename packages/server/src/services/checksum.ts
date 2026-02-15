import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

export async function fileChecksum(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

export function contentChecksum(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}

export async function symlinkChecksum(filePath: string): Promise<string> {
  const target = await fs.readlink(filePath);
  return createHash('sha256').update(target).digest('hex').substring(0, 16);
}
