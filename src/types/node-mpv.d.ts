// Type declarations for node-mpv v1.5.0 (no @types package available)
// v1.5 spawns mpv in constructor; methods are sync socket commands (fire-and-forget)

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

    // Playback — sync socket commands, no return value
    load(uri: string, mode?: string, options?: string[]): void;
    pause(): void;
    resume(): void;
    stop(): void;
    quit(): void;

    // Volume — sync socket commands
    volume(level: number): void;
    adjustVolume(delta: number): void;
    mute(): void;
    unmute(): void;

    // Seeking
    seek(seconds: number): void;
    goToPosition(seconds: number): void;

    // Properties — getProperty returns a Promise
    getProperty(name: string): Promise<unknown>;
    setProperty(name: string, value: unknown): void;
    observeProperty(name: string, id?: number): void;

    // Events
    on(event: string, callback: (...args: unknown[]) => void): void;
  }

  export default MPV;
}
