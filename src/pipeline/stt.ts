// #6: streaming speech-to-text, one Deepgram live socket per leg. Twilio's μ-law 8k frames go in untouched.
import { EventEmitter } from "node:events";
import { config, type Lang } from "../config.js";
import type { SttEvents, SttLike, Transcript } from "./contract.js";
import { CONNECTING, OPEN, type Connect, type SocketLike, connectWs } from "./socket.js";

export interface SttStreamEvents extends SttEvents {
  /** Deepgram's utterance_end_ms backstop: the speaker stopped but no speech_final arrived. */
  utteranceEnd: [];
}

export function deepgramUrl(lang: Lang, model = config.deepgramModel): string {
  const params = new URLSearchParams({
    model,
    language: lang,
    encoding: "mulaw",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
    smart_format: "true",
    vad_events: "true",
  });
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

export function parseDeepgramMessage(raw: string): Transcript | undefined {
  const msg = JSON.parse(raw);
  if (msg.type !== "Results") return undefined;
  const text: string = msg.channel?.alternatives?.[0]?.transcript ?? "";
  if (!text.trim()) return undefined;
  return { text, isFinal: Boolean(msg.is_final), speechFinal: Boolean(msg.speech_final), at: Date.now() };
}

const KEEPALIVE_MS = 5000;

export class SttStream extends EventEmitter<SttStreamEvents> implements SttLike {
  private readonly ws: SocketLike;
  private readonly backlog: Buffer[] = [];
  private readonly keepalive: NodeJS.Timeout;
  private lastAudioAt = Date.now();
  private closed = false;

  constructor(lang: Lang, deps: { connect?: Connect } = {}) {
    super();
    const connect = deps.connect ?? connectWs;
    this.ws = connect(deepgramUrl(lang), { Authorization: `Token ${config.deepgramApiKey}` });
    this.ws.on("open", () => {
      for (const frame of this.backlog.splice(0)) this.ws.send(frame);
    });
    this.ws.on("message", (data: Buffer | string) => this.onMessage(data.toString()));
    this.ws.on("error", (err: Error) => this.emit("error", err));
    // Deepgram drops a socket that gets no data for ~10 s; phones stream continuously, but a held call may not.
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastAudioAt > KEEPALIVE_MS && this.ws.readyState === OPEN) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_MS);
  }

  write(ulawFrame: Buffer): void {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    if (this.ws.readyState === OPEN) this.ws.send(ulawFrame);
    else if (this.ws.readyState === CONNECTING) this.backlog.push(ulawFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    if (this.ws.readyState === OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    this.ws.close();
  }

  private onMessage(raw: string): void {
    if (this.closed) return;
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === "UtteranceEnd") {
      this.emit("utteranceEnd");
    } else if (msg.type === "Error") {
      this.emit("error", new Error(`deepgram: ${msg.description ?? msg.message ?? raw}`));
    } else {
      const t = parseDeepgramMessage(raw);
      if (t) this.emit("transcript", t);
    }
  }
}
