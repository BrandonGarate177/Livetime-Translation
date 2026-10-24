import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FRAME_BYTES } from "../audio/mulaw.js";
import type { Transcript } from "./contract.js";
import { SttStream, deepgramUrl, parseDeepgramMessage } from "./stt.js";
import { FakeSocket } from "./testing/fake-socket.js";

beforeEach(() => FakeSocket.reset());

const results = (transcript: string, is_final: boolean, speech_final: boolean) => ({
  type: "Results",
  is_final,
  speech_final,
  channel: { alternatives: [{ transcript, confidence: 0.9 }] },
});

test("deepgramUrl asks for mulaw 8k with the leg's language and endpointing", () => {
  const url = new URL(deepgramUrl("uk"));
  assert.equal(url.host, "api.deepgram.com");
  assert.equal(url.pathname, "/v1/listen");
  assert.equal(url.searchParams.get("model"), "nova-3");
  assert.equal(url.searchParams.get("encoding"), "mulaw");
  assert.equal(url.searchParams.get("sample_rate"), "8000");
  assert.equal(url.searchParams.get("language"), "uk");
  assert.equal(url.searchParams.get("endpointing"), "300");
  assert.equal(url.searchParams.get("interim_results"), "true");
  assert.equal(url.searchParams.get("utterance_end_ms"), "1000");
});

test("parseDeepgramMessage turns a Results frame into a timestamped transcript", () => {
  const before = Date.now();
  const t = parseDeepgramMessage(JSON.stringify(results("hello there", true, false)))!;
  assert.equal(t.text, "hello there");
  assert.equal(t.isFinal, true);
  assert.equal(t.speechFinal, false);
  assert.ok(t.at >= before && t.at <= Date.now());
});

test("parseDeepgramMessage ignores empty transcripts and non-Results frames", () => {
  assert.equal(parseDeepgramMessage(JSON.stringify({ type: "Metadata" })), undefined);
  assert.equal(parseDeepgramMessage(JSON.stringify(results("  ", true, true))), undefined);
});

test("SttStream opens on construction, buffers early frames, then streams them as binary", () => {
  const stt = new SttStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  assert.equal(ws.headers.Authorization.startsWith("Token "), true);
  const f1 = Buffer.alloc(FRAME_BYTES, 0xff);
  const f2 = Buffer.alloc(FRAME_BYTES, 0x7f);
  stt.write(f1);
  stt.write(f2);
  assert.equal(ws.sent.length, 0, "nothing goes out before the socket is open");
  ws.open();
  assert.deepEqual(ws.binarySent, [f1, f2]);
  stt.write(f1);
  assert.equal(ws.binarySent.length, 3);
  stt.close();
});

test("SttStream emits transcripts and the UtteranceEnd backstop", () => {
  const stt = new SttStream("uk", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  ws.open();
  const got: Transcript[] = [];
  let ends = 0;
  stt.on("transcript", (t) => got.push(t));
  stt.on("utteranceEnd", () => ends++);
  ws.reply(results("привіт", false, false));
  ws.reply(results("привіт, як справи", true, true));
  ws.reply({ type: "UtteranceEnd", channel: [0], last_word_end: 1.2 });
  assert.deepEqual(
    got.map((t) => [t.text, t.isFinal, t.speechFinal]),
    [
      ["привіт", false, false],
      ["привіт, як справи", true, true],
    ],
  );
  assert.equal(ends, 1);
  stt.close();
});

test("SttStream.close tells Deepgram to finish and drops later frames", () => {
  const stt = new SttStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  ws.open();
  stt.close();
  assert.deepEqual(ws.jsonSent.at(-1), { type: "CloseStream" });
  assert.equal(ws.closed, true);
  stt.write(Buffer.alloc(FRAME_BYTES, 0xff));
  assert.equal(ws.binarySent.length, 0);
});

test("SttStream surfaces socket errors as error events", () => {
  const stt = new SttStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  const errors: Error[] = [];
  stt.on("error", (e) => errors.push(e));
  ws.emit("error", new Error("401"));
  assert.equal(errors[0].message, "401");
  stt.close();
});
