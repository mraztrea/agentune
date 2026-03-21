import assert from 'node:assert/strict';
import { EventEmitter } from 'events';
import { createServer } from 'http';
import test from 'node:test';
import { QueueManager } from '../queue/queue-manager.js';
import { isBlockedArtworkUrl } from './web-server-artwork-proxy.js';
import { getDashboardAuth } from './web-server-test-helpers.js';
import { createWebServer } from './web-server.js';

class ArtworkFakeMpv extends EventEmitter {
  getState(): { currentTrack: null; isPlaying: false; volume: number; isMuted: boolean } {
    return { currentTrack: null, isPlaying: false, volume: 80, isMuted: false };
  }

  isReady(): boolean {
    return false;
  }

  async getPosition(): Promise<number> {
    return 0;
  }

  getVolume(): number {
    return 80;
  }

  getIsMuted(): boolean {
    return false;
  }
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port.')));
        return;
      }
      const { port } = address;
      server.close((error?: Error | null) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

test('WebServer artwork proxy streams remote artwork with safe headers', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (target.startsWith(webServer.getDashboardUrl())) {
      return await originalFetch(input, init);
    }

    return new Response('proxy-image', {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    });
  };

  try {
    const source = 'https://example.com/art.png';
    const response = await fetch(
      `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent(source)}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(body, 'proxy-image');
  } finally {
    globalThis.fetch = originalFetch;
    await webServer.destroy();
  }
});

test('WebServer artwork proxy rejects invalid URLs', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);

  try {
    const response = await fetch(
      `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('file:///etc/passwd')}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const payload = await response.json() as { message: string };

    assert.equal(response.status, 400);
    assert.match(payload.message, /http or https/i);
  } finally {
    await webServer.destroy();
  }
});

test('WebServer artwork proxy reports upstream failures safely', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (target.startsWith(webServer.getDashboardUrl())) {
      return await originalFetch(input, init);
    }

    return new Response('missing', {
      status: 404,
      headers: { 'Content-Type': 'image/png' },
    });
  };

  try {
    const source = 'https://example.com/missing.png';
    const response = await fetch(
      `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent(source)}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const payload = await response.json() as { message: string };

    assert.equal(response.status, 502);
    assert.match(payload.message, /artwork fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
    await webServer.destroy();
  }
});

test('WebServer artwork proxy rejects local artwork hosts', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);

  try {
    const response = await fetch(
      `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('http://127.0.0.1:3737/art.png')}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const payload = await response.json() as { message: string };

    assert.equal(response.status, 400);
    assert.match(payload.message, /valid http or https url/i);
  } finally {
    await webServer.destroy();
  }
});

test('WebServer artwork proxy rejects non-image content types and oversized responses', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (target.startsWith(webServer.getDashboardUrl())) {
        return await originalFetch(input, init);
      }

      return new Response('<html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    };

    const nonImageResponse = await fetch(
        `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('https://example.com/not-image')}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const nonImagePayload = await nonImageResponse.json() as { message: string };
    assert.equal(nonImageResponse.status, 502);
    assert.match(nonImagePayload.message, /image/i);

    globalThis.fetch = async (input, init) => {
      const target = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (target.startsWith(webServer.getDashboardUrl())) {
        return await originalFetch(input, init);
      }

      return new Response('x'.repeat(5 * 1024 * 1024 + 1), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    };

    const oversizedResponse = await fetch(
        `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('https://example.com/large.png')}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const oversizedPayload = await oversizedResponse.json() as { message: string };
    assert.equal(oversizedResponse.status, 413);
    assert.match(oversizedPayload.message, /artwork fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
    await webServer.destroy();
  }
});

test('WebServer artwork proxy rejects redirects to blocked local targets', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();
  const auth = await getDashboardAuth(webServer);
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const target = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (target.startsWith(webServer.getDashboardUrl())) {
      return await originalFetch(input, init);
    }

    return new Response(null, {
      status: 302,
      headers: { Location: 'http://127.0.0.1:3737/private-art.png' },
    });
  };

  try {
    const response = await fetch(
      `${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('https://example.com/redirect-art.png')}&dashboardToken=${encodeURIComponent(auth.token)}`,
    );
    const payload = await response.json() as { message: string };

    assert.equal(response.status, 502);
    assert.match(payload.message, /artwork fetch failed/i);
  } finally {
    globalThis.fetch = originalFetch;
    await webServer.destroy();
  }
});

test('WebServer artwork proxy rejects missing dashboard token', async () => {
  const webServer = createWebServer(new ArtworkFakeMpv() as never, new QueueManager(), {
    port: await getAvailablePort(),
  });
  await webServer.waitUntilReady();

  try {
    const response = await fetch(`${webServer.getDashboardUrl()}/api/artwork?src=${encodeURIComponent('https://images.example.com/art.png')}`);
    assert.equal(response.status, 403);
  } finally {
    await webServer.destroy();
  }
});

test('isBlockedArtworkUrl rejects private DNS resolutions', async () => {
  const lookup = async (hostname: string) => {
    if (hostname === 'safe.example') {
      return [{ address: '203.0.113.10', family: 4 }];
    }
    if (hostname === 'private.example') {
      return [{ address: '127.0.0.1', family: 4 }];
    }
    throw new Error('unexpected lookup');
  };

  assert.equal(await isBlockedArtworkUrl(new URL('https://safe.example/art.png'), { fetch, lookup }), false);
  assert.equal(await isBlockedArtworkUrl(new URL('https://private.example/art.png'), { fetch, lookup }), true);
});
