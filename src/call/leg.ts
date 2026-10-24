import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { FRAME_BYTES } from "../audio/mulaw.js";

export type LegId = "A" | "B";

export interface LegEvents {
  audio: [frame: Buffer];
  mark: [name: string];
  stop: [];
}

/**
 * One side of the call: a bidirectional Twilio Media Stream, constructed once its "start" event has arrived.
 * Tracks outstanding marks so `isPlaying` reflects whether the far phone is still playing our audio.
 */
export class Leg extends EventEmitter<LegEvents> {
  readonly streamSid: string;
  readonly callSid: string;
  private pendingMarks = new Set<string>();
  private markSeq = 0;
  private closed = false;

  constructor(
    readonly id: LegId,
    private readonly ws: WebSocket,
    start: { streamSid: string; callSid: string },
  ) {
    super();
    this.streamSid = start.streamSid;
    this.callSid = start.callSid;
    ws.on("message", (data) => this.onMessage(data.toString()));
    ws.on("close", () => this.handleStop());
  }

  get isPlaying(): boolean {
    return this.pendingMarks.size > 0;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  /** Sends μ-law audio, re-chunked to 20ms frames. Returns the mark name that fires when playback reaches the end. */
  sendAudio(ulaw: Buffer): string | undefined {
    if (!this.isOpen) return undefined;
    for (let i = 0; i < ulaw.length; i += FRAME_BYTES) {
      const payload = ulaw.subarray(i, i + FRAME_BYTES).toString("base64");
      this.send({ event: "media", streamSid: this.streamSid, media: { payload } });
    }
    return this.mark();
  }

  mark(): string {
    const name = `m${++this.markSeq}`;
    this.pendingMarks.add(name);
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });
    return name;
  }

  /** Barge-in: drop everything Twilio has buffered for this leg. Twilio echoes pending marks back. */
  clear(): void {
    if (!this.isOpen) return;
    this.send({ event: "clear", streamSid: this.streamSid });
  }

  close(): void {
    this.ws.close();
  }

  private send(msg: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw);
    switch (msg.event) {
      case "media":
        if (msg.media.track === undefined || msg.media.track === "inbound") {
          this.emit("audio", Buffer.from(msg.media.payload, "base64"));
        }
        break;
      case "mark":
        this.pendingMarks.delete(msg.mark.name);
        this.emit("mark", msg.mark.name);
        break;
      case "stop":
        this.handleStop();
        break;
    }
  }

  private handleStop(): void {
    if (this.closed) return;
    this.closed = true;
    this.pendingMarks.clear();
    this.emit("stop");
  }
}
