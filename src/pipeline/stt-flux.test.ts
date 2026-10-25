import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FRAME_BYTES } from "../audio/mulaw.js";
import type { Transcript } from "./contract.js";
import { FluxStream, SttStream, createStt, fluxModelFor, fluxUrl, parseFluxMessage } from "./stt.js";
import { FakeSocket } from "./testing/fake-socket.js";

beforeEach(() => FakeSocket.reset());

const turn = (event: string, transcript: string, extra: object = {}) =>
  JSON.stringify({ type: "TurnInfo", event, turn_index: 0, transcript, words: [], end_of_turn_confidence: 0.9, ...extra });

test("fluxModelFor: English always, es/ru only when opted in, never uk/pl", () => {
  assert.equal(fluxModelFor("en", []), "flux-general-en");
  assert.equal(fluxModelFor("es", []), undefined, "multi is opt-in: it measured no faster than Nova-3 for es");
  assert.equal(fluxModelFor("es", ["es"]), "flux-general-multi");
  assert.equal(fluxModelFor("ru", ["es", "ru"]), "flux-general-multi");
  assert.equal(fluxModelFor("uk", ["uk"]), undefined);
  assert.equal(fluxModelFor("pl", ["pl"]), undefined);
});

test("fluxUrl targets v2 with mulaw 8k, the turn thresholds, and a language hint only for the multi model", () => {
  const en = new URL(fluxUrl("en", []));
  assert.equal(en.pathname, "/v2/listen");
  assert.equal(en.searchParams.get("model"), "flux-general-en");
  assert.equal(en.searchParams.get("encoding"), "mulaw");
  assert.equal(en.searchParams.get("sample_rate"), "8000");
  assert.ok(en.searchParams.get("eot_threshold"));
  assert.ok(en.searchParams.get("eot_timeout_ms"));
  assert.equal(en.searchParams.get("language_hint"), null);
  const es = new URL(fluxUrl("es", ["es"]));
  assert.equal(es.searchParams.get("model"), "flux-general-multi");
  assert.equal(es.searchParams.get("language_hint"), "es");
});

test("parseFluxMessage maps Update to interim and EndOfTurn to a final, timestamped transcript", () => {
  const before = Date.now();
  const u = parseFluxMessage(turn("Update", "hi there"))!;
  assert.deepEqual([u.text, u.isFinal, u.speechFinal], ["hi there", false, false]);
  const e = parseFluxMessage(turn("EndOfTurn", "hi there, how are you?", { trigger: "model" }))!;
  assert.deepEqual([e.text, e.isFinal, e.speechFinal], ["hi there, how are you?", true, true]);
  assert.ok(e.at >= before && e.at <= Date.now());
  assert.equal(parseFluxMessage(turn("EndOfTurn", "   ")), undefined, "empty turns are dropped");
  assert.equal(parseFluxMessage(JSON.stringify({ type: "Connected", request_id: "x", sequence_id: 0 })), undefined);
});

test("FluxStream batches 20 ms frames into 80 ms chunks before sending", () => {
  const stt = new FluxStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  ws.open();
  const f = (v: number) => Buffer.alloc(FRAME_BYTES, v);
  stt.write(f(1));
  stt.write(f(2));
  stt.write(f(3));
  assert.equal(ws.binarySent.length, 0, "three frames are still buffered");
  stt.write(f(4));
  assert.equal(ws.binarySent.length, 1);
  assert.equal(ws.binarySent[0].length, FRAME_BYTES * 4);
  assert.deepEqual(ws.binarySent[0], Buffer.concat([f(1), f(2), f(3), f(4)]));
  stt.close();
});

test("FluxStream buffers audio until the socket opens and sends CloseStream on close", () => {
  const stt = new FluxStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  assert.equal(ws.headers.Authorization.startsWith("Token "), true);
  for (let i = 0; i < 8; i++) stt.write(Buffer.alloc(FRAME_BYTES, 0xff));
  assert.equal(ws.sent.length, 0);
  ws.open();
  assert.equal(ws.binarySent.length, 2);
  stt.close();
  assert.deepEqual(ws.jsonSent.at(-1), { type: "CloseStream" });
  assert.equal(ws.closed, true);
});

test("FluxStream emits transcripts, the eager/resumed turn signals, and errors", () => {
  const stt = new FluxStream("en", { connect: FakeSocket.connect });
  const [ws] = FakeSocket.all;
  ws.open();
  const got: Transcript[] = [];
  const signals: string[] = [];
  const errors: string[] = [];
  stt.on("transcript", (t) => got.push(t));
  stt.on("eagerEndOfTurn", (t) => signals.push(`eager:${t.text}`));
  stt.on("turnResumed", () => signals.push("resumed"));
  stt.on("error", (e) => errors.push(e.message));
  ws.reply({ type: "Connected", request_id: "r", sequence_id: 0 });
  ws.emit("message", Buffer.from(turn("StartOfTurn", "hi")));
  ws.emit("message", Buffer.from(turn("Update", "hi there")));
  ws.emit("message", Buffer.from(turn("EagerEndOfTurn", "hi there.")));
  ws.emit("message", Buffer.from(turn("TurnResumed", "hi there.")));
  ws.emit("message", Buffer.from(turn("EndOfTurn", "hi there. bye.", { trigger: "model" })));
  ws.reply({ type: "Error", sequence_id: 9, code: "BAD", description: "nope" });
  assert.deepEqual(
    got.map((t) => [t.text, t.isFinal]),
    [
      ["hi", false],
      ["hi there", false],
      ["hi there. bye.", true],
    ],
  );
  assert.deepEqual(signals, ["eager:hi there.", "resumed"]);
  assert.deepEqual(errors, ["deepgram flux BAD: nope"]);
  stt.close();
});

test("createStt uses Flux where the engine allows it and Nova-3 elsewhere", () => {
  const made = [
    createStt({ lang: "en", engine: "flux", connect: FakeSocket.connect }),
    createStt({ lang: "es", engine: "flux", connect: FakeSocket.connect, multiLangs: ["es"] }),
    createStt({ lang: "uk", engine: "flux", connect: FakeSocket.connect, multiLangs: ["uk"] }),
    createStt({ lang: "en", engine: "nova3", connect: FakeSocket.connect }),
  ];
  assert.deepEqual(
    made.map((s) => (s instanceof FluxStream ? "flux" : s instanceof SttStream ? "nova3" : "?")),
    ["flux", "flux", "nova3", "nova3"],
  );
  for (const s of made) s.close(); // Nova streams own a keepalive timer; leaving one running hangs the test runner
});
