import { test } from "node:test";
import assert from "node:assert/strict";
import type { TranslateOpts } from "./contract.js";
import { buildChatMessages, parseSseLine, prewarm, translate, type TranslateBackend } from "./translate.js";

async function collect(it: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of it) out.push(c);
  return out;
}

function fake(name: string, reply: (o: TranslateOpts) => string): TranslateBackend & { calls: TranslateOpts[] } {
  const calls: TranslateOpts[] = [];
  return {
    name,
    calls,
    async *run(opts) {
      calls.push(opts);
      for (const w of reply(opts).split(/(?<= )/)) yield w;
    },
  };
}

const opts: TranslateOpts = { text: "Hello there.", src: "en", dst: "uk", history: [] };

test("the mock backend tags the text with the target language and streams it in chunks", async () => {
  const chunks = await collect(translate(opts, { primary: "mock" }));
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), "[uk] Hello there.");
});

test("translate falls back to the secondary backend when the primary fails before producing text", async () => {
  const primary: TranslateBackend = {
    name: "p",
    async *run() {
      throw new Error("429");
    },
  };
  const fallback = fake("deepl", () => "Привіт.");
  const chunks = await collect(translate(opts, { primary, fallback }));
  assert.equal(chunks.join(""), "Привіт.");
  assert.equal(fallback.calls.length, 1);
});

test("translate rethrows when there is no fallback", async () => {
  const primary: TranslateBackend = {
    name: "p",
    async *run() {
      throw new Error("boom");
    },
  };
  await assert.rejects(collect(translate(opts, { primary })), /boom/);
});

test("translate yields nothing once the signal is aborted", async () => {
  const ac = new AbortController();
  ac.abort();
  const chunks = await collect(translate({ ...opts, signal: ac.signal }, { primary: "mock" }));
  assert.deepEqual(chunks, []);
});

test("buildChatMessages interleaves history as user/assistant turns in their own direction", () => {
  const { system, messages } = buildChatMessages({
    text: "How are you?",
    src: "en",
    dst: "uk",
    history: [
      { src: "en", text: "Hi Olena.", translation: "Привіт, Олено." },
      { src: "uk", text: "Привіт!", translation: "Hi!" },
    ],
  });
  assert.match(system, /English/);
  assert.match(system, /Ukrainian/);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [
      ["user", "[en→uk] Hi Olena."],
      ["assistant", "Привіт, Олено."],
      ["user", "[uk→en] Привіт!"],
      ["assistant", "Hi!"],
      ["user", "[en→uk] How are you?"],
    ],
  );
});

test("parseSseLine extracts streamed content deltas and signals the end", () => {
  assert.equal(parseSseLine('data: {"choices":[{"delta":{"content":"Пр"}}]}'), "Пр");
  assert.equal(parseSseLine('data: {"choices":[{"delta":{"role":"assistant"}}]}'), "");
  assert.equal(parseSseLine("data: [DONE]"), null);
  assert.equal(parseSseLine(""), "");
  assert.equal(parseSseLine(": ping"), "");
});

test("prewarm never throws", async () => {
  await prewarm({ primary: "mock" });
});
