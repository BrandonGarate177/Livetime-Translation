// The slice of a WebSocket the pipeline modules use, so tests can inject a fake and drive the server side.
import WebSocket from "ws";

export interface SocketLike {
  readyState: number;
  send(data: string | Buffer): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: any[]) => void): unknown;
}

export const CONNECTING = 0;
export const OPEN = 1;

export type Connect = (url: string, headers: Record<string, string>) => SocketLike;

export const connectWs: Connect = (url, headers) => new WebSocket(url, { headers });
