# Babel - Live Translation

Call a phone number and talk to someone who doesn't speak your language. You speak English and hear them in English. They speak Spanish and hear you in Spanish. When they talk, you hear their own cloned voice speaking English.

Neither side installs anything. It's an ordinary phone call, from any phone.

**[▶ Watch the demo](DEMO_VIDEO_URL)** (2 min)

## Try it

Call the number on our table and ask for Angel. Angel speaks Spanish and you speak English. Hold the phone to your ear like a normal call, and pause after each sentence so the translation can catch up.

## How it works

```
 Judge's phone                         Our server                          Angel's phone
 (English)                                                                 (Spanish)
 ┌─────────┐  leg A   ┌──────────────────────────────────────────┐  leg B  ┌─────────┐
 │         │ ───────► │ speech-to-text → translate → cloned voice│ ──────► │         │
 │  any    │  Twilio  │                                          │ Twilio  │  any    │
 │  phone  │ ◄─────── │ cloned voice ← translate ← speech-to-text│ ◄────── │  phone  │
 └─────────┘  stream  └──────────────────────────────────────────┘ stream  └─────────┘
```

1. You call our Twilio number. The server answers and opens a two-way audio stream to your call (leg A).
2. The server dials Angel's real cell and opens a second stream (leg B).
3. Twilio never connects the two calls to each other. Everything each person hears comes from our server.
4. Each direction runs as its own pipeline. Speech goes to streaming speech-to-text. When the speaker stops, the text goes to a fast LLM for translation, streamed token by token. Each translated sentence goes to ElevenLabs text-to-speech in the speaker's cloned voice, and the audio plays on the other call.

Phone audio is 8 kHz μ-law. Deepgram accepts it as is and ElevenLabs can output it directly, so the server never converts audio formats while you're talking.

## Latency

The demo lives or dies on the gap between when you stop talking and when the other person starts hearing you. We time every stage on every turn.

| Stage | Time |
|---|---|
| End of speech detected (Deepgram Flux) | 216–284 ms |
| First translated token (Groq, `qwen3.8-27b`) | 130–250 ms |
| First audio from the cloned voice (ElevenLabs Flash) | 170–210 ms |
| **End of speech → first translated audio** | **520–600 ms** |

These numbers come from our call simulator running against the real vendor APIs. On a real call the phone network adds its own delay on top. For comparison, published speech-to-speech translation systems take 1.8 to 3 seconds.

## Stack and why

- **Twilio Media Streams** for the calls. A bidirectional `<Connect><Stream>` on each call means our server is the only path audio can take, so we control exactly what each person hears.
- **Deepgram Flux** for English speech-to-text. It detects the end of a turn in about 250 ms, versus about 530 ms with endpointing on Nova-3. Spanish goes through Nova-3 because Flux's multilingual model wasn't any faster for it.
- **Groq running `qwen3.8-27b`** for translation, with reasoning turned off. In our bake-off it reached the first token in 130–250 ms, against about 450 ms for `gpt-oss-120b` and 500–600 ms for Claude Haiku 5.5.
- **ElevenLabs Flash** for speech, through the US region. It outputs `ulaw_8000`, which is the phone's own format. We send `flush` at each sentence end, so the first sentence plays while the rest is still being translated.
- **ElevenLabs Instant Voice Clone** for Angel's voice, recorded as clean audio rather than over the phone, since 8 kHz phone audio makes a rougher clone. The caller hears Angel in that clone. Angel hears the caller in a stock voice for now (see [Next](#next)).
- **Node 22, TypeScript, Fastify, `ws`** for the server.

Every vendor sits behind an environment flag with a fallback (Nova-3 for Flux, Anthropic or DeepL for Groq), so we can swap one out mid-demo if its API misbehaves.

## Hard parts

- **Two calls, no bridge.** Twilio doesn't let you put a translator between the two halves of a call it's bridging. So we run two separate calls and pass audio between them ourselves. That also means handling hang-up, busy, and no-answer on either side by hand.
- **Knowing when someone stopped talking.** Wait too long and the conversation drags. Cut in too early and you translate half a sentence. Switching the English side to Flux saved about 300 ms per turn, more than any other change we made.
- **Testing without burning phone minutes.** We wrote a fake Twilio (`scripts/sim-call.ts`) that speaks the Media Streams protocol, plays WAV files in as each caller, and records what each side heard. Most of the pipeline was built and tuned against it before anyone dialed a real number.

## Built at the hackathon

Everything in this repo was written during the event on 2026-10-24, starting from an empty repo. We came in with the idea and the longer-term iPhone app design described under [Next](#next).

## Run it locally

```bash
npm install
cp .env.example .env     # Twilio, Deepgram, ElevenLabs, Groq keys and PERSONAS_JSON
npm run dev              # server on :3000
ngrok http 3000          # point the Twilio number's Voice webhook at /voice/inbound
```

No phone or API keys needed for the offline version:

```bash
./scripts/make-test-audio.sh
BRIDGE_MODE=translate PIPELINE=fake npm run dev
npm run sim -- --a test-audio/en-hello.wav --b test-audio/uk-hello.wav --b-delay 1
afplay out/heard-B.wav   # what the other person heard
```

More in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). The full plan, latency budget, and risk list are in [docs/PLAN.md](docs/PLAN.md).

## Next

- **Clone the caller live.** The caller's voice is a stock voice today. The plan is to clone it from the first 20 seconds of the call, with a spoken consent notice at the start and the clone deleted at hang-up.
- **Interruptions.** Stop playback when the listener starts talking over the translation.
- **An iPhone app.** iOS 26 already translates calls, but in Apple's generic voice. A CallKit app could put Babel calls on the native call screen, with the caller's voice recorded once during setup.
- **More languages.** The pipeline already handles Ukrainian, Russian, and Polish. Adding one is a new phone number and a line in `PERSONAS_JSON`.

## Team

- **Brandon Garate:** ROLE
- **Angel Francisco:** ROLE
- **Nikita:** ROLE
- **NAME:** ROLE
