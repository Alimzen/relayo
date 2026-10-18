declare module 'hoodiecrow-imap' {
  import type { Server } from 'node:net';

  interface HoodiecrowServer {
    server: Server;
    listen(port: number, host: string, callback?: () => void): void;
    close(callback?: () => void): void;
  }

  export default function hoodiecrow(options?: Record<string, unknown>): HoodiecrowServer;
}
