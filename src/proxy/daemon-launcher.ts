// Auto-start daemon if not running, wait for health check
// Spawns the daemon process detached and polls until healthy

import { spawn } from 'child_process';
import { openSync, closeSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { readPidFile, isDaemonRunning } from '../daemon/pid-manager.js';

const HEALTH_POLL_INTERVAL = 200; // ms
const HEALTH_POLL_TIMEOUT = 10_000; // ms
const DEFAULT_DAEMON_PORT = 3747;

/** Ensure daemon is running; start it if not. Returns port on success. */
export async function ensureDaemon(): Promise<{ port: number }> {
  // Check if already running via PID file + health check
  const check = isDaemonRunning();
  if (check.running && check.info) {
    const healthy = await checkHealth(check.info.port);
    if (healthy) return { port: check.info.port };
  }

  // Spawn detached daemon
  spawnDaemon();

  // Wait for health
  return await waitForHealth();
}

function spawnDaemon(): void {
  const entryPoint = process.argv[1]; // dist/index.js
  const sbotifyDir = join(homedir(), '.sbotify');
  mkdirSync(sbotifyDir, { recursive: true });
  const logPath = join(sbotifyDir, 'daemon.log');
  const logFd = openSync(logPath, 'w');

  const child = spawn(process.execPath, [entryPoint, '--daemon'], {
    detached: process.platform !== 'win32', // Unix: setsid for session independence; Windows: skip to avoid console popup
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  closeSync(logFd);
}

async function waitForHealth(): Promise<{ port: number }> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT;
  while (Date.now() < deadline) {
    const info = readPidFile();
    const port = info?.port ?? DEFAULT_DAEMON_PORT;
    if (await checkHealth(port)) return { port };
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL));
  }
  throw new Error('Daemon failed to start within 10s. Check ~/.sbotify/daemon.log');
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
