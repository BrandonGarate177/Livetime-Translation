// Interfaces shared by the pipeline modules (#6 stt, #7 translate, #8 tts) and the session wiring (#9).
// Copied from the GitHub issues; keep them in sync with src/pipeline/{stt,translate,tts}.ts.
import type { EventEmitter } from "node:events";
import type { Lang } from "../config.js";

export interface Transcript {
  text: string;
  isFinal: boolean; // this segment won't change
  speechFinal: boolean; // speaker paused (end of turn)
  at: number; // Date.now() when received, for latency metrics
}
export interface SttEvents {
  transcript: [t: Transcript];
  error: [err: Error];
}
export interface SttLike extends EventEmitter<SttEvents> {
  write(ulawFrame: Buffer): void;
  close(): void;
}

export interface Turn {
  src: Lang;
  text: string;
  translation: string;
}
export interface TranslateOpts {
  text: string;
  src: Lang;
  dst: Lang;
  history: Turn[]; // last 3 turns, for pronouns and gender agreement
  signal?: AbortSignal; // barge-in or hang-up cancels in-flight translations
}

export interface TtsEvents {
  audio: [ulaw: Buffer]; // ulaw_8000, pass straight to Leg.sendAudio
  done: []; // the last audio for a flush has arrived
  error: [err: Error];
}
export interface TtsLike extends EventEmitter<TtsEvents> {
  sendText(chunk: string): void;
  flush(): void;
  setVoice(voiceId: string): void;
  close(): void;
}

/** Factory the session uses so vendors (or offline fakes) can be swapped without touching call code. */
export interface Pipeline {
  name: string;
  createStt(lang: Lang): SttLike;
  translate(opts: TranslateOpts): AsyncIterable<string>;
  prewarmTranslate(): Promise<void>;
  createTts(voiceId: string, lang: Lang): TtsLike;
}
