// Picks the pipeline the session runs on. PIPELINE=fake is the offline stand-in; PIPELINE=real adapts
// src/pipeline/{stt,translate,tts}.ts (#6/#7/#8) to the contract in contract.ts.
import { EventEmitter } from "node:events";
import { config, type Lang } from "../config.js";
import type { Pipeline, SttEvents, SttLike, TranslateOpts, TtsEvents, TtsLike } from "./contract.js";
import { fakePipeline } from "./fake.js";
import * as sttModule from "./stt.js";
import * as translateModule from "./translate.js";
import * as ttsModule from "./tts.js";

type AnyModule = Record<string, any>;
type Emitter = EventEmitter & Record<string, any>;

/** The issue says `new SttStream(lang)` + `write()`; the module in flight exports `createStt({lang})` + `send()`. Take either. */
export function adaptSttModule(mod: AnyModule): (lang: Lang) => SttLike {
  return (lang) => {
    const inner: Emitter = mod.createStt ? mod.createStt({ lang }) : new mod.SttStream(lang);
    const out = new EventEmitter<SttEvents>() as SttLike & { inner: Emitter };
    out.inner = inner;
    inner.on("transcript", (t: any) => out.emit("transcript", { ...t, at: t.at ?? Date.now() }));
    inner.on("error", (e: Error) => out.emit("error", e));
    out.write = (frame) => (inner.write ?? inner.send).call(inner, frame);
    out.close = () => inner.close();
    return out;
  };
}

/**
 * The issue says `translate(opts): AsyncIterable<string>`; the module in flight exports `createTranslator()`
 * whose `translate(text, src, dst, onDelta)` streams through a callback and keeps its own history. Take either.
 */
export function adaptTranslateModule(mod: AnyModule): Pick<Pipeline, "translate" | "prewarmTranslate"> {
  const prewarmTranslate = async () => {
    if (typeof mod.prewarm === "function") await mod.prewarm();
  };
  if (mod.createTranslator) {
    // One Translator per process: its history is per instance, and the demo runs one call at a time.
    const translator = mod.createTranslator();
    return {
      translate: (opts) =>
        callbackToIterable((onDelta) => translator.translate(opts.text, opts.src, opts.dst, onDelta), opts.signal),
      prewarmTranslate,
    };
  }
  return { translate: (opts: TranslateOpts) => mod.translate(opts), prewarmTranslate };
}

async function* callbackToIterable(
  run: (onDelta: (d: string) => void) => Promise<unknown>,
  signal?: AbortSignal,
): AsyncIterable<string> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let error: unknown;
  const notify = () => {
    wake?.();
    wake = undefined;
  };
  signal?.addEventListener("abort", notify, { once: true });
  run((d) => {
    queue.push(d);
    notify();
  }).then(
    () => {
      done = true;
      notify();
    },
    (err) => {
      error = err;
      done = true;
      notify();
    },
  );
  while (true) {
    if (queue.length) {
      yield queue.shift()!;
      continue;
    }
    if (error) throw error;
    if (done || signal?.aborted) return;
    await new Promise<void>((resolve) => (wake = resolve));
  }
}

export function adaptTtsModule(mod: AnyModule): (voiceId: string, lang: Lang) => TtsLike {
  return (voiceId, lang) => {
    const inner: Emitter = mod.createTts ? mod.createTts({ voiceId, lang }) : new mod.TtsStream(voiceId, lang);
    const out = new EventEmitter<TtsEvents>() as TtsLike & { inner: Emitter };
    out.inner = inner;
    inner.on("audio", (b: Buffer) => out.emit("audio", b));
    inner.on("done", () => out.emit("done"));
    inner.on("error", (e: Error) => out.emit("error", e));
    out.sendText = (chunk) => (inner.sendText ?? inner.send).call(inner, chunk);
    out.flush = () => inner.flush();
    out.setVoice = (id) => inner.setVoice?.(id);
    out.close = () => inner.close();
    return out;
  };
}

export async function loadPipeline(): Promise<Pipeline> {
  if (config.pipeline === "fake") return fakePipeline;
  return {
    name: "real",
    createStt: adaptSttModule(sttModule),
    ...adaptTranslateModule(translateModule),
    createTts: adaptTtsModule(ttsModule),
  };
}
