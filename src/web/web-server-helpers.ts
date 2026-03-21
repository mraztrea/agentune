import { exec } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import { extname } from 'path';

const MAX_JSON_BODY_SIZE = 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml; charset=utf-8',
};

export function getMimeType(filePath: string): string {
  return MIME_TYPES[extname(filePath)] ?? 'application/octet-stream';
}

export function sendJson(response: ServerResponse, payload: unknown, statusCode = 200): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

export function openUrl(url: string): void {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`);
    return;
  }

  if (process.platform === 'darwin') {
    exec(`open "${url}"`);
    return;
  }

  exec(`xdg-open "${url}"`);
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse((await readRequestBody(request)).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readVolumeRequest(request: IncomingMessage): Promise<{ volume: number } | null> {
  try {
    const parsed = JSON.parse((await readRequestBody(request)).toString('utf8')) as { volume?: number };
    if (typeof parsed.volume !== 'number' || !Number.isFinite(parsed.volume)) {
      return null;
    }

    return { volume: clampVolume(parsed.volume) };
  } catch {
    return null;
  }
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of request) {
    const nextChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += nextChunk.length;
    if (totalSize > MAX_JSON_BODY_SIZE) {
      throw new Error('Request body too large.');
    }
    chunks.push(nextChunk);
  }

  return Buffer.concat(chunks);
}

function clampVolume(level: number): number {
  return Math.max(0, Math.min(100, Math.round(level)));
}
