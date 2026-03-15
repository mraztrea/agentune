import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createReadStream, existsSync } from 'fs';
import { stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import type { MpvController } from '../audio/mpv-controller.js';
import type { QueueManager } from '../queue/queue-manager.js';
import { StateBroadcaster } from './state-broadcaster.js';
import {
  DEFAULT_PORT,
  MAX_PORT_ATTEMPTS,
  getMimeType,
  getStaticFilePath,
  openUrl,
  readVolumeRequest,
  sendJson,
} from './web-server-helpers.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export class WebServer {
  private readonly broadcaster: StateBroadcaster;
  private readonly readyPromise: Promise<void>;
  private readonly httpServer = createServer((request, response) => {
    void this.handleRequest(request, response).catch((error: Error) => {
      console.error('[web-server] Request failed', { error: error.message });
      if (!response.headersSent) {
        sendJson(response, { message: 'Internal server error' }, 500);
        return;
      }

      response.end();
    });
  });
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private dashboardOpened = false;
  private port = DEFAULT_PORT;

  constructor(
    private readonly mpv: MpvController,
    queueManager: QueueManager,
  ) {
    this.broadcaster = new StateBroadcaster(mpv, queueManager);
    this.readyPromise = this.start();

    this.wsServer.on('connection', (socket) => {
      this.sendState(socket);
      socket.on('message', (message) => {
        this.handleSocketMessage(message.toString());
      });
    });

    this.broadcaster.on('state', () => {
      this.broadcastState();
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws') {
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(request, socket, head, (client) => {
        this.wsServer.emit('connection', client, request);
      });
    });
  }

  openDashboardOnce(): void {
    if (this.dashboardOpened) {
      return;
    }

    this.dashboardOpened = true;
    void this.readyPromise.then(() => {
      openUrl(this.getDashboardUrl());
    }).catch((error: Error) => {
      console.error('[web-server] Dashboard auto-open skipped', { error: error.message });
    });
  }

  waitUntilReady(): Promise<void> {
    return this.readyPromise;
  }

  async destroy(): Promise<void> {
    this.broadcaster.destroy();
    this.wsServer.close();
    await new Promise<void>((resolve) => {
      this.httpServer.close(() => {
        resolve();
      });
    });
  }

  getDashboardUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  private async start(): Promise<void> {
    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      const port = DEFAULT_PORT + offset;

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: NodeJS.ErrnoException) => {
            this.httpServer.off('listening', onListening);
            reject(error);
          };
          const onListening = () => {
            this.httpServer.off('error', onError);
            resolve();
          };

          this.httpServer.once('error', onError);
          this.httpServer.once('listening', onListening);
          this.httpServer.listen(port, '127.0.0.1');
        });

        this.port = port;
        console.error('[web-server] Listening', { port: this.port });
        await this.broadcaster.refresh();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
          throw error;
        }
      }
    }

    throw new Error(`No available port found between ${DEFAULT_PORT}-${DEFAULT_PORT + MAX_PORT_ATTEMPTS - 1}`);
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.getDashboardUrl());

    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, this.broadcaster.getState());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/volume') {
      const parsed = await readVolumeRequest(request);
      if (parsed === null) {
        sendJson(response, { message: 'volume must be a number' }, 400);
        return;
      }
      if (!this.mpv.isReady()) {
        sendJson(response, { message: 'Audio engine unavailable' }, 503);
        return;
      }

      sendJson(response, { volume: this.mpv.setVolume(parsed.volume) });
      return;
    }

    if (request.method !== 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }

    const filePath = getStaticFilePath(PUBLIC_DIR, url.pathname);
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    const fileStats = await stat(filePath);
    if (!fileStats.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, { 'Content-Type': getMimeType(filePath) });
    createReadStream(filePath).pipe(response);
  }

  private handleSocketMessage(rawMessage: string): void {
    try {
      const message = JSON.parse(rawMessage) as { type?: string; level?: number };
      if (!this.mpv.isReady()) {
        return;
      }
      if (message.type === 'volume' && typeof message.level === 'number') {
        this.mpv.setVolume(message.level);
      }
      if (message.type === 'mute') {
        this.mpv.toggleMute();
      }
    } catch (error) {
      console.error('[web-server] Ignored invalid message', { error: (error as Error).message });
    }
  }

  private broadcastState(): void {
    const payload = JSON.stringify({ type: 'state', data: this.broadcaster.getState() });
    for (const client of this.wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendState(socket: WebSocket): void {
    socket.send(JSON.stringify({ type: 'state', data: this.broadcaster.getState() }));
  }
}

let webServer: WebServer | null = null;

export function createWebServer(mpv: MpvController, queueManager: QueueManager): WebServer {
  if (!webServer) {
    webServer = new WebServer(mpv, queueManager);
    void webServer.waitUntilReady().catch((error: Error) => {
      console.error('[web-server] Failed to start', { error: error.message });
    });
  }

  return webServer;
}

export function getWebServer(): WebServer | null {
  return webServer;
}
