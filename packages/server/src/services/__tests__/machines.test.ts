import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initSchema } from '../../db/schema.js';
import { config } from '../../config.js';
import type { MachinesFile } from '../../types/index.js';

// Mock gitignore-manager to avoid actual git operations
vi.mock('../gitignore-manager.js', () => ({
  setupGitignore: vi.fn().mockResolvedValue(undefined),
}));

// Mock repo-scanner: scanRepoForAIFiles returns empty, other functions remain real
vi.mock('../repo-scanner.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    scanRepoForAIFiles: vi.fn().mockResolvedValue([]),
  };
});

import {
  readMachinesFile,
  writeMachinesFile,
  registerCurrentMachine,
  setRepoMapping,
  removeRepoMapping,
  setServiceMapping,
  removeServiceMapping,
  getUnlinkedStoreRepos,
  getUnlinkedStoreServices,
  seedMachinesFile,
  autoLinkRepos,
  linkStoreRepo,
} from '../machines.js';

let tmpDir: string;
let db: Database.Database;

const MACHINE_ID = 'machine-aaa';
const MACHINE_NAME = 'Test Machine';
const OTHER_MACHINE_ID = 'machine-bbb';

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'machines-test-'));

  const storePath = path.join(tmpDir, 'store');
  const storeReposPath = path.join(storePath, 'repos');
  const storeServicesPath = path.join(storePath, 'services');
  await fs.mkdir(storeReposPath, { recursive: true });
  await fs.mkdir(storeServicesPath, { recursive: true });

  // Set config
  config.storePath = storePath;
  config.storeReposPath = storeReposPath;
  config.storeServicesPath = storeServicesPath;
  config.dataDir = storePath;
  config.machineId = MACHINE_ID;
  config.machineName = MACHINE_NAME;

  // Init DB
  db = new Database(':memory:');
  initSchema(db);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  readMachinesFile / writeMachinesFile                                ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('readMachinesFile / writeMachinesFile', () => {
  it('returns empty structure when file does not exist', () => {
    const data = readMachinesFile();
    expect(data).toEqual({ machines: {}, repos: {}, services: {} });
  });

  it('reads a valid machines.json', async () => {
    const content: MachinesFile = {
      machines: { [MACHINE_ID]: { name: 'Mac', lastSeen: '2025-01-01T00:00:00Z' } },
      repos: { 'repos/my-project': { [MACHINE_ID]: { localPath: '/home/user/project' } } },
      services: {},
    };
    await fs.writeFile(
      path.join(config.storePath, 'machines.json'),
      JSON.stringify(content),
      'utf-8',
    );

    const data = readMachinesFile();
    expect(data.machines[MACHINE_ID].name).toBe('Mac');
    expect(data.repos['repos/my-project'][MACHINE_ID].localPath).toBe('/home/user/project');
  });

  it('sorts keys when writing for stable git output', () => {
    const data: MachinesFile = {
      machines: {
        'zzz-machine': { name: 'Z', lastSeen: '2025-01-01T00:00:00Z' },
        'aaa-machine': { name: 'A', lastSeen: '2025-01-01T00:00:00Z' },
      },
      repos: {},
      services: {},
    };
    writeMachinesFile(data);

    const raw = fsSync.readFileSync(path.join(config.storePath, 'machines.json'), 'utf-8');
    const keys = Object.keys(JSON.parse(raw).machines);
    expect(keys).toEqual(['aaa-machine', 'zzz-machine']);
  });

  it('handles corrupt JSON gracefully', async () => {
    await fs.writeFile(path.join(config.storePath, 'machines.json'), '{ invalid json', 'utf-8');
    const data = readMachinesFile();
    expect(data).toEqual({ machines: {}, repos: {}, services: {} });
  });

  it('handles missing fields gracefully', async () => {
    await fs.writeFile(
      path.join(config.storePath, 'machines.json'),
      JSON.stringify({ machines: { x: { name: 'X', lastSeen: '' } } }),
      'utf-8',
    );
    const data = readMachinesFile();
    expect(data.machines.x.name).toBe('X');
    expect(data.repos).toEqual({});
    expect(data.services).toEqual({});
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  registerCurrentMachine                                             ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('registerCurrentMachine', () => {
  it('registers the current machine with name and timestamp', () => {
    registerCurrentMachine();

    const data = readMachinesFile();
    expect(data.machines[MACHINE_ID]).toBeDefined();
    expect(data.machines[MACHINE_ID].name).toBe(MACHINE_NAME);
    expect(data.machines[MACHINE_ID].lastSeen).toBeTruthy();
  });

  it('updates lastSeen on subsequent calls', async () => {
    registerCurrentMachine();
    const first = readMachinesFile().machines[MACHINE_ID].lastSeen;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    registerCurrentMachine();
    const second = readMachinesFile().machines[MACHINE_ID].lastSeen;

    expect(second >= first).toBe(true);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Repo mapping CRUD                                                  ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('repo mapping CRUD', () => {
  it('setRepoMapping adds a mapping for the current machine', () => {
    setRepoMapping('repos/my-project', '/home/user/project');

    const data = readMachinesFile();
    expect(data.repos['repos/my-project'][MACHINE_ID].localPath).toBe('/home/user/project');
  });

  it('setRepoMapping overwrites existing mapping for same machine', () => {
    setRepoMapping('repos/my-project', '/old/path');
    setRepoMapping('repos/my-project', '/new/path');

    const data = readMachinesFile();
    expect(data.repos['repos/my-project'][MACHINE_ID].localPath).toBe('/new/path');
  });

  it('removeRepoMapping with machineId removes only that machine', () => {
    // Setup: two machines
    const data: MachinesFile = {
      machines: {},
      repos: {
        'repos/project': {
          [MACHINE_ID]: { localPath: '/path/a' },
          [OTHER_MACHINE_ID]: { localPath: '/path/b' },
        },
      },
      services: {},
    };
    writeMachinesFile(data);

    removeRepoMapping('repos/project', MACHINE_ID);

    const result = readMachinesFile();
    expect(result.repos['repos/project'][MACHINE_ID]).toBeUndefined();
    expect(result.repos['repos/project'][OTHER_MACHINE_ID].localPath).toBe('/path/b');
  });

  it('removeRepoMapping with machineId removes entire entry when last machine', () => {
    setRepoMapping('repos/project', '/path/a');
    removeRepoMapping('repos/project', MACHINE_ID);

    const data = readMachinesFile();
    expect(data.repos['repos/project']).toBeUndefined();
  });

  it('removeRepoMapping without machineId removes all mappings', () => {
    const data: MachinesFile = {
      machines: {},
      repos: {
        'repos/project': {
          [MACHINE_ID]: { localPath: '/path/a' },
          [OTHER_MACHINE_ID]: { localPath: '/path/b' },
        },
      },
      services: {},
    };
    writeMachinesFile(data);

    removeRepoMapping('repos/project');

    const result = readMachinesFile();
    expect(result.repos['repos/project']).toBeUndefined();
  });

  it('removeRepoMapping is a no-op for non-existent store path', () => {
    removeRepoMapping('repos/does-not-exist');
    const data = readMachinesFile();
    expect(data.repos).toEqual({});
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  Service mapping CRUD                                               ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('service mapping CRUD', () => {
  it('setServiceMapping adds a mapping', () => {
    setServiceMapping('services/claude-code', '/home/user/.claude');

    const data = readMachinesFile();
    expect(data.services['services/claude-code'][MACHINE_ID].localPath).toBe('/home/user/.claude');
  });

  it('removeServiceMapping with machineId removes only that machine', () => {
    const data: MachinesFile = {
      machines: {},
      repos: {},
      services: {
        'services/claude-code': {
          [MACHINE_ID]: { localPath: '/path/a' },
          [OTHER_MACHINE_ID]: { localPath: '/path/b' },
        },
      },
    };
    writeMachinesFile(data);

    removeServiceMapping('services/claude-code', MACHINE_ID);

    const result = readMachinesFile();
    expect(result.services['services/claude-code'][MACHINE_ID]).toBeUndefined();
    expect(result.services['services/claude-code'][OTHER_MACHINE_ID]).toBeDefined();
  });

  it('removeServiceMapping without machineId removes all mappings', () => {
    setServiceMapping('services/claude-code', '/path/a');
    removeServiceMapping('services/claude-code');

    const data = readMachinesFile();
    expect(data.services['services/claude-code']).toBeUndefined();
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  seedMachinesFile                                                   ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('seedMachinesFile', () => {
  it('seeds repo mappings from DB repos', () => {
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run('r1', 'project-1', '/home/user/project-1', 'repos/project-1');

    seedMachinesFile(db);

    const data = readMachinesFile();
    expect(data.repos['repos/project-1'][MACHINE_ID].localPath).toBe('/home/user/project-1');
  });

  it('seeds service mappings from DB services', () => {
    db.prepare(
      "INSERT INTO service_configs (id, service_type, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
    ).run('s1', 'claude-code', 'Claude Code', '/home/user/.claude', 'services/claude-code');

    seedMachinesFile(db);

    const data = readMachinesFile();
    expect(data.services['services/claude-code'][MACHINE_ID].localPath).toBe('/home/user/.claude');
  });

  it('does not overwrite existing mappings', () => {
    // Pre-set a mapping
    setRepoMapping('repos/project-1', '/existing/path');

    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run('r1', 'project-1', '/home/user/project-1', 'repos/project-1');

    seedMachinesFile(db);

    const data = readMachinesFile();
    // Should keep the existing path, not overwrite
    expect(data.repos['repos/project-1'][MACHINE_ID].localPath).toBe('/existing/path');
  });

  it('is idempotent', () => {
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run('r1', 'project-1', '/home/user/project-1', 'repos/project-1');

    seedMachinesFile(db);
    seedMachinesFile(db);

    const data = readMachinesFile();
    expect(Object.keys(data.repos)).toHaveLength(1);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  getUnlinkedStoreRepos                                              ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('getUnlinkedStoreRepos', () => {
  it('returns empty when store/repos has no directories', async () => {
    const result = await getUnlinkedStoreRepos(db);
    expect(result).toEqual([]);
  });

  it('detects an unlinked store repo', async () => {
    // Create a store repo directory that's not in the DB
    await fs.mkdir(path.join(config.storeReposPath, 'orphan-project'), { recursive: true });

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(1);
    expect(result[0].storePath).toBe('repos/orphan-project');
    expect(result[0].storeName).toBe('orphan-project');
  });

  it('skips _default template directory', async () => {
    await fs.mkdir(path.join(config.storeReposPath, '_default'), { recursive: true });

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(0);
  });

  it('skips repos already registered in DB', async () => {
    await fs.mkdir(path.join(config.storeReposPath, 'linked-project'), { recursive: true });
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run('r1', 'linked-project', '/home/user/linked-project', 'repos/linked-project');

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(0);
  });

  it('includes other machines info from mappings', async () => {
    await fs.mkdir(path.join(config.storeReposPath, 'shared-project'), { recursive: true });

    // Set up machines.json with another machine's mapping
    const data: MachinesFile = {
      machines: {
        [OTHER_MACHINE_ID]: { name: 'Other PC', lastSeen: '2025-01-01T00:00:00Z' },
      },
      repos: {
        'repos/shared-project': {
          [OTHER_MACHINE_ID]: { localPath: '/other/path/project' },
        },
      },
      services: {},
    };
    writeMachinesFile(data);

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(1);
    expect(result[0].otherMachines).toHaveLength(1);
    expect(result[0].otherMachines[0].machineName).toBe('Other PC');
    expect(result[0].otherMachines[0].localPath).toBe('/other/path/project');
  });

  it('sets suggestedPath when current machine has a mapping', async () => {
    const targetDir = path.join(tmpDir, 'target-project');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'my-project'), { recursive: true });

    const data: MachinesFile = {
      machines: {},
      repos: { 'repos/my-project': { [MACHINE_ID]: { localPath: targetDir } } },
      services: {},
    };
    writeMachinesFile(data);

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(1);
    expect(result[0].suggestedPath).toBe(targetDir);
    expect(result[0].pathExists).toBe(true);
  });

  it('sets pathExists=false when suggested path does not exist', async () => {
    await fs.mkdir(path.join(config.storeReposPath, 'my-project'), { recursive: true });

    const data: MachinesFile = {
      machines: {},
      repos: { 'repos/my-project': { [MACHINE_ID]: { localPath: '/nonexistent/path' } } },
      services: {},
    };
    writeMachinesFile(data);

    const result = await getUnlinkedStoreRepos(db);
    expect(result).toHaveLength(1);
    expect(result[0].suggestedPath).toBe('/nonexistent/path');
    expect(result[0].pathExists).toBe(false);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  getUnlinkedStoreServices                                           ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('getUnlinkedStoreServices', () => {
  it('detects an unlinked store service', async () => {
    await fs.mkdir(path.join(config.storeServicesPath, 'claude-code'), { recursive: true });

    const result = await getUnlinkedStoreServices(db);
    expect(result).toHaveLength(1);
    expect(result[0].storePath).toBe('services/claude-code');
    expect(result[0].serviceType).toBe('claude-code');
  });

  it('skips services already registered in DB', async () => {
    await fs.mkdir(path.join(config.storeServicesPath, 'claude-code'), { recursive: true });
    db.prepare(
      "INSERT INTO service_configs (id, service_type, name, local_path, store_path, status) VALUES (?, ?, ?, ?, ?, 'active')",
    ).run('s1', 'claude-code', 'Claude Code', '/home/.claude', 'services/claude-code');

    const result = await getUnlinkedStoreServices(db);
    expect(result).toHaveLength(0);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  autoLinkRepos                                                      ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('autoLinkRepos', () => {
  it('auto-links repos with valid path mappings', async () => {
    const targetDir = path.join(tmpDir, 'target-project');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'my-project'), { recursive: true });

    // Set up a mapping for the current machine
    const data: MachinesFile = {
      machines: { [MACHINE_ID]: { name: MACHINE_NAME, lastSeen: '2025-01-01T00:00:00Z' } },
      repos: { 'repos/my-project': { [MACHINE_ID]: { localPath: targetDir } } },
      services: {},
    };
    writeMachinesFile(data);

    const results = await autoLinkRepos(db);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('linked');
    expect(results[0].storePath).toBe('repos/my-project');

    // Verify repo is now in DB
    const repo = db.prepare('SELECT * FROM repos WHERE store_path = ?').get('repos/my-project');
    expect(repo).toBeDefined();
  });

  it('returns path_missing when path does not exist', async () => {
    await fs.mkdir(path.join(config.storeReposPath, 'missing-project'), { recursive: true });

    const data: MachinesFile = {
      machines: {},
      repos: {
        'repos/missing-project': { [MACHINE_ID]: { localPath: '/nonexistent/path' } },
      },
      services: {},
    };
    writeMachinesFile(data);

    const results = await autoLinkRepos(db);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('path_missing');
  });

  it('returns already_registered when local_path is already in DB', async () => {
    const targetDir = path.join(tmpDir, 'target-project');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'dup-project'), { recursive: true });

    // Register the local_path with a different store path
    db.prepare(
      "INSERT INTO repos (id, name, local_path, store_path, status) VALUES (?, ?, ?, ?, 'active')",
    ).run('r-existing', 'existing', targetDir, 'repos/existing');

    const data: MachinesFile = {
      machines: {},
      repos: { 'repos/dup-project': { [MACHINE_ID]: { localPath: targetDir } } },
      services: {},
    };
    writeMachinesFile(data);

    const results = await autoLinkRepos(db);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('already_registered');
  });

  it('skips repos without a mapping for current machine', async () => {
    await fs.mkdir(path.join(config.storeReposPath, 'other-only'), { recursive: true });

    const data: MachinesFile = {
      machines: {},
      repos: {
        'repos/other-only': { [OTHER_MACHINE_ID]: { localPath: '/other/path' } },
      },
      services: {},
    };
    writeMachinesFile(data);

    const results = await autoLinkRepos(db);
    expect(results).toHaveLength(0);
  });

  it('links multiple repos in one call', async () => {
    const dir1 = path.join(tmpDir, 'project-1');
    const dir2 = path.join(tmpDir, 'project-2');
    await fs.mkdir(dir1, { recursive: true });
    await fs.mkdir(dir2, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'project-1'), { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'project-2'), { recursive: true });

    const data: MachinesFile = {
      machines: {},
      repos: {
        'repos/project-1': { [MACHINE_ID]: { localPath: dir1 } },
        'repos/project-2': { [MACHINE_ID]: { localPath: dir2 } },
      },
      services: {},
    };
    writeMachinesFile(data);

    const results = await autoLinkRepos(db);
    const linked = results.filter((r) => r.status === 'linked');
    expect(linked).toHaveLength(2);

    // Both repos should be in DB now
    const repos = db.prepare('SELECT * FROM repos').all();
    expect(repos).toHaveLength(2);
  });
});

// ╔═══════════════════════════════════════════════════════════════════════╗
// ║  linkStoreRepo                                                      ║
// ╚═══════════════════════════════════════════════════════════════════════╝
describe('linkStoreRepo', () => {
  it('registers repo in DB and updates machines.json', async () => {
    const targetDir = path.join(tmpDir, 'target');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'my-repo'), { recursive: true });

    const repoId = await linkStoreRepo(db, 'repos/my-repo', targetDir, 'My Repo');

    // Verify DB entry
    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as Record<
      string,
      string
    >;
    expect(repo).toBeDefined();
    expect(repo.name).toBe('My Repo');
    expect(repo.local_path).toBe(targetDir);
    expect(repo.store_path).toBe('repos/my-repo');
    expect(repo.status).toBe('active');

    // Verify machines.json mapping
    const data = readMachinesFile();
    expect(data.repos['repos/my-repo'][MACHINE_ID].localPath).toBe(targetDir);
  });

  it('copies store-only files to target', async () => {
    const targetDir = path.join(tmpDir, 'target');
    await fs.mkdir(targetDir, { recursive: true });
    const storeDir = path.join(config.storeReposPath, 'my-repo');
    await fs.mkdir(storeDir, { recursive: true });

    // Create a file in store that's not in target
    await fs.writeFile(path.join(storeDir, 'CLAUDE.md'), '# My config', 'utf-8');

    await linkStoreRepo(db, 'repos/my-repo', targetDir);

    // File should be copied to target
    const content = await fs.readFile(path.join(targetDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toBe('# My config');

    // Should be tracked in DB
    const files = db.prepare('SELECT * FROM tracked_files').all();
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it('uses store name when no name provided', async () => {
    const targetDir = path.join(tmpDir, 'target');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(config.storeReposPath, 'my-repo'), { recursive: true });

    const repoId = await linkStoreRepo(db, 'repos/my-repo', targetDir);

    const repo = db.prepare('SELECT * FROM repos WHERE id = ?').get(repoId) as Record<
      string,
      string
    >;
    expect(repo.name).toBe('my-repo');
  });
});
