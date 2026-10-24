// Creates an ElevenLabs Instant Voice Clone from one or more recordings and prints the voiceId for PERSONAS_JSON.
//   npx tsx scripts/enroll-voice.ts "Olena" recordings/olena-1.m4a recordings/olena-2.m4a
// Any common audio format works (m4a, mp3, wav); 1–2 minutes of clean speech total is enough.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../src/config.js";

const [name, ...files] = process.argv.slice(2);
if (!name || files.length === 0) {
  console.error('usage: npx tsx scripts/enroll-voice.ts "<persona name>" <audio file> [more files]');
  process.exit(1);
}

const form = new FormData();
form.append("name", name);
form.append("description", `Just Call persona ${name}, enrolled ${new Date().toISOString().slice(0, 10)}`);
form.append("remove_background_noise", "false"); // clean recordings only; isolation lowers quality on them
for (const f of files) form.append("files", new Blob([readFileSync(f)]), basename(f));

const res = await fetch("https://api.elevenlabs.io/v1/voices/add", {
  method: "POST",
  headers: { "xi-api-key": config.elevenlabsApiKey },
  body: form,
});
if (!res.ok) {
  console.error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 400)}`);
  process.exit(1);
}
const { voice_id, requires_verification } = (await res.json()) as { voice_id: string; requires_verification: boolean };
console.log(`voiceId: ${voice_id}${requires_verification ? "  (requires verification in the ElevenLabs UI)" : ""}`);
console.log(`Put it in PERSONAS_JSON as "voiceId":"${voice_id}", then check it with:`);
console.log(`  npx tsx scripts/try-tts.ts ${voice_id} <lang> "a sentence"`);
