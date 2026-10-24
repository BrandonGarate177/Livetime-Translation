import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { Leg } from "../src/call/leg.js";
import { Direction } from "../src/call/direction.js";
import { CANNED, DICTIONARY, FakeStt, fakePipeline } from "../src/pipeline/fake.js";
import type { Pipeline, SttLike, Transcript, TtsLike, Turn } from "../src/pipeline/contract.js";

process.env.FAKE_TTS = "tone";

const LOUD = Buffer.alloc(160, 0x00);
const SILENT = Buffer.alloc(160, 0xff);

class FakeLeg extends EventEmitter {
  sent: Buffer[] = [];
  isOpen = true;
  constructor(public id: "A" | "B") { super(); }
  sendAudio(b: Buffer) { this.sent.push(b); }
}
const asLeg = (l: FakeLeg) => l as unknown as Leg;

function speak(leg: FakeLeg) {
  for (let i = 0; i < 20; i++) leg.emit("audio", LOUD);
  for (let i = 0; i < 16; i++) leg.emit("audio", SILENT);
}

/** STT that emits exactly what the test hands it; TTS that records text and emits a tone per flush. */
function stubPipeline(over: Partial<Pipeline> = {}) {
  const stt = new EventEmitter() as SttLike;
  stt.write = () => {};
  stt.close = () => {};
  const tts = new EventEmitter() as TtsLike & { text: string[] };
  tts.text = [];
  tts.sendText = (c) => tts.text.push(c);
  tts.flush = () => { tts.emit("audio", Buffer.alloc(800)); tts.emit("done"); };
  tts.setVoice = () => {};
  tts.close = () => {};
  const pipeline: Pipeline = {
    name: "stub",
    createStt: () => stt,
    translate: async function* ({ text }) { yield `[uk] ${text}`; },
    prewarmTranslate: async () => {},
    createTts: () => tts,
    ...over,
  };
  const final = (text: string): Transcript => ({ text, isFinal: true, speechFinal: true, at: Date.now() });
  return { pipeline, stt, tts, final };
}

function direction(pipeline: Pipeline, from: FakeLeg, to: FakeLeg | undefined, history: Turn[] = []) {
  const d = new Direction({ pipeline, from: asLeg(from), to: () => (to ? asLeg(to) : undefined), srcLang: "en", dstLang: "uk", voiceId: "v", history, log: () => {} });
  d.start();
  return d;
}

test("translates a final transcript and plays it on the other leg", async () => {
  const A = new FakeLeg("A"), B = new FakeLeg("B");
  const d = direction(fakePipeline, A, B);
  const timings: { speechEnd: number; transcript: number; firstToken: number; firstAudio: number }[] = [];
  d.on("timing", (t) => timings.push(t));
  const got = once(d, "translation");
  speak(A);
  const [tr] = await got;
  assert.equal(tr.text, DICTIONARY[CANNED.en].uk);
  await sleep(10);
  assert.equal(B.sent.length, 1);
  assert.equal(timings.length, 1);
  const t = timings[0];
  assert.ok(t.speechEnd > 0 && t.transcript >= t.speechEnd && t.firstToken >= t.transcript && t.firstAudio >= t.firstToken, JSON.stringify(t));
  d.close();
});

test("ignores empty finals", async () => {
  const { pipeline, stt, final } = stubPipeline();
  const history: Turn[] = [];
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"), history);
  let translations = 0;
  d.on("translation", () => translations++);
  stt.emit("transcript", final("   "));
  stt.emit("transcript", { text: "interim", isFinal: false, speechFinal: false, at: Date.now() });
  await sleep(20);
  assert.equal(translations, 0);
  assert.equal(history.length, 0);
  d.close();
});

test("survives a failing translate", async () => {
  let calls = 0;
  const { pipeline, stt, final } = stubPipeline({
    translate: async function* ({ text }) { if (++calls === 1) throw new Error("boom"); yield `[uk] ${text}`; },
  });
  const B = new FakeLeg("B");
  const d = direction(pipeline, new FakeLeg("A"), B);
  stt.emit("transcript", final("first"));
  await sleep(10);
  const got = once(d, "translation");
  stt.emit("transcript", final("second"));
  const [tr] = await got;
  assert.equal(tr.text, "[uk] second");
  assert.equal(B.sent.length, 1);
  d.close();
});

test("keeps history at three turns", async () => {
  const { pipeline, stt, final } = stubPipeline();
  const history: Turn[] = [];
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"), history);
  for (const t of ["one", "two", "three", "four"]) stt.emit("transcript", final(t));
  await sleep(30);
  assert.equal(history.length, 3);
  assert.equal(history[0].text, "two");
  assert.equal(history[2].translation, "[uk] four");
  d.close();
});

test("runs translations in order", async () => {
  const { pipeline, stt, tts, final } = stubPipeline({
    translate: async function* ({ text }) { if (text === "slow") await sleep(50); yield `${text}-1 `; yield `${text}-2 `; },
  });
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"));
  stt.emit("transcript", final("slow"));
  stt.emit("transcript", final("fast"));
  await sleep(120);
  assert.deepEqual(tts.text, ["slow-1 ", "slow-2 ", "fast-1 ", "fast-2 "]);
  d.close();
});

test("drops audio when the listener is gone", async () => {
  const { pipeline, stt, final } = stubPipeline();
  const d = direction(pipeline, new FakeLeg("A"), undefined);
  const got = once(d, "translation");
  stt.emit("transcript", final("hello"));
  await got;
  await sleep(10);
  d.close();
});

test("start creates STT and TTS once and prewarms translate; close tears them down", async () => {
  let created = { stt: 0, tts: 0, prewarm: 0, closed: 0 };
  const { pipeline, stt, tts } = stubPipeline({ prewarmTranslate: async () => { created.prewarm++; } });
  const inner = pipeline;
  const spy: Pipeline = { ...inner, createStt: (l) => { created.stt++; return inner.createStt(l); }, createTts: (v, l) => { created.tts++; return inner.createTts(v, l); } };
  stt.close = () => created.closed++;
  tts.close = () => created.closed++;
  const d = direction(spy, new FakeLeg("A"), new FakeLeg("B"));
  await sleep(5);
  assert.deepEqual(created, { stt: 1, tts: 1, prewarm: 1, closed: 0 });
  d.close();
  assert.equal(created.closed, 2);
});

// FakeStt is the simulator's recognizer: make sure the speak() helper above really triggers it.
test("speak() helper drives FakeStt to one final", () => {
  const stt = new FakeStt("en");
  let n = 0;
  stt.on("transcript", () => n++);
  const leg = new FakeLeg("A");
  leg.on("audio", (f) => stt.write(f));
  speak(leg);
  assert.equal(n, 1);
});
