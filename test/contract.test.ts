import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pipeline, Transcript, SttLike, TtsLike } from "../src/pipeline/contract.js";

test("a no-op Pipeline satisfies the contract", () => {
  const stt = new EventEmitter() as SttLike;
  const tts = new EventEmitter() as TtsLike;
  const pipeline: Pipeline = {
    name: "noop",
    createStt: () => stt,
    translate: async function* () {},
    prewarmTranslate: async () => {},
    createTts: () => tts,
  };
  assert.equal(pipeline.name, "noop");
});

test("Transcript carries text, isFinal, speechFinal and at", () => {
  const t: Transcript = { text: "hi", isFinal: true, speechFinal: false, at: 1 };
  assert.deepEqual(Object.keys(t).sort(), ["at", "isFinal", "speechFinal", "text"]);
});
