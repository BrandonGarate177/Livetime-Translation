// #6: streaming speech-to-text, one Deepgram socket per leg. Twilio's μ-law 8k frames go in untouched.
//
// Two engines: Nova-3 (`/v1/listen`, endpointing + is_final segments, all five languages) and Flux
// (`/v2/listen`, a turn-detection model that ends a turn ~260 ms after the speaker stops, versus ~550 ms
// for endpointing + finalization). Flux is used for en (flux-general-en); flux-general-multi exists for es/ru
// but measured no faster than Nova-3 on the Spanish leg, so it is opt-in via FLUX_MULTI_LANGS. uk/pl stay on Nova-3.
import { EventEmitter } from "node:events";
import { FRAME_BYTES } from "../audio/mulaw.js";
import { config, type Lang, type SttEngine } from "../config.js";
import type { SttEvents, SttLike, Transcript } from "./contract.js";
import { CONNECTING, OPEN, type Connect, type SocketLike, connectWs } from "./socket.js";

export interface SttStreamEvents extends SttEvents {
  /** Nova-3's utterance_end_ms backstop: the speaker stopped but no speech_final arrived. */
  utteranceEnd: [];
  /** Flux: the turn is probably over (eager_eot_threshold). Speculative translation can start here. */
  eagerEndOfTurn: [Transcript];
  /** Flux: the speaker kept going after an EagerEndOfTurn; drop any speculative work. */
  turnResumed: [];
}

export interface CreateSttOptions {
  lang: Lang;
  engine?: SttEngine;
  connect?: Connect;
  /** Languages allowed on flux-general-multi; defaults to FLUX_MULTI_LANGS. */
  multiLangs?: readonly Lang[];
}

/** What the #9 loader calls: picks the engine for the leg's language. */
export function createStt(opts: CreateSttOptions): SttStream | FluxStream {
  const engine = opts.engine ?? config.sttEngine;
  const deps = { connect: opts.connect, multiLangs: opts.multiLangs };
  if (engine === "flux" && fluxModelFor(opts.lang, opts.multiLangs)) return new FluxStream(opts.lang, deps);
  return new SttStream(opts.lang, deps);
}

// ---------------------------------------------------------------------------------------------------
// Nova-3

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

/** Shared socket plumbing: open-on-construct, buffer until open, drop after close. */
abstract class DeepgramSocket extends EventEmitter<SttStreamEvents> implements SttLike {
  protected readonly ws: SocketLike;
  private readonly backlog: Buffer[] = [];
  protected closed = false;

  constructor(url: string, connect: Connect) {
    super();
    this.ws = connect(url, { Authorization: `Token ${config.deepgramApiKey}` });
    this.ws.on("open", () => {
      for (const chunk of this.backlog.splice(0)) this.ws.send(chunk);
    });
    this.ws.on("message", (data: Buffer | string) => {
      if (this.closed) return;
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(msg, data.toString());
    });
    this.ws.on("error", (err: Error) => this.emit("error", err));
  }

  abstract write(ulawFrame: Buffer): void;
  protected abstract onMessage(msg: any, raw: string): void;

  protected sendAudio(chunk: Buffer): void {
    if (this.ws.readyState === OPEN) this.ws.send(chunk);
    else if (this.ws.readyState === CONNECTING) this.backlog.push(chunk);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws.readyState === OPEN) this.ws.send(JSON.stringify({ type: "CloseStream" }));
    this.ws.close();
  }
}

export class SttStream extends DeepgramSocket {
  private readonly keepalive: NodeJS.Timeout;
  private lastAudioAt = Date.now();

  constructor(lang: Lang, deps: { connect?: Connect } = {}) {
    super(deepgramUrl(lang), deps.connect ?? connectWs);
    // Nova-3 drops a socket that gets no data for ~10 s; phones stream continuously, but a held call may not.
    this.keepalive = setInterval(() => {
      if (Date.now() - this.lastAudioAt > KEEPALIVE_MS && this.ws.readyState === OPEN) {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
      }
    }, KEEPALIVE_MS);
  }

