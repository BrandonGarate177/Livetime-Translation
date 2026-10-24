// One direction of a translated call: the speaking leg's audio → STT → translate → TTS → the listening leg.
// A session runs two of these (A→B and B→A) independently, which is what makes the call full duplex.
import { EventEmitter } from "node:events";
import type { Lang } from "../config.js";
import { frameRms } from "../audio/mulaw.js";
import type { Pipeline, SttLike, Transcript, TtsLike, Turn } from "../pipeline/contract.js";
import type { Leg } from "./leg.js";

export interface Timing {
  speechEnd: number;
  transcript: number;
  firstToken: number;
  firstAudio: number;
}

export interface DirectionEvents {
  transcript: [e: { text: string; isFinal: boolean }];
  translation: [e: { text: string }];
  timing: [e: Timing];
}

export interface DirectionOptions {
  pipeline: Pipeline;
  from: Leg;
  /** Resolved per chunk: the listener may not have attached yet, or may have hung up. */
  to: () => Leg | undefined;
  srcLang: Lang;
  dstLang: Lang;
  voiceId: string;
  /** Shared by both directions of a session; capped at HISTORY_TURNS. */
  history: Turn[];
  log: (msg: string) => void;
}

export const HISTORY_TURNS = 3;
const VOICED_RMS = 300;

export class Direction extends EventEmitter<DirectionEvents> {
  private stt?: SttLike;
  private tts?: TtsLike;
  private queue: Promise<void> = Promise.resolve();
  private current?: AbortController;
  private lastVoicedAt = 0;
  /** Timings of flushed utterances still waiting for their first audio byte, oldest first. */
  private awaitingAudio: Timing[] = [];
  private playing = false;
  private closed = false;

  constructor(private readonly opts: DirectionOptions) {
    super();
  }

  start(): void {
    const { pipeline, from, srcLang, dstLang, voiceId, log } = this.opts;
    this.stt = pipeline.createStt(srcLang);
    this.tts = pipeline.createTts(voiceId, dstLang);
    pipeline.prewarmTranslate().catch((err) => log(`translate prewarm failed: ${(err as Error).message}`));

    this.stt.on("transcript", (t) => this.onTranscript(t));
    this.stt.on("error", (err) => log(`stt error: ${err.message}`));
    this.tts.on("audio", (ulaw) => this.onAudio(ulaw));
    this.tts.on("done", () => (this.playing = false));
    this.tts.on("error", (err) => log(`tts error: ${err.message}`));
    from.on("audio", this.onFrame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.abort();
    this.opts.from.off("audio", this.onFrame);
    this.stt?.close();
    this.tts?.close();
  }

  private onFrame = (frame: Buffer): void => {
    this.stt?.write(frame);
    if (frameRms(frame) > VOICED_RMS) this.lastVoicedAt = Date.now();
  };

  private onTranscript(t: Transcript): void {
    this.emit("transcript", { text: t.text, isFinal: t.isFinal });
    if (!t.isFinal || t.text.trim() === "") return;
    // Sequential per direction so the TTS text never interleaves two utterances.
    this.queue = this.queue.then(() => this.translateUtterance(t));
  }

  private async translateUtterance(t: Transcript): Promise<void> {
    if (this.closed) return;
    const { pipeline, srcLang, dstLang, history, log } = this.opts;
    const timing: Timing = { speechEnd: this.lastVoicedAt, transcript: t.at, firstToken: 0, firstAudio: 0 };
    const ac = new AbortController();
    this.current = ac;
    let translation = "";
    try {
      const stream = pipeline.translate({ text: t.text, src: srcLang, dst: dstLang, history: [...history], signal: ac.signal });
      for await (const chunk of stream) {
        if (ac.signal.aborted) return;
        if (!timing.firstToken) timing.firstToken = Date.now();
        translation += chunk;
        this.tts?.sendText(chunk);
      }
    } catch (err) {
      log(`translate failed: ${(err as Error).message}`);
      return;
    } finally {
      if (this.current === ac) this.current = undefined;
    }
    if (ac.signal.aborted || translation.trim() === "") return;

    this.awaitingAudio.push(timing);
    this.tts?.flush();
    history.push({ src: srcLang, text: t.text, translation });
    while (history.length > HISTORY_TURNS) history.shift();
    this.emit("translation", { text: translation });
  }

  private onAudio(ulaw: Buffer): void {
    if (this.closed) return;
    if (!this.playing) {
      this.playing = true;
      const timing = this.awaitingAudio.shift();
      if (timing) {
        timing.firstAudio = Date.now();
        this.emit("timing", timing);
      }
    }
    const to = this.opts.to();
    if (to?.isOpen) to.sendAudio(ulaw);
  }
}
