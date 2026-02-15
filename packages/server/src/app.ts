import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyMultipart from '@fastify/multipart';
import fs from 'node:fs';
import { config } from './config.js';
import { registerRepoRoutes } from './routes/repos.js';
import { registerFileRoutes } from './routes/files.js';
import { registerConflictRoutes } from './routes/conflicts.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerSyncRoutes } from './routes/sync.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerCloneRoutes } from './routes/clone.js';
import { registerServiceRoutes } from './routes/services.js';
import { registerSetupRoutes } from './routes/setup.js';
import { registerVersionRoutes } from './routes/version.js';
import { registerMachineRoutes } from './routes/machines.js';
import { registerWsHandlers } from './ws/handlers.js';
import type { AppState } from './app-state.js';

export async function buildApp(state: AppState) {
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, {
    origin: [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/],
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: 1048576 } });
  await app.register(fastifyMultipart, { limits: { fileSize: 2 * 1024 * 1024 } });

  // All routes are always registered — they check state.db/state.syncEngine internally
  registerSetupRoutes(app, state);
  registerRepoRoutes(app, state);
  registerFileRoutes(app, state);
  registerConflictRoutes(app, state);
  registerSettingsRoutes(app, state);
  registerSyncRoutes(app, state);
  registerTemplateRoutes(app, state);
  registerCloneRoutes(app, state);
  registerServiceRoutes(app, state);
  registerMachineRoutes(app, state);
  registerVersionRoutes(app);
  registerWsHandlers(app, state);

  // Serve UI static files in production
  if (!config.isDev && config.uiDistPath && fs.existsSync(config.uiDistPath)) {
    await app.register(fastifyStatic, {
      root: config.uiDistPath,
      prefix: '/',
      wildcard: false,
    });

    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        reply.code(404).send({ error: 'Not found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}
