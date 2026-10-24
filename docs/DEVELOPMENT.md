# Development guide

How to run, test and expose the hackathon build. The plan is in [PLAN.md](PLAN.md); current status is in [../CLAUDE.md](../CLAUDE.md).

## Setup
```bash
npm install
cp .env.example .env        # fill in Twilio creds + PERSONAS_JSON
brew install ngrok && ngrok config add-authtoken <token>
```

## Run against real phones
```bash
npm run dev                 # server on :3000
ngrok http 3000             # copy the https host into PUBLIC_HOST (no scheme), restart dev
```
In the Twilio console, set each persona number's **Voice → A call comes in** webhook to
`https://<PUBLIC_HOST>/voice/inbound` (HTTP POST).

`BRIDGE_MODE` in `.env`:
- `echo` — call the number and hear yourself. Proves audio in/out on one phone.
- `raw` — the server dials the persona's `forwardTo` cell and relays untranslated audio both ways. Proves the bridge.
- `translate` — full pipeline (in progress).

## Test without phone minutes
```bash
./scripts/make-test-audio.sh                     # en/es/ru/uk clips via macOS `say`
npm run sim -- --a test-audio/en-hello.wav                                   # echo mode
npm run sim -- --a test-audio/en-hello.wav --b test-audio/uk-hello.wav --b-delay 1   # raw/translate
```
The simulator speaks the Twilio Media Streams protocol (including `mark`/`clear`) and writes what
each leg heard to `out/heard-A.wav` and `out/heard-B.wav`.

`npm test` runs the unit tests (`node:test` through tsx). The pipeline modules are tested against a fake
WebSocket (`src/pipeline/testing/fake-socket.ts`), so they pass without any vendor key.

## Check one vendor at a time (needs the key in `.env`)
```bash
npx tsx scripts/try-stt.ts test-audio/uk-hello.wav uk          # Deepgram: interim/final transcripts with timing
TRANSLATE_PROVIDER=groq npx tsx scripts/try-translate.ts en uk "Hi Olena, how is your day?"   # TTFT; repeat per provider for the bake-off
npx tsx scripts/try-tts.ts <voiceId> uk "Привіт, Олено."        # ElevenLabs: TTFB on a warm socket, writes out/tts-uk.wav
```
`TRANSLATE_PROVIDER` falls back to `mock` (tags the original text) when the chosen key is empty, so a call keeps
flowing while keys are being sorted out.

## Translate mode offline (no API keys)
`PIPELINE=fake` swaps the vendors for offline stand-ins: an energy-VAD "recognizer" that emits the
test clip's sentence, a dictionary translator, and macOS `say` as the TTS (Samantha/Paulina/Lesya/Milena).
It proves the wiring and the latency plumbing, not quality.
```bash
BRIDGE_MODE=translate PIPELINE=fake npm run dev
npm run sim -- --a test-audio/en-hello.wav --b test-audio/uk-hello.wav --b-delay 1
afplay out/heard-B.wav     # Ukrainian, what the teammate heard
afplay out/heard-A.wav     # English, what the judge heard
```
The server log prints each translation and a per-turn latency line
(`stt … translate … tts … total`). `FAKE_TTS=tone` replaces `say` with a beep for fast tests.

`PIPELINE=real` (the default) loads `src/pipeline/{stt,translate,tts}.ts` from #6/#7/#8 through
`src/pipeline/index.ts`, which adapts their exports to `src/pipeline/contract.ts`.

## Tests
```bash
npm test                   # node:test via tsx; src/**/*.test.ts and test/**/*.test.ts
```
