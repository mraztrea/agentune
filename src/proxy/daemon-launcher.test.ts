import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureDaemon, resolveDaemonEntryPoint } from './daemon-launcher.js';

test('ensureDaemon returns the healthy running daemon without spawning', async () => {
  let spawnCount = 0;

  const result = await ensureDaemon(
    { allowSpawn: false },
    {
      checkHealth: async (port) => port === 4010,
      getDaemonLogPath: () => 'daemon.log',
        isDaemonRunning: () => ({
          running: true,
          info: { controlToken: 'daemon-token', pid: 11, port: 4010, started: '2026-03-20T00:00:00.000Z' },
        }),
      loadRuntimeConfig: () => ({
        dashboardPort: 3737,
        daemonPort: 3747,
        defaultVolume: 80,
        autoStartDaemon: true,
        discoverRanking: { exploration: 0.35, variety: 0.55, loyalty: 0.65 },
      }),
      now: () => 0,
      readPidFile: () => null,
      sleep: async () => {},
      spawnDaemon: () => {
        spawnCount += 1;
      },
    },
  );

  assert.deepEqual(result, { controlToken: 'daemon-token', port: 4010, started: false });
  assert.equal(spawnCount, 0);
});

test('ensureDaemon fails fast when spawning is disabled and no healthy daemon exists', async () => {
  let spawnCount = 0;

  await assert.rejects(
    () =>
      ensureDaemon(
        { allowSpawn: false },
        {
          checkHealth: async () => false,
          getDaemonLogPath: () => 'daemon.log',
          isDaemonRunning: () => ({ running: false, info: null }),
          loadRuntimeConfig: () => ({
            dashboardPort: 3737,
            daemonPort: 3747,
            defaultVolume: 80,
            autoStartDaemon: false,
            discoverRanking: { exploration: 0.35, variety: 0.55, loyalty: 0.65 },
          }),
          now: () => 0,
          readPidFile: () => null,
          sleep: async () => {},
          spawnDaemon: () => {
            spawnCount += 1;
          },
        },
      ),
    /Start it with "agentune start"/i,
  );

  assert.equal(spawnCount, 0);
});

test('ensureDaemon spawns and waits for health when allowed', async () => {
  let currentTime = 0;
  let spawned = false;

  const result = await ensureDaemon(
    { allowSpawn: true },
    {
      checkHealth: async (port) => spawned && port === 4555,
      getDaemonLogPath: () => 'daemon.log',
      isDaemonRunning: () => ({ running: false, info: null }),
      loadRuntimeConfig: () => ({
        dashboardPort: 3737,
        daemonPort: 3747,
        defaultVolume: 80,
        autoStartDaemon: true,
        discoverRanking: { exploration: 0.35, variety: 0.55, loyalty: 0.65 },
      }),
      now: () => currentTime,
        readPidFile: () => (
          spawned
            ? { controlToken: 'spawned-token', pid: 22, port: 4555, started: '2026-03-20T00:00:00.000Z' }
            : null
        ),
      sleep: async () => {
        currentTime += 200;
      },
      spawnDaemon: () => {
        spawned = true;
      },
    },
  );

  assert.deepEqual(result, { controlToken: 'spawned-token', port: 4555, started: true });
});

test('resolveDaemonEntryPoint targets the built index entry', () => {
  const entryPoint = resolveDaemonEntryPoint();
  assert.match(entryPoint.replaceAll('\\', '/'), /\/dist\/index\.js$/);
});
