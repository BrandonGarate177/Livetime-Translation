import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { TtsStream, elevenUrl, parseElevenMessage } from "./tts.js";
import { FakeSocket } from "./testing/fake-socket.js";

beforeEach(() => FakeSocket.reset());

const b64 = (s: string) => Buffer.from(s).toString("base64");

function make(voice = "v1") {
  const tts = new TtsStream(voice, "uk", { connect: FakeSocket.connect });
  const events: string[] = [];
  tts.on("audio", (b) => events.push(`audio:${b.toString()}`));
  tts.on("done", () => events.push("done"));
  return { tts, events };
}

test("elevenUrl streams μ-law 8k from the Flash model in the target language and stays warm as long as allowed", () => {
  const url = new URL(elevenUrl("voice123", "uk"));
  assert.equal(url.host, "api.elevenlabs.io");
  assert.equal(url.pathname, "/v1/text-to-speech/voice123/stream-input");
  assert.equal(url.searchParams.get("output_format"), "ulaw_8000");
  assert.equal(url.searchParams.get("model_id"), "eleven_flash_v2_5");
  assert.equal(url.searchParams.get("language_code"), "uk");
  assert.equal(url.searchParams.get("inactivity_timeout"), "180");
});

test("parseElevenMessage decodes audio chunks and the final marker", () => {
  assert.deepEqual(parseElevenMessage(JSON.stringify({ audio: b64("abc"), isFinal: null })), { audio: Buffer.from("abc") });
  assert.deepEqual(parseElevenMessage(JSON.stringify({ audio: null, isFinal: true })), { done: true });
  assert.equal(parseElevenMessage(JSON.stringify({ message: "x" })), undefined);
});

test("TtsStream prewarms a socket, sends the init message first, then text, then end-of-stream on flush", () => {
  const { tts, events } = make();
  assert.equal(FakeSocket.all.length, 1, "one warm socket per stream");
  const [ws] = FakeSocket.all;
  assert.ok("xi-api-key" in ws.headers, "authenticates with the xi-api-key header");
  tts.sendText("Привіт, ");
  tts.sendText("Олено.");
  assert.equal(ws.sent.length, 0, "buffers until open");
  ws.open();
  const msgs = ws.jsonSent;
  assert.equal(msgs[0].text, " ");
  assert.ok(msgs[0].voice_settings, "init carries voice settings");
  assert.deepEqual(msgs.slice(1).map((m) => m.text), ["Привіт, ", "Олено."]);
  tts.flush();
  assert.deepEqual(ws.jsonSent.at(-1), { text: "" });
  ws.reply({ audio: b64("A1"), isFinal: null });
  ws.reply({ audio: null, isFinal: true });
  assert.deepEqual(events, ["audio:A1", "done"]);
  assert.equal(FakeSocket.all.length, 2, "a fresh spare was opened for the next utterance");
  tts.close();
});

test("TtsStream keeps utterances in order: later audio waits for the earlier done", () => {
  const { tts, events } = make();
  const [ws1] = FakeSocket.all;
  ws1.open();
  tts.sendText("one.");
  tts.flush();
  const ws2 = FakeSocket.all[1];
  ws2.open();
  tts.sendText("two.");
  tts.flush();
  ws2.reply({ audio: b64("B1"), isFinal: null });
  ws1.reply({ audio: b64("A1"), isFinal: null });
  assert.deepEqual(events, ["audio:A1"]);
  ws1.reply({ audio: null, isFinal: true });
  assert.deepEqual(events, ["audio:A1", "done", "audio:B1"]);
  ws2.reply({ audio: b64("B2"), isFinal: null });
  ws2.reply({ audio: null, isFinal: true });
  assert.deepEqual(events, ["audio:A1", "done", "audio:B1", "audio:B2", "done"]);
  tts.close();
});

test("TtsStream.setVoice swaps the voice for the next utterance and drops the stale spare", () => {
  const { tts } = make("v1");
  const [spare] = FakeSocket.all;
  spare.open();
  tts.setVoice("v2");
  assert.equal(spare.closed, true);
  tts.sendText("hi.");
  const next = FakeSocket.all.at(-1)!;
  assert.match(next.url, /\/v2\/stream-input/);
  tts.close();
});

test("TtsStream flush without text reports done without touching the socket", async () => {
  const { tts, events } = make();
  const [ws] = FakeSocket.all;
  ws.open();
  tts.flush();
  await once(tts, "done");
  assert.deepEqual(events, ["done"]);
  assert.equal(ws.sent.length, 1, "only the init message went out");
  tts.close();
});

test("TtsStream treats a socket that closes early as the end of that utterance", () => {
  const { tts, events } = make();
  const [ws] = FakeSocket.all;
  ws.open();
  tts.sendText("hi.");
  tts.flush();
  ws.reply({ audio: b64("A1"), isFinal: null });
  ws.close();
  assert.deepEqual(events, ["audio:A1", "done"]);
  tts.close();
});

test("TtsStream.close closes every socket and stops emitting", () => {
  const { tts, events } = make();
  const [ws] = FakeSocket.all;
  ws.open();
  tts.sendText("hi.");
  tts.flush();
  tts.close();
  assert.ok(FakeSocket.all.every((s) => s.closed));
  ws.reply({ audio: b64("late"), isFinal: null });
  assert.deepEqual(events, []);
});
