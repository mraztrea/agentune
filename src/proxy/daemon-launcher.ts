// Daemon discovery + optional auto-start for proxy/manual CLI flows.

import { spawn } from 'child_process';
import { closeSync, openSync } from 'fs';
import { fileURLToPath } from 'url';
import { type DaemonInfo, readPidFile, isDaemonRunning } from '../daemon/pid-manager.js';
import { loadRuntimeConfig } from '../runtime/runtime-config.js';
import { getDaemonLogPath } from '../runtime/runtime-data-paths.js';

const HEALTH_POLL_INTERVAL = 200; // ms
const HEALTH_POLL_TIMEOUT = 10_000; // ms

export interface EnsureDaemonOptions {
  allowSpawn?: boolean;
}

export interface EnsureDaemonResult {
  controlToken: string;
  port: number;
  started: boolean;
}

interface DaemonLauncherDependencies {
  checkHealth: (port: number) => Promise<boolean>;
  getDaemonLogPath: typeof getDaemonLogPath;
  isDaemonRunning: typeof isDaemonRunning;
  loadRuntimeConfig: typeof loadRuntimeConfig;
  now: () => number;
  readPidFile: typeof readPidFile;
  sleep: (ms: number) => Promise<void>;
  spawnDaemon: () => void;
}

/** Ensure daemon is running; start it if allowed and missing. */
export async function ensureDaemon(
  options?: EnsureDaemonOptions,
  dependencies: DaemonLauncherDependencies = createDaemonLauncherDependencies(),
): Promise<EnsureDaemonResult> {
  const allowSpawn = options?.allowSpawn ?? true;
  const { daemonPort } = dependencies.loadRuntimeConfig();

  // Check if already running via PID file + health check
  const check = dependencies.isDaemonRunning();
  if (check.running && check.info) {
    const healthy = await dependencies.checkHealth(check.info.port);
    if (healthy) return {
      controlToken: check.info.controlToken,
      port: check.info.port,
      started: false,
    };
  }

  if (!allowSpawn) {
    throw new Error('Daemon is not running. Start it with "agentune start".');
  }

  dependencies.spawnDaemon();
  return await waitForHealth(daemonPort, dependencies);
}

function spawnDetachedDaemon(): void {
  const entryPoint = resolveDaemonEntryPoint();
  const logPath = getDaemonLogPath();
  const logFd = openSync(logPath, 'w');

  const child = spawn(process.execPath, [entryPoint, '--daemon'], {
    // Keep the daemon alive after the proxy terminal exits on every platform.
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(logFd);
}

export function resolveDaemonEntryPoint(): string {
  return fileURLToPath(new URL('../index.js', import.meta.url));
}

async function waitForHealth(
  expectedPort: number,
  dependencies: DaemonLauncherDependencies,
): Promise<EnsureDaemonResult> {
  const deadline = dependencies.now() + HEALTH_POLL_TIMEOUT;
  while (dependencies.now() < deadline) {
    const info = dependencies.readPidFile();
    const port = info?.port ?? expectedPort;
    if (info?.controlToken && await dependencies.checkHealth(port)) {
      return {
        controlToken: info.controlToken,
        port,
        started: true,
      };
    }
    await dependencies.sleep(HEALTH_POLL_INTERVAL);
  }
  throw new Error(`Daemon failed to start within 10s. Check ${dependencies.getDaemonLogPath()}`);
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function createDaemonLauncherDependencies(): DaemonLauncherDependencies {
  return {
    checkHealth,
    getDaemonLogPath,
    isDaemonRunning,
    loadRuntimeConfig,
    now: () => Date.now(),
    readPidFile,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    spawnDaemon: spawnDetachedDaemon,
  };
}
