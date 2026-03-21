// HTTP server for daemon IPC — binds to the configured daemon port.
// Routes: GET /health, POST /shutdown, /mcp (POST/GET/DELETE)

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { handleHealthRequest } from './health-endpoint.js';
import { DAEMON_CONTROL_TOKEN_HEADER, hasValidDaemonControlToken } from './daemon-auth.js';
import { createHttpMcpHandler } from '../mcp/mcp-server.js';

export class DaemonServer {
  private server: Server | null = null;
  private mcpHandler: ReturnType<typeof createHttpMcpHandler> | null = null;
  private shutdownFn: ((reason: string) => void) | null = null;

  constructor(
    private readonly port: number,
    private readonly controlToken: string,
  ) {}

  setShutdownHandler(fn: (reason: string) => void): void {
    this.shutdownFn = fn;
  }

  async start(): Promise<number> {
    this.mcpHandler = createHttpMcpHandler();
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      // Route: GET /health
      if (req.method === 'GET' && url.pathname === '/health') {
        handleHealthRequest(req, res, this.port);
        return;
      }

      // Route: POST /shutdown
      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (!this.hasValidControlToken(req)) {
          sendJson(res, { error: 'Forbidden' }, 403);
          return;
        }
        sendJson(res, { status: 'shutting_down' });
        setTimeout(() => this.shutdownFn?.('HTTP /shutdown'), 100);
        return;
      }

      // Route: /mcp (POST, GET, DELETE)
      if (url.pathname === '/mcp') {
        if (!this.hasValidControlToken(req)) {
          sendJson(res, { error: 'Forbidden' }, 403);
          return;
        }
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        await this.mcpHandler!.handleRequest(req, res, body);
        return;
      }

      // 404
      res.writeHead(404);
      res.end('Not Found');
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        resolve(this.port);
      });
      this.server!.on('error', reject);
    });
  }

  async destroy(): Promise<void> {
    this.shutdownFn = null; // disarm to prevent double-shutdown from transport onclose
    await this.mcpHandler?.close();
    return new Promise((resolve) => {
      if (!this.server) { resolve(); return; }
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  getPort(): number {
    return this.port;
  }

  private hasValidControlToken(req: IncomingMessage): boolean {
    return hasValidDaemonControlToken(req.headers[DAEMON_CONTROL_TOKEN_HEADER.toLowerCase()], this.controlToken);
  }
}

function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const MAX_BODY_SIZE = 1024 * 1024; // 1MB — MCP messages are small JSON

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}
