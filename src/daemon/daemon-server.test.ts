import assert from 'node:assert/strict';
import { createServer } from 'http';
import test from 'node:test';
import { DAEMON_CONTROL_TOKEN_HEADER } from './daemon-auth.js';
import { DaemonServer } from './daemon-server.js';

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

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

test('DaemonServer requires control token for shutdown and mcp routes', async () => {
  const port = await getAvailablePort();
  const daemonServer = new DaemonServer(port, 'daemon-control-token');
  await daemonServer.start();

  try {
    const healthResponse = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthResponse.status, 200);

    const shutdownForbidden = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
    assert.equal(shutdownForbidden.status, 403);

    const mcpForbidden = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'initialize', id: 1, jsonrpc: '2.0', params: {} }),
    });
    assert.equal(mcpForbidden.status, 403);

    const shutdownAllowed = await fetch(`http://127.0.0.1:${port}/shutdown`, {
      method: 'POST',
      headers: {
        [DAEMON_CONTROL_TOKEN_HEADER]: 'daemon-control-token',
      },
    });
    assert.equal(shutdownAllowed.status, 200);
  } finally {
    await daemonServer.destroy();
  }
});
