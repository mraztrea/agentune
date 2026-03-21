import assert from 'node:assert/strict';
import test from 'node:test';
import { DAEMON_CONTROL_TOKEN_HEADER } from '../daemon/daemon-auth.js';
import { runStop } from './stop-command.js';

test('runStop exits early when no daemon pid file exists', async () => {
  const logs: string[] = [];

  await runStop({
    fetch: async () => new Response(),
    getProcessCommand: () => null,
    isProcessAlive: () => false,
    killProcess: () => {
      throw new Error('kill should not be called');
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => 0,
    readPidFile: () => null,
    removePidFile: () => {},
    sleep: async () => {},
  });

  assert.deepEqual(logs, ['[agentune] Daemon is not running']);
});

test('runStop waits for graceful HTTP shutdown before reporting success', async () => {
  const logs: string[] = [];
  const requests: RequestInit[] = [];
  let readCount = 0;

  await runStop({
    fetch: async (_input, init) => {
      requests.push(init ?? {});
      return new Response(null, { status: 200 });
    },
    getProcessCommand: () => (readCount < 2 ? 'node dist/index.js --daemon agentune' : null),
    isProcessAlive: () => readCount < 2,
    killProcess: () => {
      throw new Error('kill should not be called');
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => readCount * 200,
    readPidFile: () => {
      readCount += 1;
      return readCount < 3
        ? { controlToken: 'shutdown-token', pid: 101, port: 3747, started: '2026-03-21T00:00:00.000Z' }
        : null;
    },
    removePidFile: () => {},
    sleep: async () => {},
  });

  assert.equal(logs.at(-1), '[agentune] Daemon stopped');
  assert.equal((requests[0]?.headers as Record<string, string>)[DAEMON_CONTROL_TOKEN_HEADER], 'shutdown-token');
});

test('runStop falls back to verified process kill when HTTP shutdown fails', async () => {
  const logs: string[] = [];
  let alive = true;
  let removedPidFile = false;
  let killCount = 0;

  await runStop({
    fetch: async () => {
      throw new Error('connect failed');
    },
    getProcessCommand: () => (alive ? 'node C:/repo/agentune/dist/index.js --daemon' : null),
    isProcessAlive: () => alive,
    killProcess: () => {
      killCount += 1;
      alive = false;
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => (alive ? 0 : 200),
    readPidFile: () => (alive ? { controlToken: 'kill-token', pid: 202, port: 3747, started: '2026-03-21T00:00:00.000Z' } : null),
    removePidFile: () => {
      removedPidFile = true;
    },
    sleep: async () => {},
  });

  assert.equal(killCount, 1);
  assert.equal(removedPidFile, false);
  assert.equal(logs.at(-1), '[agentune] Daemon stopped');
});

test('runStop refuses to kill an unverified process when HTTP shutdown fails', async () => {
  const logs: string[] = [];
  let killCount = 0;

  await runStop({
    fetch: async () => {
      throw new Error('connect failed');
    },
    getProcessCommand: () => 'node other-app/index.js --daemon',
    isProcessAlive: () => true,
    killProcess: () => {
      killCount += 1;
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => 0,
    readPidFile: () => ({ controlToken: 'refuse-token', pid: 303, port: 3747, started: '2026-03-21T00:00:00.000Z' }),
    removePidFile: () => {},
    sleep: async () => {},
  });

  assert.equal(killCount, 0);
  assert.equal(logs.at(-1), '[agentune] Could not verify daemon process identity; refusing to send SIGTERM.');
});

test('runStop exits without HTTP shutdown when daemon token is missing', async () => {
  const logs: string[] = [];
  let fetchCount = 0;

  await runStop({
    fetch: async () => {
      fetchCount += 1;
      return new Response(null, { status: 200 });
    },
    getProcessCommand: () => 'node other-app/index.js --daemon',
    isProcessAlive: () => true,
    killProcess: () => {
      throw new Error('kill should not be called');
    },
    log: (message) => {
      logs.push(message);
    },
    now: () => 0,
    readPidFile: () => ({ controlToken: '', pid: 404, port: 3747, started: '2026-03-21T00:00:00.000Z' }),
    removePidFile: () => {},
    sleep: async () => {},
  });

  assert.equal(fetchCount, 0);
  assert.equal(logs.at(-1), '[agentune] Could not verify daemon process identity; refusing to send SIGTERM.');
});
