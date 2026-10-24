// Synthesizes one sentence to out/tts-<lang>.wav and reports time-to-first-byte on a warm socket.
//   npx tsx scripts/try-tts.ts <voiceId> uk "Привіт, Олено. Як минає твій день?"
import { mkdirSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeWav, mulawToPcm16 } from "../src/audio/mulaw.js";
import type { Lang } from "../src/config.js";
import { TtsStream } from "../src/pipeline/tts.js";

const [voiceId, lang = "en", ...rest] = process.argv.slice(2);
if (!voiceId) {
  console.error('usage: npx tsx scripts/try-tts.ts <voiceId> [en|es|uk|ru] "text"');
  process.exit(1);
}
const text = rest.join(" ") || "Hi Olena, this is a judge from the hackathon. How is your day going?";

const tts = new TtsStream(voiceId, lang as Lang);
tts.on("error", (e) => console.error(`error: ${e.message}`));
await sleep(1500); // let the spare socket open, as it would during the consent prompt

const chunks: Buffer[] = [];
const t0 = Date.now();
let first: number | undefined;
tts.on("audio", (b) => {
  first ??= Date.now() - t0;
  chunks.push(b);
});
// Feed it word by word like the translator does.
for (const word of text.split(/(?<= )/)) tts.sendText(word);
tts.flush();
await once(tts, "done");
tts.close();

const ulaw = Buffer.concat(chunks);
mkdirSync("out", { recursive: true });
const path = `out/tts-${lang}.wav`;
writeFileSync(path, encodeWav(mulawToPcm16(ulaw)));
console.log(`TTFB ${first ?? "n/a"} ms, total ${Date.now() - t0} ms, ${(ulaw.length / 8000).toFixed(2)}s of audio → ${path}`);
