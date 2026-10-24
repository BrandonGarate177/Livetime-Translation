// Streams one translation and reports time-to-first-token. Use it for the provider bake-off (#7).
//   TRANSLATE_PROVIDER=groq npx tsx scripts/try-translate.ts en uk "Hi Olena, how is your day going?"
import type { Lang } from "../src/config.js";
import { config } from "../src/config.js";
import { prewarm, translate } from "../src/pipeline/translate.js";

const [src = "en", dst = "uk", ...rest] = process.argv.slice(2);
const text = rest.join(" ") || "Hi Olena, this is a judge from the hackathon. How is your day going?";

console.log(`provider=${config.translateProvider} ${src}→${dst}: ${text}`);
const warm0 = Date.now();
await prewarm();
console.log(`prewarm ${Date.now() - warm0} ms`);

const t0 = Date.now();
let first: number | undefined;
let out = "";
for await (const chunk of translate({ text, src: src as Lang, dst: dst as Lang, history: [] })) {
  first ??= Date.now() - t0;
  out += chunk;
  process.stdout.write(chunk);
}
console.log(`\nTTFT ${first ?? "n/a"} ms, total ${Date.now() - t0} ms, ${out.length} chars`);
