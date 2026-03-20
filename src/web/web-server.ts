import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createReadStream, existsSync } from 'fs';
import { stat } from 'fs/promises';
import { fileURLToPath } from 'url';
import { WebSocket, WebSocketServer } from 'ws';
import type { MpvController } from '../audio/mpv-controller.js';
import { getHistoryStore, type HistoryStore } from '../history/history-store.js';
import { getQueuePlaybackController } from '../queue/queue-playback-controller.js';
import type { QueueManager } from '../queue/queue-manager.js';
import { loadRuntimeConfig } from '../runtime/runtime-config.js';
import { getTasteEngine } from '../taste/taste-engine.js';
import { StateBroadcaster } from './state-broadcaster.js';
import {
  getMimeType,
  getStaticFilePath,
  openUrl,
  readJsonBody,
  readVolumeRequest,
  sendJson,
} from './web-server-helpers.js';
import { getDatabaseStatsPayload, runDatabaseAction } from './web-server-database-cleanup.js';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export interface WebServerOptions {
  historyStore?: HistoryStore;
  onStopDaemon?: (reason: string) => void | Promise<void>;
  port?: number;
}

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
  private readonly historyStore: HistoryStore | null;
  private readonly onStopDaemon?: (reason: string) => void | Promise<void>;
  private readonly port: number;
  private readonly wsServer = new WebSocketServer({ noServer: true });
  private dashboardOpened = false;

  constructor(
    private readonly mpv: MpvController,
    queueManager: QueueManager,
    options?: WebServerOptions,
  ) {
    this.historyStore = options?.historyStore ?? getHistoryStore();
    this.onStopDaemon = options?.onStopDaemon;
    this.port = options?.port ?? loadRuntimeConfig().dashboardPort;
    this.broadcaster = new StateBroadcaster(mpv, queueManager);
    this.readyPromise = this.start();

    this.wsServer.on('connection', (socket) => {
      this.sendState(socket);
      this.sendPersona(socket);
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
    if (this.httpServer.listening) {
      await new Promise<void>((resolve) => {
        this.httpServer.close(() => resolve());
      });
    }
    if (webServer === this) {
      webServer = null;
    }
  }

  getDashboardUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async broadcastStateSnapshot(): Promise<void> {
    await this.broadcaster.refresh();
    this.broadcastState();
  }

  broadcastPersona(): void {
    const taste = getTasteEngine();
    if (!taste) return;
    const payload = JSON.stringify({
      type: 'persona',
      data: taste.getPersona(),
    });
    for (const client of this.wsServer.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private async start(): Promise<void> {
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
      this.httpServer.listen(this.port, '127.0.0.1');
    });

    console.error('[web-server] Listening', { port: this.port });
    await this.broadcaster.refresh();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.getDashboardUrl());

    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, this.broadcaster.getState());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/persona') {
      const taste = getTasteEngine();
      if (!taste) {
        sendJson(response, { message: 'Unavailable' }, 503);
        return;
      }
      sendJson(response, taste.getPersona());
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/persona') {
      await this.handlePersonaUpdate(request, response);
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

    if (request.method === 'POST' && url.pathname === '/api/daemon/stop') {
      this.handleDaemonStop(response);
      return;
    }

    if (url.pathname === '/api/database/stats' && request.method === 'GET') {
      const store = this.historyStore;
      if (!store) {
        sendJson(response, { message: 'Unavailable' }, 503);
        return;
      }
      sendJson(response, getDatabaseStatsPayload(store));
      return;
    }

    if (request.method === 'POST' && isDatabaseActionPath(url.pathname)) {
      await this.handleDatabaseAction(url.pathname, response);
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

  private async handlePersonaUpdate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonBody(request);
    if (!hasOwn(body, 'taste')) {
      sendJson(response, { message: 'taste field required' }, 400);
      return;
    }
    if (typeof body?.taste !== 'string') {
      sendJson(response, { message: 'taste must be a string' }, 400);
      return;
    }

    const taste = getTasteEngine();
    if (!taste) {
      sendJson(response, { message: 'Unavailable' }, 503);
      return;
    }

    taste.saveTasteText(body.taste.slice(0, 1000));
    sendJson(response, { updated: true, ...taste.getPersona() });
    this.broadcastPersona();
  }

  private async handleDatabaseAction(pathname: string, response: ServerResponse): Promise<void> {
    const store = this.historyStore;
    if (!store) {
      sendJson(response, { message: 'Unavailable' }, 503);
      return;
    }

    const action = pathname.replace('/api/database/', '') as 'clear-history' | 'clear-provider-cache' | 'full-reset';
    const payload = await runDatabaseAction(action, store, getQueuePlaybackController());
    await this.broadcastStateSnapshot();
    sendJson(response, payload);
  }

  private handleDaemonStop(response: ServerResponse): void {
    if (!this.onStopDaemon) {
      sendJson(response, { message: 'Unavailable' }, 503);
      return;
    }

    sendJson(response, {
      stopped: true,
      message: 'Daemon stop requested. This dashboard will stay offline until you start a new coding session.',
    });
    setTimeout(() => {
      void Promise.resolve(this.onStopDaemon?.('dashboard stop'));
    }, 100);
  }

  private handleSocketMessage(rawMessage: string): void {
    try {
      const message = JSON.parse(rawMessage) as { type?: string; level?: number; taste?: string };
      if (message.type === 'update_persona' && typeof message.taste === 'string') {
        const tasteEngine = getTasteEngine();
        if (tasteEngine) {
          tasteEngine.saveTasteText(message.taste.slice(0, 1000));
          this.broadcastPersona();
        }
        return;
      }
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

  private sendPersona(socket: WebSocket): void {
    const taste = getTasteEngine();
    if (!taste) return;
    socket.send(JSON.stringify({
      type: 'persona',
      data: taste.getPersona(),
    }));
  }
}

function hasOwn(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function isDatabaseActionPath(pathname: string): pathname is '/api/database/clear-history' | '/api/database/clear-provider-cache' | '/api/database/full-reset' {
  return pathname === '/api/database/clear-history'
    || pathname === '/api/database/clear-provider-cache'
    || pathname === '/api/database/full-reset';
}

let webServer: WebServer | null = null;

export function createWebServer(
  mpv: MpvController,
  queueManager: QueueManager,
  options?: WebServerOptions,
): WebServer {
  if (!webServer) {
    const server = new WebServer(mpv, queueManager, options);
    webServer = server;
    void server.waitUntilReady().catch(() => {
      void server.destroy();
      if (webServer === server) {
        webServer = null;
      }
    });
  }

  return webServer;
}

export function getWebServer(): WebServer | null {
  return webServer;
}
