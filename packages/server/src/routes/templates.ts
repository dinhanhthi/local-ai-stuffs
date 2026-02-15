import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { ensureDir, fileExists } from '../services/repo-scanner.js';
import type { AppState } from '../app-state.js';
import { safeJoin, PathTraversalError } from '../utils/safe-path.js';

async function listFilesRecursive(dir: string, base = ''): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        result.push(...(await listFilesRecursive(path.join(dir, entry.name), rel)));
      } else {
        result.push(rel);
      }
    }
  } catch {
    // Directory may not exist
  }
  return result;
}

export function registerTemplateRoutes(app: FastifyInstance, _state: AppState): void {
  const getTemplateDir = () => path.join(config.storeReposPath, '_default');

  // List template files
  app.get('/api/templates/files', async (_req, reply) => {
    if (!config.storeReposPath) return reply.code(503).send({ error: 'Not configured' });

    const files = await listFilesRecursive(getTemplateDir());
    return { files };
  });

  // Get template file content
  app.get<{ Params: { '*': string } }>('/api/templates/files/*', async (req, reply) => {
    if (!config.storeReposPath) return reply.code(503).send({ error: 'Not configured' });

    let filePath: string;
    try {
      filePath = safeJoin(getTemplateDir(), req.params['*']);
    } catch (err) {
      if (err instanceof PathTraversalError)
        return reply.code(400).send({ error: 'Invalid file path' });
      throw err;
    }
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { content, path: req.params['*'] };
    } catch {
      return reply.code(404).send({ error: 'Template file not found' });
    }
  });

  // Update template file
  app.put<{ Params: { '*': string }; Body: { content: string } }>(
    '/api/templates/files/*',
    async (req, reply) => {
      if (!config.storeReposPath) return reply.code(503).send({ error: 'Not configured' });

      let filePath: string;
      try {
        filePath = safeJoin(getTemplateDir(), req.params['*']);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, req.body.content, 'utf-8');
      return { success: true };
    },
  );

  // Create template file
  app.post<{ Params: { '*': string }; Body: { content: string } }>(
    '/api/templates/files/*',
    async (req, reply) => {
      if (!config.storeReposPath) return reply.code(503).send({ error: 'Not configured' });

      let filePath: string;
      try {
        filePath = safeJoin(getTemplateDir(), req.params['*']);
      } catch (err) {
        if (err instanceof PathTraversalError)
          return reply.code(400).send({ error: 'Invalid file path' });
        throw err;
      }
      if (await fileExists(filePath)) {
        return reply.code(409).send({ error: 'Template file already exists' });
      }
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, req.body.content, 'utf-8');
      return reply.code(201).send({ success: true });
    },
  );

  // Delete template file
  app.delete<{ Params: { '*': string } }>('/api/templates/files/*', async (req, reply) => {
    if (!config.storeReposPath) return reply.code(503).send({ error: 'Not configured' });

    let filePath: string;
    try {
      filePath = safeJoin(getTemplateDir(), req.params['*']);
    } catch (err) {
      if (err instanceof PathTraversalError)
        return reply.code(400).send({ error: 'Invalid file path' });
      throw err;
    }
    try {
      await fs.unlink(filePath);
      return { success: true };
    } catch {
      return reply.code(404).send({ error: 'Template file not found' });
    }
  });
}
