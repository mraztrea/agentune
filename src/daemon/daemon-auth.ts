import { randomBytes, timingSafeEqual } from 'crypto';

export const DAEMON_CONTROL_TOKEN_HEADER = 'X-Agentune-Daemon-Token';

export function createDaemonControlToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hasValidDaemonControlToken(headerValue: string | string[] | undefined, expectedToken: string): boolean {
  const candidate = normalizeHeaderValue(headerValue);
  if (!candidate) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedToken);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length
    && timingSafeEqual(expectedBuffer, candidateBuffer);
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return null;
}
