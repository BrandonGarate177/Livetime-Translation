# Wire `BRIDGE_MODE=translate` (issue #9) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `CallSession` runs two independent STT → translate → TTS directions so the judge and the teammate each hear the other translated, and the simulator proves it end to end with no API keys.

**Architecture:** The session receives a `Pipeline` (factory for STT/translate/TTS) instead of importing vendors directly. A `fake` pipeline (energy-VAD STT with canned text, dictionary translation, macOS `say` TTS) ships in this ticket so #9 is testable today. The `real` pipeline loads `src/pipeline/{stt,translate,tts}.ts` from tickets #6/#7/#8 by dynamic import, so this branch compiles before those files exist and nothing collides with teammates' branches. One `Direction` object owns one speaking leg → listening leg flow; `CallSession` creates A→B and B→A.

**Tech Stack:** Node 22, TypeScript strict ESM, `ws`, Node's built-in `node:test` runner via `tsx`.

**Spec:** `docs/PLAN.md` §1, §4, §5, §7(a); GitHub issue #9 (events + done criteria); interfaces from issues #6, #7, #8 copied verbatim into `src/pipeline/contract.ts`.

## Global Constraints

- Interfaces are fixed by #6/#7/#8: `new SttStream(lang)` with `write(ulawFrame)`/`close()` and `transcript` events `{text, isFinal, speechFinal, at}`; `translate({text, src, dst, history, signal}): AsyncIterable<string>` and `prewarm()`; `new TtsStream(voiceId, lang)` with `sendText`/`flush`/`setVoice`/`close` and `audio`/`done`/`error` events.
- Do not create `src/pipeline/stt.ts`, `translate.ts` or `tts.ts` (owned by #6/#7/#8).
- No transcoding in the hot path: μ-law frames go to STT as-is, TTS output goes to `Leg.sendAudio` as-is.
- Translate on `isFinal` segments, not only `speechFinal`. Keep the last 3 turns per session as history.
- Leg A hears `persona.voiceId || FALLBACK_VOICE_F`; leg B hears `FALLBACK_VOICE_M` (judge clone is #12).
- Create and prewarm STT/TTS when each leg attaches. Close everything on `ended`.
- ESM imports with `.js` suffix, strict TS, `npm run typecheck` clean before every commit. Never commit `.env`.

## Review Focus

1. Empty or whitespace-only `isFinal` transcripts (Deepgram sends them often) must not start a translation or push a history turn. Test in Task 4.
2. A translation that throws (provider down) must log and leave the direction alive for the next utterance, not kill the session. Test in Task 4.
3. Audio arriving for a leg before the other leg has attached (B still ringing) must be dropped silently, not crash. Test in Task 5.
4. `ended` fired while a translation is streaming must abort it via `AbortSignal` and must not emit audio to a closed leg. Test in Task 5.
5. Two `isFinal` segments arriving back-to-back must be translated in order, so TTS text is never interleaved. Test in Task 4.

---

### Task 1: Test runner and pipeline contract

**Files:**
- Modify: `package.json` (scripts)
- Create: `src/pipeline/contract.ts`
- Create: `test/contract.test.ts`

**Interfaces:**
- Produces, in `contract.ts`:
  ```ts
  export interface Transcript { text: string; isFinal: boolean; speechFinal: boolean; at: number }
  export interface SttEvents { transcript: [t: Transcript]; error: [err: Error] }
  export interface SttLike extends EventEmitter<SttEvents> { write(ulawFrame: Buffer): void; close(): void }
  export interface Turn { src: Lang; text: string; translation: string }
  export interface TranslateOpts { text: string; src: Lang; dst: Lang; history: Turn[]; signal?: AbortSignal }
  export interface TtsEvents { audio: [ulaw: Buffer]; done: []; error: [err: Error] }
  export interface TtsLike extends EventEmitter<TtsEvents> { sendText(chunk: string): void; flush(): void; setVoice(voiceId: string): void; close(): void }
  export interface Pipeline {
    name: string;
    createStt(lang: Lang): SttLike;
    translate(opts: TranslateOpts): AsyncIterable<string>;
    prewarmTranslate(): Promise<void>;
    createTts(voiceId: string, lang: Lang): TtsLike;
  }
  ```

- [ ] **Step 1:** Add `"test": "node --import tsx --test test/"` to `package.json` scripts.
- [ ] **Step 2:** Write `test/contract.test.ts` asserting that an object literal typed as `Pipeline` with no-op members compiles and that `Transcript` has the four fields (a type-level smoke test: `assert.deepEqual(Object.keys(t).sort(), ["at","isFinal","speechFinal","text"])`).
- [ ] **Step 3:** Run `npm test`. Expected: FAIL, cannot find `../src/pipeline/contract.js`.
- [ ] **Step 4:** Create `src/pipeline/contract.ts` with the interfaces above. Import `Lang` from `../config.js`.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck`. Expected: PASS, clean.
- [ ] **Step 6:** Commit: `test: add node:test runner; feat: pipeline contract types for #9`.

### Task 2: Fake pipeline

**Files:**
- Create: `src/pipeline/fake.ts`
- Test: `test/fake.test.ts`

**Interfaces:**
- Consumes: `contract.ts` types; `frameRms`, `decodeWav`, `pcm16ToMulaw` from `src/audio/mulaw.ts`.
- Produces: `export const fakePipeline: Pipeline` (name `"fake"`), plus exported classes `FakeStt`, `FakeTts` and `fakeTranslate` for tests.

Behaviour, decided here:
- `FakeStt(lang)`: tracks voiced frames (`frameRms > 300`). After ≥10 voiced frames followed by 15 consecutive silent frames (300 ms), emits one `Transcript` `{text: CANNED[lang], isFinal: true, speechFinal: true, at: Date.now()}` and resets. `CANNED` = the exact sentences in `scripts/make-test-audio.sh` per language.
- `fakeTranslate({text, dst})`: looks up `DICTIONARY[text]?.[dst]` (the four canned sentences translated to each of the other three languages; author them in the file), else `"[" + dst + "] " + text`. Yields the result in word-sized chunks with `await setTimeout(5)` between them; checks `signal?.aborted` before each chunk and returns.
- `FakeTts(voiceId, lang)`: buffers `sendText`; on `flush()` renders the buffer with `say -v <VOICE[lang]> -o <tmp>.wav --data-format=LEI16@8000` (voices: en Samantha, es Paulina, uk Lesya, ru Milena), decodes with `decodeWav`, encodes with `pcm16ToMulaw`, emits `audio` then `done`. If `say` fails or `FAKE_TTS=tone`, emit 400 ms of a 440 Hz μ-law tone instead. Renders are serialized so `done` order matches `flush` order. `setVoice` is a no-op; `close` kills a pending `say`.
- `prewarmTranslate` resolves immediately.

- [ ] **Step 1:** Write `test/fake.test.ts`:
  - `FakeStt emits a canned final after speech then silence`: write 20 frames of `Buffer.alloc(160, 0x00)` (loud μ-law) then 16 frames of `0xff` (silence); expect exactly one transcript with `isFinal && speechFinal` and `text === CANNED.en`.
  - `FakeStt stays quiet on silence`: 50 silent frames → no event.
  - `fakeTranslate uses the dictionary`: collect chunks for `CANNED.en` en→uk; joined text equals `DICTIONARY[CANNED.en].uk`.
  - `fakeTranslate falls back to a tag`: `"xyz"` en→es → `"[es] xyz"`.
  - `fakeTranslate stops when aborted`: abort before iterating; collects zero chunks.
  - `FakeTts emits audio then done` with `process.env.FAKE_TTS = "tone"`: `flush()` → one `audio` Buffer of length 3200, then `done`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/pipeline/fake.ts` as specified.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(pipeline): fake STT/translate/TTS for offline end-to-end tests`.

### Task 3: Pipeline loader and config

**Files:**
- Modify: `src/config.ts`
- Create: `src/pipeline/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `config.pipeline: "real" | "fake"` (env `PIPELINE`, default `"real"`), `config.fallbackVoiceM`, `config.fallbackVoiceF` (env `FALLBACK_VOICE_M/F`, default `""`); `export async function loadPipeline(): Promise<Pipeline>`.

- [ ] **Step 1:** Add the three config fields.
- [ ] **Step 2:** Implement `loadPipeline()`: if `config.pipeline === "fake"` return `fakePipeline`. Otherwise dynamic-import `./stt.js`, `./translate.js`, `./tts.js` through a string variable (so `tsc` does not resolve the not-yet-existing modules) and adapt: `createStt: (lang) => new mod.SttStream(lang)`, `translate: mod.translate`, `prewarmTranslate: mod.prewarm`, `createTts: (v, l) => new mod.TtsStream(v, l)`. If any import fails, throw `Error("PIPELINE=real needs src/pipeline/{stt,translate,tts}.ts from #6/#7/#8; set PIPELINE=fake to test offline")`. Add a `// TODO(#9): switch to static imports once #6/#7/#8 merge` comment.
- [ ] **Step 3:** Add to `.env.example` under the pipeline section: `PIPELINE=real` with a comment (`fake = offline stand-ins using macOS say, for the simulator`), and `FAKE_TTS=` (`tone` to skip `say`). `FALLBACK_VOICE_M/F` already exist.
- [ ] **Step 4:** Run `npm run typecheck`. Expected: clean.
- [ ] **Step 5:** Commit: `feat(pipeline): PIPELINE=real|fake loader`.

### Task 4: `Direction` (one speaking leg → one listening leg)

**Files:**
- Create: `src/call/direction.ts`
- Test: `test/direction.test.ts`

**Interfaces:**
- Consumes: `Pipeline`, `SttLike`, `TtsLike`, `Turn` from `contract.ts`; `Leg` (`on("audio")`, `sendAudio`, `isOpen`).
- Produces:
  ```ts
  export interface DirectionEvents {
    transcript: [e: { text: string; isFinal: boolean }];
    translation: [e: { text: string }];
    timing: [e: { speechEnd: number; transcript: number; firstToken: number; firstAudio: number }];
  }
  export class Direction extends EventEmitter<DirectionEvents> {
    constructor(opts: { pipeline: Pipeline; from: Leg; to: () => Leg | undefined; srcLang: Lang; dstLang: Lang; voiceId: string; history: Turn[]; log: (msg: string) => void });
    start(): void;    // creates STT + TTS, prewarms translate, subscribes to from.on("audio")
    close(): void;    // aborts in-flight translation, closes STT/TTS
  }
  ```
  `history` is a shared array owned by the session (both directions push to it; cap at 3 = drop from the front).

Behaviour, decided here:
- Every inbound frame: `stt.write(frame)`; if `frameRms(frame) > 300`, record `lastVoicedAt = Date.now()`.
- On `transcript`: emit `transcript`. If `!isFinal` or `text.trim() === ""`, stop. Else enqueue a job on a promise chain (`this.queue = this.queue.then(() => job())`) so jobs run in order.
- Job: `t0 = {speechEnd: lastVoicedAt, transcript: t.at}`; create `AbortController`; iterate `pipeline.translate({text, src, dst, history: [...history], signal})`; on first chunk set `firstToken`; `tts.sendText(chunk)` for each; after the loop `tts.flush()`, push `{src, text, translation}` to `history` (drop front past 3), emit `translation`. On error: `log("translate failed: …")` and return (direction stays alive).
- TTS `audio`: set `firstAudio` on the first chunk after a flush and emit `timing`; `to()?.sendAudio(ulaw)` only if `to()?.isOpen`. TTS `error`: log.
- `close()`: abort the current controller, `stt.close()`, `tts.close()`, remove the audio listener.

- [ ] **Step 1:** Write `test/direction.test.ts` using `fakePipeline` with `FAKE_TTS=tone` and a `FakeLeg` (an `EventEmitter` with `id`, `isOpen = true`, `sent: Buffer[]`, `sendAudio(b) { this.sent.push(b) }`) cast to `Leg`:
  - `translates a final transcript and plays it on the other leg`: start, emit 20 loud + 16 silent frames on `from`; await `translation` event; expect `translation.text === DICTIONARY[CANNED.en].uk`, `to.sent.length === 1`, one `timing` event with all four numbers `> 0` and `firstAudio >= firstToken >= transcript`.
  - `ignores empty finals`: inject a stub pipeline whose STT emits `{text: "  ", isFinal: true, …}`; expect no `translation` and `history.length === 0`.
  - `survives a failing translate`: stub `translate` that throws; then a stub that works; expect the second utterance's `translation` event and the direction still attached.
  - `keeps history at three turns`: four utterances → `history.length === 3` and `history[0].text` is the second utterance.
  - `runs translations in order`: stub `translate` where the first call delays 50 ms and the second 0 ms; collect `sendText` calls on a stub TTS; expect first text's chunks all before second's.
  - `drops audio when the listener is gone`: `to` returns `undefined`; no throw, `sent` empty.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement `src/call/direction.ts`.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(call): Direction pipeline STT→translate→TTS per leg pair`.

### Task 5: Wire `CallSession` translate mode and session events

**Files:**
- Modify: `src/call/session.ts`
- Modify: `src/server.ts`, `src/twiml.ts` (pass the loaded pipeline)
- Test: `test/session.test.ts`

**Interfaces:**
- Produces: `SessionEvents` gains `transcript: [{leg: LegId; text: string; isFinal: boolean}]`, `translation: [{leg: LegId; text: string}]`, `timing: [{leg: LegId; speechEnd: number; transcript: number; firstToken: number; firstAudio: number}]`. Constructor gains a 5th parameter `pipeline?: Pipeline` (required when `mode === "translate"`).
- Dashboard (#13) consumes these events and should not reach into `Direction`.

Behaviour, decided here:
- `attach(leg)` in translate mode: `srcLang = leg.id === "A" ? callerLang : persona.lang`, `dstLang` the other; `voiceId = leg.id === "A" ? (config.fallbackVoiceM) : (persona.voiceId || config.fallbackVoiceF)` (A speaks, B hears the judge in the male fallback; B speaks, A hears the persona's voice). Create `new Direction({... from: leg, to: () => this.other(leg.id), history: this.history, log: this.log.bind(this)})`, `start()`, store in `this.directions[leg.id]`, forward its three events with `leg: leg.id` added.
- If `srcLang === dstLang`, fall back to raw relay for that direction (plan §5) and log it.
- `end()`: close both directions before emitting `ended`.
- `server.ts`: `const pipeline = config.bridgeMode === "translate" ? await loadPipeline() : undefined;` log `pipeline=${pipeline?.name}`; pass it to both `new CallSession(...)` sites (server sim path and `twiml.ts`; export it from `server.ts` or pass through `registerTwimlRoutes(app, pipeline)`: choose the latter).

- [ ] **Step 1:** Write `test/session.test.ts` with `FakeLeg` and `fakePipeline` (`FAKE_TTS=tone`):
  - `A's speech reaches B translated`: attach A and B; emit loud+silent frames on A; await session `translation` with `leg === "A"`; `B.sent.length === 1`; a `transcript` event with `leg: "A"` and a `timing` event with `leg: "A"` were emitted.
  - `speech before the other leg attaches is dropped`: attach A only; emit frames; await `translation`; no throw; attach B afterwards and emit again; `B.sent.length === 1`.
  - `end aborts in-flight work`: stub pipeline whose `translate` yields one chunk then waits 200 ms checking `signal.aborted`; call `end()` after the first chunk; expect the stub observed `aborted === true` and `B.sent.length === 0`.
  - `same language relays raw`: persona lang `en`, caller `en`; frames on A arrive on B byte-identical.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL on the new events/constructor.
- [ ] **Step 3:** Implement the session changes and the server/twiml wiring.
- [ ] **Step 4:** Run `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(call): BRIDGE_MODE=translate wired in CallSession with dashboard events`.

### Task 6: End-to-end simulator run, docs, status

**Files:**
- Modify: `docs/DEVELOPMENT.md`, `CLAUDE.md` (Status + code map), `.env.example` comment for `translate`

- [ ] **Step 1:** Run the server with `BRIDGE_MODE=translate PIPELINE=fake PORT=3100` and `npm run sim -- --url ws://localhost:3100/media --a test-audio/en-hello.wav --b test-audio/uk-hello.wav --b-delay 1`.
- [ ] **Step 2:** Verify: server log shows `transcript`/`translation` lines for both legs; `out/heard-A.wav` and `out/heard-B.wav` are non-trivial (> 44 bytes) and, on listening (`afplay`), A hears English and B hears Ukrainian. Record the `timing` numbers in the commit message.
- [ ] **Step 3:** Docs: in `DEVELOPMENT.md` add a "Translate mode offline" section with the exact commands and `PIPELINE=fake`; in `CLAUDE.md` tick the `BRIDGE_MODE=translate wired` item, add `src/pipeline/{contract,fake,index}.ts` and `src/call/direction.ts` to the code map, and note under Status that real vendors arrive via #6/#7/#8 and that `loadPipeline` switches to static imports once they merge.
- [ ] **Step 4:** `npm run typecheck && npm test`. Expected: clean, all pass.
- [ ] **Step 5:** Commit: `docs: translate mode offline run; status for #9`. Do not tag `demo-a` yet: the tag needs a real call, which waits on #3/#5/#6/#7/#8.
