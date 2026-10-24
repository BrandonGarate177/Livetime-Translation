# CLAUDE.md

Shared context for every teammate's coding agent. Read this first, then `docs/PLAN.md` for detail.
Update the **Status** section in the same commit as the work it describes.

## What we're building (hackathon scope)

"Just Call": a live phone-call translator for an "invisible interfaces" hackathon. A judge dials an
ordinary phone number that belongs to a teammate persona (e.g. "Olena, speaks Ukrainian"). Each
person speaks their own language and hears the other in theirs, in the other person's cloned voice.
**No app on either side**: plain PSTN calls only.

`README.md` describes the longer-term product (an iPhone app with CallKit). For the hackathon, the
no-app design in `docs/PLAN.md` wins wherever the two disagree.

- Deadline: 5 hours from kickoff on 2026-10-24. Feature freeze at 4:15 into the build, then rehearse.
- Demo languages: English, Spanish, Ukrainian, Russian. Headline pair: en ↔ uk if we get a second number; today the one persona is Diego (es).
- Pipeline diagram for humans: https://claude.ai/artifact/9sdDnuLqLbjoXNKMsurQGH (opens only once the owner shares it)

## Architecture in one paragraph

The judge calls a Twilio number. `/voice/inbound` looks up the persona, answers with a
bidirectional `<Connect><Stream>` (leg A), and dials the teammate's real cell with a second stream
(leg B). Twilio never bridges the legs: every byte each person hears is sent by our server. Per
direction: Twilio μ-law 8 kHz → Deepgram streaming STT → fast LLM translation (streamed; Claude Haiku 5.5 or
Groq `openai/gpt-oss-120b`, since Groq no longer lists Llama 70B) →
ElevenLabs Flash streaming TTS with `output_format=ulaw_8000` → the other leg. No transcoding in the
hot path. The judge's language is auto-detected from their first utterance. The teammate's voice is
a pre-recorded ElevenLabs clone; the judge is cloned live from ~20 s of call audio.

## Code map

| Path | What it does |
|---|---|
| `src/server.ts` | Fastify HTTP + `/media` WebSocket. Binds each stream to a session using the `<Parameter>`s `sid` and `leg` |
| `src/twiml.ts` | `/voice/inbound` (answers leg A, dials leg B), `/voice/status` (busy/no-answer handling), hang-up helpers |
| `src/config.ts` | Env parsing; `PERSONAS_JSON` maps a Twilio number to `{name, lang, forwardTo, voiceId}` |
| `src/call/session.ts` | `CallSession`: pairs legs A/B and routes audio by `BRIDGE_MODE` (`echo` / `raw` / `translate`) |
| `src/call/leg.ts` | One Twilio Media Stream: `sendAudio` (160-byte frames), `mark`, `clear`, `isPlaying` |
| `src/audio/mulaw.ts` | μ-law ↔ PCM16, WAV read/write, frame RMS for voice activity |
| `scripts/sim-call.ts` | Fake Twilio: streams WAVs in as legs A/B, honors `mark`/`clear`, writes `out/heard-A.wav` and `out/heard-B.wav` |
| `scripts/make-test-audio.sh` | Generates en/es/ru/uk 8 kHz test clips with macOS `say` |
| `docs/PLAN.md` | Full approved plan: latency budget, vendors, milestones, demo script, risks |
| `docs/DEVELOPMENT.md` | How to run locally, expose with ngrok, and test without phone minutes |

Planned modules (not yet written): `src/pipeline/{stt,langid,translate,tts}.ts`,
`src/voice/clone.ts`, `src/metrics.ts`, `public/dashboard.html`, `scripts/prerender-prompts.ts`.

## Status

Done:
- [x] Plan approved (`docs/PLAN.md`)
- [x] Repo skeleton: Node 22+, TypeScript strict, ESM, Fastify, `ws`, Twilio SDK
- [x] Telephony core: leg/session/TwiML; dial-out to persona; hang-up on either side; busy/no-answer message
- [x] `BRIDGE_MODE=echo` and `raw` verified with the simulator **and on real phones** (spike gate passed 2026-10-24)
- [x] Twilio-protocol simulator and test clips

Accounts (checked 2026-10-24):
- [x] Twilio upgraded to a full account; one number bought (persona: Diego, Spanish)
- [x] Keys working: Deepgram, ElevenLabs, Groq, Anthropic (`claude-haiku-5-5` available)
- [x] Static ngrok domain in `PUBLIC_HOST`; Twilio number's Voice webhook points at `/voice/inbound`
- [x] ElevenLabs on Starter (instant cloning, 40k chars, 10 voice slots)
- [ ] Record each teammate persona (1–2 min of clean audio) → ElevenLabs instant clone → `voiceId`
- [ ] Optional: second number for a Ukrainian persona (Olena), the plan's headline pair

To do, in milestone order (see `docs/PLAN.md` §8):
- [ ] `pipeline/stt.ts`: Deepgram live socket per leg (`encoding=mulaw&sample_rate=8000`, `endpointing=300`)
- [ ] `pipeline/translate.ts`: streaming LLM, last 3 turns as context, provider switch + DeepL fallback; hour-1 quality bake-off
- [ ] `pipeline/tts.ts`: ElevenLabs input-streaming WS per leg, `ulaw_8000`, keepalive, voice swap
- [ ] `BRIDGE_MODE=translate` wired in `CallSession` → **Tier A demo** (judge's language fixed to en)
- [ ] Barge-in (`clear` when the listener talks >300 ms during playback) and echo gate
- [ ] Language auto-detection on the judge's first utterance (`pipeline/langid.ts`)
- [ ] Live judge clone + delete on hang-up (`voice/clone.ts`), consent prompt pre-rendered in 4 languages
- [ ] Dashboard (SSE): transcripts both sides, per-stage latency, clone status
- [ ] Deploy to Fly.io/Railway in us-east; point numbers at it → **Tier B demo**
- [ ] Record the backup demo video; rehearse 3×

## Working agreements

- **Branches:** one per task off `main` (`feat/stt`, `feat/tts`, …); small PRs; tag `demo-a` and `demo-b` at the milestones.
- **Never commit `.env`** or real phone numbers. Add new variables to `.env.example` with a comment.
- **Before pushing:** `npm run typecheck`, then a simulator run of the affected mode.
- **Testing without phone minutes:** `npm run sim -- --a test-audio/en-hello.wav --b test-audio/uk-hello.wav --b-delay 1`, then listen to `out/heard-*.wav`.
- **Style:** match the existing code. ESM imports with `.js` suffixes, strict TypeScript, small modules, comments only where the *why* isn't obvious.
- **Every vendor goes behind an env flag** with a fallback, so we can swap live if an API misbehaves.
- **Time every stage** (speech end → transcript → first translated token → first audio out) and surface it on the dashboard. Latency is the demo.
