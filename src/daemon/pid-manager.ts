import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { getPidFilePath } from '../runtime/runtime-data-paths.js';
// PID file management for singleton daemon discovery.

export interface DaemonInfo {
  controlToken: string;
  pid: number;
  port: number;
  started: string;
}

/** Write current PID + port + ISO timestamp to PID file */
export function writePidFile(port: number, controlToken: string): void {
  const info: DaemonInfo = {
    controlToken,
    pid: process.pid,
    port,
    started: new Date().toISOString(),
  };
  writeFileSync(getPidFilePath(), JSON.stringify(info), 'utf8');
}

/** Read + parse PID file; returns null if missing or corrupt */
export function readPidFile(): DaemonInfo | null {
  try {
    const raw = readFileSync(getPidFilePath(), 'utf8');
    return JSON.parse(raw) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Remove PID file; ignores ENOENT */
export function removePidFile(): void {
  try {
    unlinkSync(getPidFilePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Check if daemon is running by reading PID file and signaling process */
export function isDaemonRunning(): { running: boolean; info: DaemonInfo | null } {
  const info = readPidFile();
  if (!info) return { running: false, info: null };

  try {
    process.kill(info.pid, 0);
    return { running: true, info };
  } catch {
    // Process is dead — remove stale file
    removePidFile();
    return { running: false, info: null };
  }
}
