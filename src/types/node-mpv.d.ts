// Type declarations for node-mpv (no @types package available)

declare module 'node-mpv' {
  interface MpvOptions {
    audio_only?: boolean;
    auto_restart?: boolean;
    binary?: string;
    ipc_command?: string;
    socket?: string;
    time_update?: number;
    verbose?: boolean;
  }

  class MPV {
    constructor(options?: MpvOptions, mpvArgs?: string[]);
    start(): Promise<void>;
    quit(): Promise<void>;
    load(uri: string, mode?: string): Promise<void>;
    play(): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<void>;
    volume(level: number): Promise<void>;
    adjustVolume(delta: number): Promise<void>;
    mute(): Promise<void>;
    unmute(): Promise<void>;
    seek(seconds: number): Promise<void>;
    getTimePosition(): Promise<number | null>;
    getDuration(): Promise<number | null>;
    isPaused(): Promise<boolean>;
    isMuted(): Promise<boolean>;
    isSeekable(): Promise<boolean>;
    observeProperty(name: string, id?: number): Promise<void>;
    getProperty(name: string): Promise<unknown>;
    setProperty(name: string, value: unknown): Promise<void>;
    on(event: string, callback: (...args: unknown[]) => void): void;
  }

  export default MPV;
}
