import type { FastifyInstance } from 'fastify';
import type { AppState } from '../app-state.js';

export function registerWsHandlers(app: FastifyInstance, state: AppState): void {
  app.get('/ws', { websocket: true }, (socket) => {
    if (!state.syncEngine) {
      socket.close();
      return;
    }

    const client = {
      send: (data: string) => {
        if (socket.readyState === 1) {
          socket.send(data);
        }
      },
    };

    state.syncEngine.registerWsClient(client);

    socket.on('close', () => {
      state.syncEngine?.unregisterWsClient(client);
    });

    socket.on('error', () => {
      state.syncEngine?.unregisterWsClient(client);
    });
  });
}
