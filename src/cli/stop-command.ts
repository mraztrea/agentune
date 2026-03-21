// CLI stop command — gracefully stop the running daemon
// Falls back to SIGTERM if HTTP shutdown endpoint fails

import { spawnSync } from 'child_process';
import { DAEMON_CONTROL_TOKEN_HEADER } from '../daemon/daemon-auth.js';
import { readPidFile, removePidFile } from '../daemon/pid-manager.js';

const STOP_POLL_INTERVAL_MS = 200;
const STOP_TIMEOUT_MS = 10_000;

interface StopCommandDependencies {
  fetch: typeof fetch;
  getProcessCommand: (pid: number) => string | null;
  isProcessAlive: (pid: number) => boolean;
  killProcess: (pid: number) => void;
  log: (message: string) => void;
  now: () => number;
  readPidFile: typeof readPidFile;
  removePidFile: typeof removePidFile;
  sleep: (ms: number) => Promise<void>;
}

export async function runStop(
  dependencies: StopCommandDependencies = createStopCommandDependencies(),
): Promise<void> {
  const info = dependencies.readPidFile();
  if (!info) {
    dependencies.log('[agentune] Daemon is not running');
    return;
  }

  if (await requestShutdown(info.port, dependencies)) {
    if (await waitForDaemonStop(info.pid, info.port, dependencies)) {
      dependencies.log('[agentune] Daemon stopped');
      return;
    }

    dependencies.log('[agentune] HTTP shutdown timed out; attempting verified process stop');
  } else {
    dependencies.log('[agentune] Failed to stop daemon via HTTP, checking process identity');
  }

  if (!await tryVerifiedKill(info.pid, info.port, dependencies)) {
    dependencies.log('[agentune] Could not verify daemon process identity; refusing to send SIGTERM.');
    return;
  }

  if (await waitForDaemonStop(info.pid, info.port, dependencies)) {
    dependencies.log('[agentune] Daemon stopped');
    return;
  }

  dependencies.log('[agentune] Daemon stop timed out after SIGTERM.');
}

async function requestShutdown(port: number, dependencies: StopCommandDependencies): Promise<boolean> {
  const controlToken = dependencies.readPidFile()?.controlToken;
  if (!controlToken) {
    return false;
  }

  try {
    const response = await dependencies.fetch(`http://127.0.0.1:${port}/shutdown`, {
      headers: {
        [DAEMON_CONTROL_TOKEN_HEADER]: controlToken,
      },
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function tryVerifiedKill(
  pid: number,
  port: number,
  dependencies: StopCommandDependencies,
): Promise<boolean> {
  const commandLine = dependencies.getProcessCommand(pid);
  if (!commandLine) {
    if (!dependencies.isProcessAlive(pid)) {
      if (dependencies.readPidFile()?.pid === pid && dependencies.readPidFile()?.port === port) {
        dependencies.removePidFile();
      }
      return true;
    }
    return false;
  }

  if (!looksLikeDaemonCommand(commandLine)) {
    return false;
  }

  try {
    dependencies.killProcess(pid);
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemonStop(
  pid: number,
  port: number,
  dependencies: StopCommandDependencies,
): Promise<boolean> {
  const deadline = dependencies.now() + STOP_TIMEOUT_MS;

  while (dependencies.now() < deadline) {
    const currentPidFile = dependencies.readPidFile();
    const commandLine = dependencies.getProcessCommand(pid);
    const processAlive = dependencies.isProcessAlive(pid);
    const pidFileMatches = currentPidFile?.pid === pid && currentPidFile.port === port;

    if (!processAlive || !commandLine) {
      if (pidFileMatches) {
        dependencies.removePidFile();
      }
      return true;
    }

    if (!looksLikeDaemonCommand(commandLine)) {
      if (pidFileMatches) {
        dependencies.removePidFile();
      }
      return true;
    }

    await dependencies.sleep(STOP_POLL_INTERVAL_MS);
  }

  return false;
}

function looksLikeDaemonCommand(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase();
  return normalized.includes('--daemon')
    && (
      normalized.includes('agentune')
      || normalized.includes('dist/index.js')
      || normalized.includes('dist\\index.js')
      || normalized.includes('src/index.ts')
      || normalized.includes('src\\index.ts')
    );
}

function createStopCommandDependencies(): StopCommandDependencies {
  return {
    fetch,
    getProcessCommand,
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    killProcess: (pid) => {
      process.kill(pid, 'SIGTERM');
    },
    log: (message) => {
      console.error(message);
    },
    now: () => Date.now(),
    readPidFile,
    removePidFile,
    sleep: async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function getProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -ne $p) { [Console]::Out.Write($p.CommandLine) }`,
        ],
        { encoding: 'utf8' },
      );
      return result.status === 0 ? result.stdout.trim() || null : null;
    }

    const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() || null : null;
  } catch {
    return null;
  }
}
