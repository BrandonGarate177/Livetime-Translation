// Offline stand-ins for STT, translation and TTS so BRIDGE_MODE=translate can be exercised with the
// simulator and in tests before any vendor key exists (PIPELINE=fake). Not for real calls.
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Lang } from "../config.js";
import { SAMPLE_RATE, decodeWav, frameRms, pcm16ToMulaw } from "../audio/mulaw.js";
import type { Pipeline, SttEvents, TranslateOpts, TtsEvents } from "./contract.js";

/** The sentences in scripts/make-test-audio.sh, so the simulator's clips "transcribe" to the right text. */
export const CANNED: Record<Lang, string> = {
  en: "Hi Olena, this is a judge from the hackathon. How is your day going? Where are you calling from?",
  es: "Hola, me llamo Diego. Estoy muy bien, gracias. Estoy en Madrid hoy.",
  ru: "Привет, меня зовут Олена. У меня всё хорошо, спасибо. Я звоню из Киева.",
  uk: "Привіт, мене звати Олена. У мене все добре, дякую. Я телефоную з Києва.",
  pl: "Cześć, mam na imię Kasia. Wszystko w porządku, dziękuję. Dzwonię z Warszawy.",
};

export const DICTIONARY: Record<string, Partial<Record<Lang, string>>> = {
  [CANNED.en]: {
    uk: "Привіт, Олено, це суддя з хакатону. Як минає твій день? Звідки ти телефонуєш?",
    ru: "Привет, Олена, это судья с хакатона. Как проходит твой день? Откуда ты звонишь?",
    es: "Hola Olena, soy un juez del hackathon. ¿Cómo va tu día? ¿Desde dónde llamas?",
  },
  [CANNED.es]: {
    en: "Hi, my name is Diego. I'm doing very well, thanks. I'm in Madrid today.",
    uk: "Привіт, мене звати Дієго. У мене все дуже добре, дякую. Сьогодні я в Мадриді.",
    ru: "Привет, меня зовут Диего. У меня всё очень хорошо, спасибо. Сегодня я в Мадриде.",
  },
  [CANNED.ru]: {
    en: "Hi, my name is Olena. I'm doing well, thanks. I'm calling from Kyiv.",
    es: "Hola, me llamo Olena. Estoy bien, gracias. Llamo desde Kiev.",
    uk: CANNED.uk,
  },
  [CANNED.uk]: {
    en: "Hi, my name is Olena. I'm doing well, thanks. I'm calling from Kyiv.",
    es: "Hola, me llamo Olena. Estoy bien, gracias. Llamo desde Kiev.",
    ru: CANNED.ru,
  },
};

const VOICED_RMS = 300;
const MIN_VOICED_FRAMES = 10;
const END_SILENCE_FRAMES = 15; // 300ms, like Deepgram endpointing=300

/** Energy-VAD "recognizer": one canned final per burst of speech followed by silence. */
export class FakeStt extends EventEmitter<SttEvents> {
  private voiced = 0;
  private silent = 0;

  constructor(private readonly lang: Lang) {
    super();
  }

  write(ulawFrame: Buffer): void {
    if (frameRms(ulawFrame) > VOICED_RMS) {
      this.voiced++;
      this.silent = 0;
      return;
    }
    if (this.voiced === 0) return;
    if (++this.silent < END_SILENCE_FRAMES) return;
    if (this.voiced >= MIN_VOICED_FRAMES) {
      this.emit("transcript", { text: CANNED[this.lang], isFinal: true, speechFinal: true, at: Date.now() });
    }
    this.voiced = 0;
    this.silent = 0;
  }

  close(): void {}
}

export async function* fakeTranslate(opts: TranslateOpts): AsyncIterable<string> {
  const text = DICTIONARY[opts.text]?.[opts.dst] ?? `[${opts.dst}] ${opts.text}`;
  const words = text.split(/(?<= )/); // keep the trailing space on each word
  for (const w of words) {
    if (opts.signal?.aborted) return;
    yield w;
    await sleep(5);
  }
}

const SAY_VOICE: Record<Lang, string> = { en: "Samantha", es: "Paulina", uk: "Lesya", ru: "Milena", pl: "Zosia" };

function tone(ms: number): Buffer {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));
  return pcm16ToMulaw(pcm);
}

function say(voice: string, text: string): Promise<Buffer> {
  const file = join(tmpdir(), `fake-tts-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  return new Promise<Buffer>((resolve, reject) => {
    execFile("say", ["-v", voice, "-o", file, "--data-format=LEI16@8000", text], (err) => {
      if (err) return reject(err);
      readFile(file)
        .then((wav) => resolve(pcm16ToMulaw(decodeWav(wav).pcm)))
        .catch(reject)
        .finally(() => unlink(file).catch(() => {}));
    });
  });
}

/** Renders each flushed buffer with macOS `say` (or a tone when FAKE_TTS=tone / `say` is missing). */
export class FakeTts extends EventEmitter<TtsEvents> {
  private buffer = "";
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(_voiceId: string, private readonly lang: Lang) {
    super();
  }

  sendText(chunk: string): void {
    this.buffer += chunk;
  }

  flush(): void {
    const text = this.buffer.trim();
    this.buffer = "";
    if (!text) return;
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      let audio: Buffer;
      if (process.env.FAKE_TTS === "tone") {
        audio = tone(400);
      } else {
        audio = await say(SAY_VOICE[this.lang], text).catch(() => tone(400));
      }
      if (this.closed) return;
      this.emit("audio", audio);
      this.emit("done");
    });
  }

  setVoice(_voiceId: string): void {}

  close(): void {
    this.closed = true;
  }
}

export const fakePipeline: Pipeline = {
  name: "fake",
  createStt: (lang) => new FakeStt(lang),
  translate: fakeTranslate,
  prewarmTranslate: async () => {},
  createTts: (voiceId, lang) => new FakeTts(voiceId, lang),
};
