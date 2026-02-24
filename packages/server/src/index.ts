import { buildApp } from './app.js';
import { initDb, loadCustomServiceDefinitions } from './db/index.js';
import { config, isConfigured, ensureMachineId } from './config.js';
import { initStoreRepo, commitStoreChanges } from './services/store-git.js';
import { SyncEngine } from './services/sync-engine.js';
import { registerCurrentMachine, seedMachinesFile, autoLinkRepos } from './services/machines.js';
import { restoreOrMigrateSettings } from './services/sync-settings.js';
import type { AppState } from './app-state.js';

async function main() {
  console.log('Starting AI Sync...');

  const state: AppState = { db: null, syncEngine: null };

  if (isConfigured()) {
    ensureMachineId();

    state.db = initDb(config.dbPath);
    loadCustomServiceDefinitions(state.db);
    console.log(`Database initialized at ${config.dbPath}`);

    await initStoreRepo();
    console.log(`Store initialized at ${config.storePath}`);

    // Restore shared settings from sync-settings.json (or export on first run)
    restoreOrMigrateSettings(state.db);

    // Register this machine and seed/auto-link repos
    registerCurrentMachine();
    seedMachinesFile(state.db);
    const linkResults = await autoLinkRepos(state.db);
    const linked = linkResults.filter((r) => r.status === 'linked');
    if (linked.length > 0) {
      console.log(`Auto-linked ${linked.length} repo(s) from machines.json`);
    }
    await commitStoreChanges(`Machine ${config.machineName} startup`);

    state.syncEngine = new SyncEngine(state.db);
  } else {
    console.log('Not configured yet — starting in setup mode');
  }

  const app = await buildApp(state);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    if (state.syncEngine) await state.syncEngine.stop();
    await app.close();
    if (state.db) state.db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `Server running at http://localhost:${config.port} (${config.isDev ? 'dev' : 'production'})`,
  );
  if (config.isDev) {
    console.log('Dev mode: UI is served by Vite at http://localhost:5173');
  }

  if (state.syncEngine) {
    await state.syncEngine.start();
  }
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
