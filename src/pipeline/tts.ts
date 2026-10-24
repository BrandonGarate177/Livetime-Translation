// #8: ElevenLabs streaming TTS straight to ulaw_8000, one TtsStream per listening leg.
//
// Why one socket per *utterance* rather than per leg: ElevenLabs only sends `isFinal` after end-of-stream,
// and `done` has to mean "this utterance's audio is complete" for the session to time turns. So each flush
// closes its socket, and a spare is always kept open for the next utterance so the connect cost is hidden.
// Audio is released in utterance order even when a later socket answers first.
import { EventEmitter } from "node:events";
import { config, type Lang } from "../config.js";
import type { TtsEvents, TtsLike } from "./contract.js";
import { OPEN, type Connect, type SocketLike, connectWs } from "./socket.js";

export function elevenUrl(voiceId: string, lang: Lang, model = config.elevenModel): string {
  const params = new URLSearchParams({
    model_id: model,
    output_format: "ulaw_8000",
    language_code: lang,
    inactivity_timeout: "180", // the maximum, so a warm spare survives a long pause
  });
  return `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input?${params}`;
}

export function parseElevenMessage(raw: string): { audio: Buffer } | { done: true } | undefined {
  const msg = JSON.parse(raw);
  if (msg.isFinal === true) return { done: true };
  if (typeof msg.audio === "string" && msg.audio.length > 0) return { audio: Buffer.from(msg.audio, "base64") };
  return undefined;
}

const INIT_MESSAGE = {
  text: " ",
  voice_settings: { stability: 0.5, similarity_boost: 0.8, use_speaker_boost: false, speed: 1.0 },
  // Low thresholds so a long translation starts playing before the model has finished writing it.
  generation_config: { chunk_length_schedule: [50, 90, 120, 150, 200] },
};
const SPARE_MAX_AGE_MS = 150_000; // under the 180 s inactivity timeout

interface Socket {
  ws: SocketLike;
  voiceId: string;
  openedAt: number;
  open: boolean;
}

interface Utterance {
  socket?: Socket;
  pendingText: string[]; // text written before the socket opened
  endRequested: boolean;
  chunks: Buffer[]; // audio waiting for its turn
  finished: boolean;
}

export class TtsStream extends EventEmitter<TtsEvents> implements TtsLike {
  private readonly connect: Connect;
  private spare?: Socket;
  private current?: Utterance;
  private readonly queue: Utterance[] = [];
  private closed = false;

  constructor(
    private voiceId: string,
    private readonly lang: Lang,
    deps: { connect?: Connect } = {},
  ) {
    super();
    this.connect = deps.connect ?? connectWs;
    this.warm();
  }

  sendText(chunk: string): void {
    if (this.closed || !chunk) return;
    this.current ??= this.begin();
    const utt = this.current;
    if (utt.socket!.open) utt.socket!.ws.send(JSON.stringify({ text: chunk }));
    else utt.pendingText.push(chunk);
  }

  /** Ends the current utterance. `done` fires once its last audio has been emitted, in order with earlier ones. */
  flush(): void {
    if (this.closed) return;
    const utt = this.current;
    this.current = undefined;
    if (!utt) {
      // Nothing was spoken, but callers still get their done so turn accounting stays balanced.
      this.queue.push({ pendingText: [], endRequested: true, chunks: [], finished: true });
      queueMicrotask(() => this.pump());
      return;
    }
    utt.endRequested = true;
    if (utt.socket!.open) utt.socket!.ws.send(JSON.stringify({ text: "" }));
  }

  /** Takes effect from the next utterance; the one in progress keeps its voice. */
  setVoice(voiceId: string): void {
    if (this.closed || voiceId === this.voiceId) return;
    this.voiceId = voiceId;
    if (this.spare) {
      const stale = this.spare;
      this.spare = undefined;
      stale.ws.close();
    }
    this.warm();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.spare?.ws.close();
    this.spare = undefined;
    for (const utt of [this.current, ...this.queue]) utt?.socket?.ws.close();
    this.current = undefined;
    this.queue.length = 0;
  }

  private warm(): void {
    if (this.closed || this.spare) return;
    const socket: Socket = { ws: this.connect(elevenUrl(this.voiceId, this.lang), { "xi-api-key": config.elevenlabsApiKey }), voiceId: this.voiceId, openedAt: Date.now(), open: false };
    socket.ws.on("open", () => {
      socket.open = true;
      socket.ws.send(JSON.stringify(INIT_MESSAGE));
    });
    socket.ws.on("error", (err: Error) => {
      if (!this.closed) this.emit("error", err);
    });
    socket.ws.on("close", () => {
      // The server timed out an idle spare: replace it a moment later so the next utterance still starts warm.
      if (this.spare === socket) {
        this.spare = undefined;
        setTimeout(() => this.warm(), 1000).unref();
      }
    });
    this.spare = socket;
  }

  private begin(): Utterance {
    let socket = this.spare;
    this.spare = undefined;
    if (!socket || socket.ws.readyState > OPEN || Date.now() - socket.openedAt > SPARE_MAX_AGE_MS) {
      socket?.ws.close();
      this.warm();
      socket = this.spare!;
      this.spare = undefined;
    }
    const utt: Utterance = { socket, pendingText: [], endRequested: false, chunks: [], finished: false };
    const { ws } = socket;
    ws.on("open", () => {
      for (const text of utt.pendingText.splice(0)) ws.send(JSON.stringify({ text }));
      if (utt.endRequested) ws.send(JSON.stringify({ text: "" }));
    });
    ws.on("message", (data: Buffer | string) => {
      if (this.closed || utt.finished) return;
      let parsed: ReturnType<typeof parseElevenMessage>;
      try {
        parsed = parseElevenMessage(data.toString());
      } catch {
        return;
      }
      if (!parsed) return;
      if ("done" in parsed) {
        utt.finished = true;
        ws.close();
      } else {
        utt.chunks.push(parsed.audio);
      }
      this.pump();
    });
    ws.on("close", () => {
      if (utt.finished || this.closed) return;
      utt.finished = true; // closed early: whatever arrived is all we get
      this.pump();
    });
    this.queue.push(utt);
    this.warm();
    return utt;
  }

  private pump(): void {
    if (this.closed) return;
    while (this.queue.length) {
      const head = this.queue[0];
      for (const chunk of head.chunks.splice(0)) this.emit("audio", chunk);
      if (!head.finished) return;
      this.queue.shift();
      this.emit("done");
    }
  }
}
