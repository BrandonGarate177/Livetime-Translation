// Streams an 8 kHz WAV into Deepgram at real time and prints interim/final transcripts with timing.
//   npx tsx scripts/try-stt.ts test-audio/uk-hello.wav uk
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { FRAME_BYTES, SAMPLE_RATE, decodeWav, pcm16ToMulaw } from "../src/audio/mulaw.js";
import type { Lang } from "../src/config.js";
import { SttStream } from "../src/pipeline/stt.js";

const [file, lang = "en"] = process.argv.slice(2);
if (!file) {
  console.error("usage: npx tsx scripts/try-stt.ts <8k mono wav> [en|es|uk|ru]");
  process.exit(1);
}
const { pcm, sampleRate } = decodeWav(readFileSync(file));
if (sampleRate !== SAMPLE_RATE) throw new Error(`need 8 kHz audio, got ${sampleRate}`);
const ulaw = pcm16ToMulaw(pcm);

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
const stt = new SttStream(lang as Lang);
stt.on("transcript", (t) => console.log(`${stamp()} ${t.speechFinal ? "SPEECH_FINAL" : t.isFinal ? "final" : "interim"}: ${t.text}`));
stt.on("utteranceEnd", () => console.log(`${stamp()} utterance end`));
stt.on("error", (e) => console.error(`${stamp()} error: ${e.message}`));

const silence = Buffer.alloc(FRAME_BYTES, 0xff);
const audioSec = ulaw.length / SAMPLE_RATE;
console.log(`streaming ${audioSec.toFixed(1)}s of ${lang} audio + 2s silence`);
for (let i = 0; i < ulaw.length + SAMPLE_RATE * 2; i += FRAME_BYTES) {
  stt.write(i < ulaw.length ? ulaw.subarray(i, i + FRAME_BYTES) : silence);
  await sleep(20);
}
await sleep(1500);
stt.close();
