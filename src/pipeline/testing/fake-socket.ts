// A WebSocket stand-in for unit tests: records what the module sends and lets the test play the server.
import { EventEmitter } from "node:events";
import type { SocketLike } from "../socket.js";

export class FakeSocket extends EventEmitter implements SocketLike {
  static readonly all: FakeSocket[] = [];
  readyState = 0; // CONNECTING
  sent: (string | Buffer)[] = [];
  closed = false;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {
    super();
    FakeSocket.all.push(this);
  }

  static connect = (url: string, headers: Record<string, string>): SocketLike => new FakeSocket(url, headers);

  static reset(): void {
    FakeSocket.all.length = 0;
  }

  send(data: string | Buffer): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.emit("close");
  }

  /** Test helpers playing the server side. */
  open(): void {
    this.readyState = 1; // OPEN
    this.emit("open");
  }

  reply(msg: object): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  get jsonSent(): any[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }

  get binarySent(): Buffer[] {
    return this.sent.filter((s): s is Buffer => Buffer.isBuffer(s));
  }
}
