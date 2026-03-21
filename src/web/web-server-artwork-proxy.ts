import { lookup as dnsLookup } from 'dns/promises';
import type { ServerResponse } from 'http';
import { isIP } from 'net';
import { sendJson } from './web-server-helpers.js';

const FETCH_TIMEOUT_MS = 5000;
const MAX_ARTWORK_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const PROXY_CACHE_CONTROL = 'public, max-age=300';

type ArtworkLookupResult = Array<{ address: string; family: number }>;

interface ArtworkProxyDependencies {
  fetch: typeof fetch;
  lookup: (hostname: string, options: { all: true; verbatim: boolean }) => Promise<ArtworkLookupResult>;
}

const defaultDependencies: ArtworkProxyDependencies = {
  fetch: async (input, init) => await globalThis.fetch(input, init),
  lookup: async (hostname, options) => await dnsLookup(hostname, options),
};

async function getArtworkSource(
  url: URL,
  dependencies: ArtworkProxyDependencies = defaultDependencies,
): Promise<string | null> {
  const source = url.searchParams.get('src');
  if (!source) {
    return null;
  }

  try {
    const parsed = new URL(source);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (await isBlockedArtworkUrl(parsed, dependencies)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export async function handleArtworkProxy(url: URL, response: ServerResponse): Promise<void> {
  const source = await getArtworkSource(url);
  if (!source) {
    sendJson(response, { message: 'src must be a valid http or https URL' }, 400);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetchArtworkResponse(source, controller, defaultDependencies);
    clearTimeout(timeout);

    if (!upstream.ok) {
      sendJson(response, { message: 'Artwork fetch failed.' }, 502);
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
    if (!contentType.toLowerCase().startsWith('image/')) {
      sendJson(response, { message: 'Artwork source must be an image.' }, 502);
      return;
    }

    const contentLength = Number(upstream.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_ARTWORK_BYTES) {
      sendJson(response, { message: 'Artwork fetch failed.' }, 413);
      return;
    }

    const buffer = await readArtworkBuffer(upstream);
    response.writeHead(200, {
      'Cache-Control': PROXY_CACHE_CONTROL,
      'Content-Length': buffer.byteLength,
      'Content-Type': contentType,
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    response.end(buffer);
  } catch (error) {
    clearTimeout(timeout);
    console.error('[web-server] Artwork proxy failed', { error: (error as Error).message });
    sendJson(
      response,
      { message: (error as Error).message === 'Artwork too large.' ? 'Artwork fetch failed.' : 'Artwork fetch failed.' },
      (error as Error).message === 'Artwork too large.' ? 413 : 502,
    );
  }
}

async function fetchArtworkResponse(
  source: string,
  controller: AbortController,
  dependencies: ArtworkProxyDependencies,
  redirectCount = 0,
): Promise<Response> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error('Too many artwork redirects.');
  }

  const upstream = await dependencies.fetch(source, {
    signal: controller.signal,
    headers: { 'User-Agent': 'agentune-dashboard/0.1' },
    redirect: 'manual',
  });
  if (!isRedirectResponse(upstream.status)) {
    return upstream;
  }

  const location = upstream.headers.get('location');
  if (!location) {
    throw new Error('Artwork redirect missing location.');
  }

  const nextUrl = new URL(location, source);
  if (await isBlockedArtworkUrl(nextUrl, dependencies)) {
    throw new Error('Artwork redirect blocked.');
  }

  return await fetchArtworkResponse(nextUrl.toString(), controller, dependencies, redirectCount + 1);
}

async function readArtworkBuffer(upstream: Response): Promise<Buffer> {
  const reader = upstream.body?.getReader();
  if (!reader) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    totalSize += chunk.length;
    if (totalSize > MAX_ARTWORK_BYTES) {
      throw new Error('Artwork too large.');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

export async function isBlockedArtworkUrl(
  url: URL,
  dependencies: ArtworkProxyDependencies = defaultDependencies,
): Promise<boolean> {
  const normalized = url.hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    return isBlockedIpv4(normalized);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(normalized);
  }

  try {
    const records = await dependencies.lookup(normalized, { all: true, verbatim: true });
    if (records.length === 0) {
      return true;
    }

    return records.some((record) => {
      if (record.family === 4) {
        return isBlockedIpv4(record.address);
      }
      if (record.family === 6) {
        return isBlockedIpv6(record.address.toLowerCase());
      }
      return true;
    });
  } catch {
    return true;
  }
}

function isBlockedIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map((segment) => Number(segment));
  if (octets.length !== 4 || octets.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 255)) {
    return true;
  }

  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || first === 169 && second === 254
    || first === 172 && second >= 16 && second <= 31
    || first === 192 && second === 168;
}

function isBlockedIpv6(hostname: string): boolean {
  return hostname === '::1'
    || hostname === '::'
    || hostname.startsWith('fc')
    || hostname.startsWith('fd')
    || hostname.startsWith('fe80:');
}

function isRedirectResponse(status: number): boolean {
  return status === 301
    || status === 302
    || status === 303
    || status === 307
    || status === 308;
}
