// HTTP server for daemon IPC — binds to the configured daemon port.
// Routes: GET /health, POST /shutdown, /mcp (POST/GET/DELETE)

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { handleHealthRequest } from './health-endpoint.js';
import { createHttpMcpHandler } from '../mcp/mcp-server.js';

export class DaemonServer {
  private server: Server | null = null;
  private mcpHandler: ReturnType<typeof createHttpMcpHandler> | null = null;
  private shutdownFn: ((reason: string) => void) | null = null;

  constructor(private readonly port: number) {}

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
        sendJson(res, { status: 'shutting_down' });
        setTimeout(() => this.shutdownFn?.('HTTP /shutdown'), 100);
        return;
      }

      // Route: /mcp (POST, GET, DELETE)
      if (url.pathname === '/mcp') {
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
}

function sendJson(res: ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
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