  write(ulawFrame: Buffer): void {
    if (this.closed) return;
    this.lastAudioAt = Date.now();
    this.sendAudio(ulawFrame);
  }

  close(): void {
    clearInterval(this.keepalive);
    super.close();
  }

  protected onMessage(msg: any, raw: string): void {
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

// ---------------------------------------------------------------------------------------------------
// Flux

const FLUX_MULTI_SUPPORTED: ReadonlySet<Lang> = new Set<Lang>(["es", "ru"]); // Flux multilingual has no uk/pl

export function fluxModelFor(lang: Lang, multiLangs: readonly Lang[] = config.fluxMultiLangs): "flux-general-en" | "flux-general-multi" | undefined {
  if (lang === "en") return "flux-general-en";
  if (FLUX_MULTI_SUPPORTED.has(lang) && multiLangs.includes(lang)) return "flux-general-multi";
  return undefined;
}

export function fluxUrl(lang: Lang, multiLangs: readonly Lang[] = config.fluxMultiLangs): string {
  const model = fluxModelFor(lang, multiLangs);
  if (!model) throw new Error(`Flux has no model for ${lang}`);
  const params = new URLSearchParams({
    model,
    encoding: "mulaw",
    sample_rate: "8000",
    eot_threshold: config.fluxEotThreshold,
    eot_timeout_ms: config.fluxEotTimeoutMs,
  });
  if (model === "flux-general-multi") params.set("language_hint", lang);
  return `wss://api.deepgram.com/v2/listen?${params}`;
}

/** TurnInfo → Transcript. Update/StartOfTurn are interim; EndOfTurn is the whole turn, final. Eager/Resumed are separate events. */
export function parseFluxMessage(raw: string): Transcript | undefined {
  const msg = JSON.parse(raw);
  if (msg.type !== "TurnInfo") return undefined;
  const text: string = msg.transcript ?? "";
  if (!text.trim()) return undefined;
  switch (msg.event) {
    case "StartOfTurn":
    case "Update":
      return { text, isFinal: false, speechFinal: false, at: Date.now() };
    case "EndOfTurn":
      return { text, isFinal: true, speechFinal: true, at: Date.now() };
    default:
      return undefined;
  }
}

const FLUX_CHUNK_FRAMES = 4; // Deepgram recommends 80 ms chunks for Flux; Twilio frames are 20 ms

export class FluxStream extends DeepgramSocket {
  private pending: Buffer[] = [];

  constructor(lang: Lang, deps: { connect?: Connect; multiLangs?: readonly Lang[] } = {}) {
    super(fluxUrl(lang, deps.multiLangs), deps.connect ?? connectWs);
  }

  write(ulawFrame: Buffer): void {
    if (this.closed) return;
    this.pending.push(ulawFrame);
    if (this.pending.length * FRAME_BYTES >= FRAME_BYTES * FLUX_CHUNK_FRAMES) {
      this.sendAudio(Buffer.concat(this.pending.splice(0)));
    }
  }

  protected onMessage(msg: any, raw: string): void {
    if (msg.type === "Error") {
      this.emit("error", new Error(`deepgram flux ${msg.code ?? ""}: ${msg.description ?? raw}`.replace(" :", ":")));
      return;
    }
    if (msg.type !== "TurnInfo") return;
    if (msg.event === "EagerEndOfTurn") {
      if (msg.transcript?.trim()) this.emit("eagerEndOfTurn", { text: msg.transcript, isFinal: false, speechFinal: true, at: Date.now() });
      return;
    }
    if (msg.event === "TurnResumed") {
      this.emit("turnResumed");
      return;
    }
    const t = parseFluxMessage(raw);
    if (t) this.emit("transcript", t);
  }
}
