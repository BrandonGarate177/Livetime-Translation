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

// --- Review fixes ---

test("a throwing event listener does not poison the queue", async () => {
  const { pipeline, stt, final } = stubPipeline();
  const B = new FakeLeg("B");
  const d = direction(pipeline, new FakeLeg("A"), B);
  let seen = 0;
  d.on("translation", () => { if (++seen === 1) throw new Error("dashboard listener blew up"); });
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    stt.emit("transcript", final("first"));
    await sleep(20);
    stt.emit("transcript", final("second"));
    await sleep(20);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.equal(seen, 2, "second utterance was still translated");
  assert.equal(B.sent.length, 2);
  assert.deepEqual(unhandled, []);
  d.close();
});

test("a translate failure after chunks were sent still flushes the TTS utterance", async () => {
  let calls = 0;
  const flushes: string[][] = [];
  const { pipeline, stt, tts, final } = stubPipeline({
    translate: async function* ({ text }) {
      if (++calls === 1) { yield "half "; throw new Error("provider died mid-stream"); }
      yield `${text} `;
    },
  });
  const realFlush = tts.flush;
  tts.flush = () => { flushes.push([...tts.text]); tts.text.length = 0; realFlush(); };
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"));
  stt.emit("transcript", final("one"));
  await sleep(20);
  assert.deepEqual(flushes, [["half "]], "the dangling fragment was flushed, not left open");
  stt.emit("transcript", final("two"));
  await sleep(20);
  assert.deepEqual(flushes, [["half "], ["two "]], "next utterance is not glued to the stale fragment");
  d.close();
});

test("a flush that yields done without audio does not shift timing onto the next utterance", async () => {
  let flushes = 0;
  const { pipeline, stt, tts } = stubPipeline();
  tts.flush = () => { if (++flushes === 1) { tts.emit("done"); return; } tts.emit("audio", Buffer.alloc(800)); tts.emit("done"); };
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"));
  const timings: { transcript: number }[] = [];
  d.on("timing", (t) => timings.push(t));
  stt.emit("transcript", { text: "one", isFinal: true, speechFinal: true, at: 1000 });
  await sleep(20);
  stt.emit("transcript", { text: "two", isFinal: true, speechFinal: true, at: 2000 });
  await sleep(20);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].transcript, 2000, "timing belongs to the utterance that actually produced audio");
  d.close();
});

test("audio emitted after close is not sent to the listener", async () => {
  const { pipeline, tts } = stubPipeline();
  const B = new FakeLeg("B");
  const d = direction(pipeline, new FakeLeg("A"), B);
  d.close();
  tts.emit("audio", Buffer.alloc(160));
  assert.equal(B.sent.length, 0);
});

test("speechEnd is captured when the transcript arrives, never after it", async () => {
  const { pipeline, stt, final } = stubPipeline({
    translate: async function* ({ text }) { if (text === "slow") await sleep(40); yield `${text} `; },
  });
  const A = new FakeLeg("A");
  const d = direction(pipeline, A, new FakeLeg("B"));
  const timings: { speechEnd: number; transcript: number }[] = [];
  d.on("timing", (t) => timings.push(t));
  A.emit("audio", LOUD);
  stt.emit("transcript", final("slow"));
  stt.emit("transcript", final("fast"));
  await sleep(10);
  A.emit("audio", LOUD); // speaker keeps talking while both jobs are queued
  await sleep(80);
  assert.equal(timings.length, 2);
  for (const t of timings) assert.ok(t.transcript >= t.speechEnd && t.speechEnd > 0, JSON.stringify(t));
  d.close();
});

test("a quiet speaker (no voiced frame seen) gets speechEnd = transcript time, not 0", async () => {
  const { pipeline, stt } = stubPipeline();
  const d = direction(pipeline, new FakeLeg("A"), new FakeLeg("B"));
  const timings: { speechEnd: number; transcript: number }[] = [];
  d.on("timing", (t) => timings.push(t));
  stt.emit("transcript", { text: "whisper", isFinal: true, speechFinal: true, at: 5000 });
  await sleep(20);
  assert.deepEqual(timings.map((t) => t.speechEnd), [5000]);
  d.close();
});
