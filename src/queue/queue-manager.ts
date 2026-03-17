import { EventEmitter } from 'events';

const MAX_HISTORY_ITEMS = 20;

export interface QueueItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  url: string;
  context?: string;
}

export interface QueueState {
  nowPlaying: QueueItem | null;
  queue: QueueItem[];
  history: QueueItem[];
}

export class QueueManager extends EventEmitter {
  private state: QueueState = {
    nowPlaying: null,
    queue: [],
    history: [],
  };

  add(item: QueueItem): number {
    this.state.queue.push(item);
    this.emitStateChange();
    return this.state.queue.length;
  }

  list(): QueueItem[] {
    return [...this.state.queue];
  }

  next(): QueueItem | null {
    const nextItem = this.state.queue.shift() ?? null;
    this.emitStateChange();
    return nextItem;
  }

  /** Look at the next item without removing it from the queue. */
  peek(): QueueItem | null {
    return this.state.queue[0] ?? null;
  }

  size(): number {
    return this.state.queue.length;
  }

  clear(): void {
    this.state.queue = [];
    this.emitStateChange();
  }

  getNowPlaying(): QueueItem | null {
    return this.state.nowPlaying;
  }

  setNowPlaying(item: QueueItem | null): void {
    if (this.state.nowPlaying) {
      this.pushHistory(this.state.nowPlaying);
    }
    this.state.nowPlaying = item;
    this.emitStateChange();
  }

  finishCurrentTrack(): QueueItem | null {
    const finished = this.state.nowPlaying;
    if (finished) {
      this.pushHistory(finished);
    }
    this.state.nowPlaying = null;
    this.emitStateChange();
    return finished ?? null;
  }

  clearNowPlaying(): void {
    if (!this.state.nowPlaying) {
      return;
    }
    this.state.nowPlaying = null;
    this.emitStateChange();
  }

  getState(): QueueState {
    return {
      nowPlaying: this.state.nowPlaying,
      queue: [...this.state.queue],
      history: [...this.state.history],
    };
  }

  private pushHistory(item: QueueItem): void {
    this.state.history = [item, ...this.state.history].slice(0, MAX_HISTORY_ITEMS);
  }

  private emitStateChange(): void {
    this.emit('state-change', this.getState());
  }
}

let queueManager: QueueManager | null = null;

export function createQueueManager(): QueueManager {
  if (!queueManager) {
    queueManager = new QueueManager();
  }
  return queueManager;
}

export function getQueueManager(): QueueManager | null {
  return queueManager;
}
