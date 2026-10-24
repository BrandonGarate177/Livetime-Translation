// Picks the pipeline the session runs on. PIPELINE=fake is the offline stand-in; PIPELINE=real loads
// src/pipeline/{stt,translate,tts}.ts (#6/#7/#8) and adapts them to the contract in contract.ts.
//
// The real modules are imported through a string variable so this file compiles before they exist and
// the #9 branch never has to merge-conflict with the pipeline branches.
// TODO(#9): switch to static imports once #6/#7/#8 are merged and their shapes are settled.
import { EventEmitter } from "node:events";
import { config, type Lang } from "../config.js";
import type { Pipeline, SttEvents, SttLike, TranslateOpts, TtsEvents, TtsLike } from "./contract.js";
import { fakePipeline } from "./fake.js";

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

export function adaptTranslateModule(mod: AnyModule): Pick<Pipeline, "translate" | "prewarmTranslate"> {
  return {
    translate: (opts: TranslateOpts) => mod.translate(opts),
    prewarmTranslate: async () => {
      if (typeof mod.prewarm === "function") await mod.prewarm();
    },
  };
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
  const paths = ["./stt.js", "./translate.js", "./tts.js"];
  let mods: AnyModule[];
  try {
    mods = await Promise.all(paths.map((p) => import(p)));
  } catch (err) {
    throw new Error(
      `PIPELINE=real needs src/pipeline/{stt,translate,tts}.ts from #6/#7/#8 (${(err as Error).message}); set PIPELINE=fake to test offline`,
    );
  }
  const [stt, translate, tts] = mods;
  return {
    name: "real",
    createStt: adaptSttModule(stt),
    ...adaptTranslateModule(translate),
    createTts: adaptTtsModule(tts),
  };
}
