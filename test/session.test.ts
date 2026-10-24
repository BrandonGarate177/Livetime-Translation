import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { Leg } from "../src/call/leg.js";
import { CallSession } from "../src/call/session.js";
import { config, type Persona } from "../src/config.js";
import { DICTIONARY, CANNED, fakePipeline } from "../src/pipeline/fake.js";
import type { Pipeline, SttLike, TtsLike } from "../src/pipeline/contract.js";

process.env.FAKE_TTS = "tone";

const LOUD = Buffer.alloc(160, 0x00);
const SILENT = Buffer.alloc(160, 0xff);
const OLENA: Persona = { name: "Olena", lang: "uk", forwardTo: "", voiceId: "olena-voice" };

class FakeLeg extends EventEmitter {
  sent: Buffer[] = [];
  isOpen = true;
  callSid: string;
  constructor(public id: "A" | "B") { super(); this.callSid = `CA${id}`; }
  sendAudio(b: Buffer) { this.sent.push(b); }
  close() { this.isOpen = false; }
}
const asLeg = (l: FakeLeg) => l as unknown as Leg;
function speak(leg: FakeLeg) {
  for (let i = 0; i < 20; i++) leg.emit("audio", LOUD);
  for (let i = 0; i < 16; i++) leg.emit("audio", SILENT);
}

test("A's speech reaches B translated, with dashboard events tagged by leg", async () => {
  const s = new CallSession("sid1", OLENA, "translate", "en", fakePipeline);
  const A = new FakeLeg("A"), B = new FakeLeg("B");
  const events: string[] = [];
  s.on("transcript", (e) => events.push(`transcript:${e.leg}:${e.isFinal}`));
  s.on("timing", (e) => events.push(`timing:${e.leg}:${e.firstAudio > 0}`));
  s.attach(asLeg(A));
  s.attach(asLeg(B));
  const got = once(s, "translation");
  speak(A);
  const [tr] = await got;
  assert.equal(tr.leg, "A");
  assert.equal(tr.text, DICTIONARY[CANNED.en].uk);
  await sleep(10);
  assert.equal(B.sent.length, 1, "B heard one utterance");
  assert.equal(A.sent.length, 0, "A heard nothing of its own speech");
  assert.ok(events.includes("transcript:A:true"), events.join());
  assert.ok(events.includes("timing:A:true"), events.join());
  s.end("test");
});

test("speech before the other leg attaches is dropped, later speech is delivered", async () => {
  const s = new CallSession("sid2", OLENA, "translate", "en", fakePipeline);
  const A = new FakeLeg("A"), B = new FakeLeg("B");
  s.attach(asLeg(A));
  const first = once(s, "translation");
  speak(A);
  await first;
  await sleep(10);
  s.attach(asLeg(B));
  const second = once(s, "translation");
  speak(A);
  await second;
  await sleep(10);
  assert.equal(B.sent.length, 1);
  s.end("test");
});

test("end aborts an in-flight translation and sends no audio afterwards", async () => {
  let firstChunk!: () => void;
  const gotFirst = new Promise<void>((r) => (firstChunk = r));
  let sawAbort = false;
  const stt = new EventEmitter() as SttLike; stt.write = () => {}; stt.close = () => {};
  const tts = new EventEmitter() as TtsLike; tts.sendText = () => {}; tts.setVoice = () => {}; tts.close = () => {};
  tts.flush = () => { tts.emit("audio", Buffer.alloc(800)); tts.emit("done"); };
  const pipeline: Pipeline = {
    name: "stub",
    createStt: () => stt,
    createTts: () => tts,
    prewarmTranslate: async () => {},
    translate: async function* ({ signal }) {
      yield "Прив";
      firstChunk();
      for (let i = 0; i < 20 && !signal?.aborted; i++) await sleep(10);
      sawAbort = !!signal?.aborted;
      yield "іт";
    },
  };
  const s = new CallSession("sid3", OLENA, "translate", "en", pipeline);
  const A = new FakeLeg("A"), B = new FakeLeg("B");
  s.attach(asLeg(A));
  s.attach(asLeg(B));
  stt.emit("transcript", { text: "hello", isFinal: true, speechFinal: true, at: Date.now() });
  await gotFirst;
  s.end("hangup");
  await sleep(50);
  assert.equal(sawAbort, true);
  assert.equal(B.sent.length, 0);
});

test("same language on both legs relays raw audio", async () => {
  const s = new CallSession("sid4", { ...OLENA, lang: "en" }, "translate", "en", fakePipeline);
  const A = new FakeLeg("A"), B = new FakeLeg("B");
  s.attach(asLeg(A));
  s.attach(asLeg(B));
  const frame = Buffer.from([1, 2, 3, 4]);
  A.emit("audio", frame);
  assert.equal(B.sent.length, 1);
  assert.deepEqual(B.sent[0], frame);
  s.end("test");
});

test("warns loudly when a leg would be synthesized with an empty voice id", () => {
  const warnings: string[] = [];
  const orig = console.log;
  // A developer's .env may set the fallback voices, so blank them for this test.
  const { fallbackVoiceM, fallbackVoiceF } = config;
  config.fallbackVoiceM = "";
  config.fallbackVoiceF = "";
  console.log = (msg: string) => { if (/voice/i.test(msg)) warnings.push(msg); };
  try {
    const s = new CallSession("sid5", { ...OLENA, voiceId: "" }, "translate", "en", fakePipeline);
    s.attach(asLeg(new FakeLeg("A"))); // B hears A in FALLBACK_VOICE_M, blanked above
    s.attach(asLeg(new FakeLeg("B"))); // A hears persona.voiceId || FALLBACK_VOICE_F, both ""
    s.end("test");
  } finally {
    console.log = orig;
    Object.assign(config, { fallbackVoiceM, fallbackVoiceF });
  }
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[0], /FALLBACK_VOICE_M/);
  assert.match(warnings[1], /FALLBACK_VOICE_F/);
});
