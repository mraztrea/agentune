import { randomBytes, timingSafeEqual } from 'crypto';
import type { IncomingHttpHeaders } from 'http';

export const DASHBOARD_TOKEN_HEADER = 'X-Agentune-Dashboard-Token';
export const DASHBOARD_TOKEN_QUERY_PARAM = 'dashboardToken';
export const DASHBOARD_TOKEN_META_NAME = 'agentune-dashboard-token';
export const DASHBOARD_SESSION_EXPIRED_MESSAGE = 'Dashboard session expired. Refresh page.';

export function createDashboardSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hasValidDashboardHeaderToken(headers: IncomingHttpHeaders, expectedToken: string): boolean {
  return hasMatchingToken(headers[DASHBOARD_TOKEN_HEADER.toLowerCase()], expectedToken);
}

export function hasValidDashboardQueryToken(url: URL, expectedToken: string): boolean {
  return hasMatchingToken(url.searchParams.get(DASHBOARD_TOKEN_QUERY_PARAM) ?? undefined, expectedToken);
}

export function isAllowedDashboardMutationRequest(headers: IncomingHttpHeaders): boolean {
  return isSameOriginRequest(headers);
}

export function isAllowedDashboardSocketRequest(url: URL, headers: IncomingHttpHeaders, expectedToken: string): boolean {
  return hasValidDashboardQueryToken(url, expectedToken) && isSameOriginRequest(headers);
}

export function renderDashboardHtml(template: string, token: string): string {
  const tokenMetaTag = `    <meta name="${DASHBOARD_TOKEN_META_NAME}" content="${token}" />`;
  if (template.includes(`name="${DASHBOARD_TOKEN_META_NAME}"`)) {
    return template;
  }

  return template.includes('</head>')
    ? template.replace('</head>', `${tokenMetaTag}\n  </head>`)
    : `${tokenMetaTag}\n${template}`;
}

function hasMatchingToken(rawValue: string | string[] | undefined, expectedToken: string): boolean {
  const candidate = normalizeHeaderValue(rawValue);
  if (!candidate) {
    return false;
  }

  const expectedBuffer = Buffer.from(expectedToken);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length
    && timingSafeEqual(expectedBuffer, candidateBuffer);
}

function isSameOriginRequest(headers: IncomingHttpHeaders): boolean {
  const origin = normalizeHeaderValue(headers.origin);
  const host = normalizeHeaderValue(headers.host);
  if (!origin || !host) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    return (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:')
      && parsedOrigin.host === host;
  } catch {
    return false;
  }
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
