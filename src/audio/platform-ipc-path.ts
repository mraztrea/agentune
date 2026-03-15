// Cross-platform IPC path for mpv JSON IPC communication
// Windows uses named pipes, Unix uses domain sockets

export function getIpcPath(): string {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\sbotify-mpv'
    : '/tmp/sbotify-mpv';
}
