import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CANNED, DICTIONARY, FakeStt, FakeTts, fakeTranslate } from "../src/pipeline/fake.js";

const LOUD = Buffer.alloc(160, 0x00); // μ-law 0x00 decodes to -8031: loud
const SILENT = Buffer.alloc(160, 0xff); // μ-law 0xff decodes to 0

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test("FakeStt emits a canned final after speech then silence", async () => {
  const stt = new FakeStt("en");
  const got: unknown[] = [];
  stt.on("transcript", (t) => got.push(t));
  for (let i = 0; i < 20; i++) stt.write(LOUD);
  for (let i = 0; i < 16; i++) stt.write(SILENT);
  assert.equal(got.length, 1);
  const t = got[0] as { text: string; isFinal: boolean; speechFinal: boolean; at: number };
  assert.equal(t.text, CANNED.en);
  assert.equal(t.isFinal, true);
  assert.equal(t.speechFinal, true);
  assert.ok(t.at > 0);
});

test("FakeStt stays quiet on silence", () => {
  const stt = new FakeStt("uk");
  let n = 0;
  stt.on("transcript", () => n++);
  for (let i = 0; i < 50; i++) stt.write(SILENT);
  assert.equal(n, 0);
});

test("fakeTranslate uses the dictionary", async () => {
  const chunks = await collect(fakeTranslate({ text: CANNED.en, src: "en", dst: "uk", history: [] }));
  assert.ok(chunks.length > 1, "streams in more than one chunk");
  assert.equal(chunks.join(""), DICTIONARY[CANNED.en].uk);
});

test("fakeTranslate falls back to a tag", async () => {
  const chunks = await collect(fakeTranslate({ text: "xyz", src: "en", dst: "es", history: [] }));
  assert.equal(chunks.join(""), "[es] xyz");
});

test("fakeTranslate stops when aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const chunks = await collect(fakeTranslate({ text: CANNED.en, src: "en", dst: "uk", history: [], signal: ac.signal }));
  assert.equal(chunks.length, 0);
});

test("FakeTts emits audio then done", async () => {
  process.env.FAKE_TTS = "tone";
  const tts = new FakeTts("voice", "en");
  const order: string[] = [];
  tts.on("audio", (b) => order.push(`audio:${b.length}`));
  tts.on("done", () => order.push("done"));
  tts.sendText("hello ");
  tts.sendText("world");
  tts.flush();
  await once(tts, "done");
  assert.deepEqual(order, ["audio:3200", "done"]);
});
