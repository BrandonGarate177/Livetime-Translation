import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { adaptSttModule, adaptTranslateModule, adaptTtsModule } from "../src/pipeline/index.js";

test("adaptSttModule wraps a createStt/send module into write() and stamps `at`", () => {
  const inner = Object.assign(new EventEmitter(), { sent: [] as Buffer[], send(b: Buffer) { this.sent.push(b); }, close() {} });
  let seen: unknown;
  const createStt = (opts: { lang: string }) => { seen = opts; return inner; };
  const stt = adaptSttModule({ createStt })("uk");
  stt.write(Buffer.alloc(160));
  assert.deepEqual(seen, { lang: "uk" });
  assert.equal(inner.sent.length, 1);
  const got: { text: string; at: number }[] = [];
  stt.on("transcript", (t) => got.push(t));
  inner.emit("transcript", { text: "hi", isFinal: true, speechFinal: true });
  assert.equal(got[0].text, "hi");
  assert.ok(got[0].at > 0, "missing `at` is stamped");
});

test("adaptSttModule accepts the issue-#6 SttStream class with write()", () => {
  class SttStream extends EventEmitter { constructor(public lang: string) { super(); } written = 0; write() { this.written++; } close() {} }
  const stt = adaptSttModule({ SttStream })("en");
  stt.write(Buffer.alloc(160));
  assert.equal((stt as unknown as { inner: SttStream }).inner.written, 1);
});

test("adaptTranslateModule exposes translate and a no-op prewarm when absent", async () => {
  async function* translate() { yield "a"; yield "b"; }
  const t = adaptTranslateModule({ translate });
  const out: string[] = [];
  for await (const c of t.translate({ text: "x", src: "en", dst: "uk", history: [] })) out.push(c);
  assert.deepEqual(out, ["a", "b"]);
  await t.prewarmTranslate();
});

test("adaptTtsModule forwards audio/done and supports createTts or TtsStream", async () => {
  const inner = Object.assign(new EventEmitter(), { text: "", flushed: 0, sendText(c: string) { this.text += c; }, flush() { this.flushed++; }, setVoice() {}, close() {} });
  const tts = adaptTtsModule({ createTts: () => inner })("v1", "uk");
  const events: string[] = [];
  tts.on("audio", (b) => events.push(`audio:${b.length}`));
  tts.on("done", () => events.push("done"));
  tts.sendText("hey");
  tts.flush();
  inner.emit("audio", Buffer.alloc(320));
  inner.emit("done");
  assert.equal(inner.text, "hey");
  assert.equal(inner.flushed, 1);
  assert.deepEqual(events, ["audio:320", "done"]);
});
