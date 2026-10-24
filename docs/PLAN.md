# Plan: "Just Call" — Live Phone-Call Translator in Each Speaker's Own Voice

## Context
This is a hackathon entry for the theme "invisible interfaces." Someone dials an ordinary phone number from any phone (PSTN, no app). They talk to a person who speaks a different language, and each side hears the other in their own language, spoken in a clone of the *original* speaker's voice. We have 5 hours, 4 people, and an empty repo. The demo has to survive a judge calling in live.

**Decisions so far:** Twilio (paid), ElevenLabs Starter+, Deepgram, and a fast LLM are all available. The stack is Node/TypeScript. **The judge dials a "teammate's number"**: a Twilio number that *is* Olena (Ukrainian) or Diego (Spanish). The judge's language is **auto-detected** from their first utterance. The teammate's language is known from config.

---

## 1. Architecture (full duplex)

The two call legs are **never bridged directly**. Each leg is its own bidirectional Twilio Media Stream into our server, so each person hears *only* translated audio. That also removes most of the echo and self-translation problems at the source.

```
          JUDGE (any phone)                                         TEAMMATE (cell)
               │  PSTN                                                    ▲  PSTN
               ▼                                                          │
     Twilio Leg A  <Connect><Stream> (bidirectional, μ-law 8k, 20ms)   Twilio Leg B (REST calls.create → <Connect><Stream>)
               │ ws                                                       ▲ ws
               ▼                                                          │
 ┌──────────────────────────── Node server: CallSession ─────────────────────────────┐
 │  A inbound μ-law ─► VAD/gate ─► Deepgram STT(langA) ─► translate(langA→langB) ─►    │
 │                    │                                    ElevenLabs WS TTS           │
 │                    └─► clone buffer (first ~25s voiced PCM) ─► IVC → voiceA         │
 │                                         voice=voiceA, out=ulaw_8000 ─────────────► B│
 │                                                                                     │
 │  B inbound μ-law ─► VAD/gate ─► Deepgram STT(langB) ─► translate(langB→langA) ─►    │
 │                                         ElevenLabs WS TTS voice=voiceB(pre-enrolled)│
 │  A ◄──────────────────────────────────── out=ulaw_8000 ◄────────────────────────────│
 │                                                                                     │
 │  Both directions run as independent async pipelines.  Events ─► SSE ─► dashboard    │
 └─────────────────────────────────────────────────────────────────────────────────────┘
```

**No transcoding in the hot path:** Deepgram accepts `encoding=mulaw&sample_rate=8000` directly, and ElevenLabs can emit `output_format=ulaw_8000` directly. We only decode μ-law to PCM16 for the clone upload (WAV) and for energy VAD.

## 2. How the call connects
**Recommendation: the "contact number" pattern.** Buy 2–3 Twilio numbers, one per persona, e.g. `+1… = Olena (uk)` and `+1… = Diego (es)`. Config maps each number to `{forwardTo: teammate cell, lang, voiceId}`.

1. The judge calls Olena's number. Twilio sends `POST /voice/inbound`, and we return `<Connect><Stream url="wss://HOST/media?leg=A&sid=…">`.
2. At the same moment, the server runs `calls.create` to the teammate's cell with TwiML `<Connect><Stream …leg=B>`. B rings while A hears the consent notice, which hides the ring time.
3. Both sockets join the same `CallSession`. If B doesn't answer within 25s, we tell A in English plus the detected language and hang up.

Why this pattern: there's one action for the judge (dial a number) with no codes or menus, which is the "invisible" story. It's also the exact same plumbing we'd need for "A dials, system dials B." A conference bridge would mix the original audio in, which we don't want.

## 3. Voice cloning
- **Teammates are pre-enrolled.** Record 1–2 min of clean, wideband speech before the demo and create the ElevenLabs IVC voice ahead of time, so their voice quality is the best it can be. We'll say this openly to judges if they ask.
- **The judge is cloned live, and that's the wow moment.** After consent, collect the judge's *voiced* frames (energy VAD), decode them to PCM16 8k, and wrap them as WAV. At about 20–25s of speech (or ~45s of wall time, whichever comes first), POST to `/v1/voices/add` in the background and get `voiceA`. The *next* utterance switches TTS to `voiceA`, and the dashboard flashes "Voice clone ready."
- **Fallback:** until the clone is ready, or if it fails or sounds bad, use a stock voice. Pick one male and one female ElevenLabs default voice, and set it per persona config (a quick gender toggle on the dashboard). A `CLONE_JUDGE=false` kill switch is available.
- **Consent:** a pre-rendered prompt plays at call start in English, Spanish, Ukrainian, and Russian, kept short: *"This call is translated by AI, and your voice may be recreated in another language. Stay on the line to continue."* Staying on the line counts as consent. Clones are deleted via the API on hangup (this also keeps us under Starter's voice-slot limit).
- **Upsampling and cleanup are not worth the time.** 8kHz clones sound "phone-like," which is fine because the output also goes over the phone.

## 4. Latency budget (measured from when the speaker stops talking)
| Stage | Target | Notes |
|---|---|---|
| PSTN + Twilio ingress | 100–200ms | fixed |
| STT endpointing | 300–500ms | Deepgram `endpointing=300`, `utterance_end_ms=1000` as backstop |
| Final transcript | 50–150ms | |
| Translation TTFT | 150–350ms | streaming, short prompt, fast model |
| TTS time to first byte | 150–300ms | ElevenLabs Flash, warm WS |
| Twilio egress + PSTN to ear | 100–200ms | fixed |
| **Total** | **~0.9–1.7s** | |

Techniques:
- **Chunk on Deepgram `is_final` segments**, not just `speech_final`. Long utterances start translating while the person is still talking.
- **Stream translation tokens straight into the ElevenLabs input-streaming WS.** Flush at sentence or clause punctuation (`. ? ! ,` plus a length threshold).
- **Prewarm everything at call start, during the consent prompt:** both Deepgram sockets, both ElevenLabs sockets, and one tiny LLM call. Keep the ElevenLabs sockets alive with periodic keepalive text, since it has an inactivity timeout (*verify the current value*).
- **Deploy in us-east**, close to Twilio's default `us1` media region.
- **Stretch:** speculative translation of interim transcripts, discarded if the final transcript differs.
- **Instrument every stage** with timestamps from day one and show them on the dashboard.

## 5. Audio handling
- **Formats:** the inbound Twilio media is base64 μ-law 8kHz mono in 20ms frames (160 bytes). The outbound message is `{event:"media", streamSid, media:{payload}}` with ulaw_8000 straight from ElevenLabs, re-chunked to 160-byte frames. `audio/mulaw.ts` holds the μ-law↔PCM16 table, the WAV writer, and the RMS energy check.
- **Turn-taking:** each direction is independent, so true full duplex works. Each leg has a playback queue: one utterance plays at a time, and later ones queue behind it.
- **Playback tracking:** after each TTS chunk, send a Twilio `mark` message. When the `mark` echo comes back, we know playback finished, so `leg.isPlaying` is accurate.
- **Echo and self-translation:**
  1. Separate legs mean the TTS output is never fed back into STT digitally.
  2. The remaining risk is *acoustic* echo, such as speakerphone on B. While `leg.isPlaying`, raise that leg's VAD threshold and drop STT finals whose text closely matches the text we just synthesized for that leg (normalized substring check).
  3. Demo with handsets, not speakerphone. The only exception is the teammate's phone into room audio (see §10), and that's why the gate exists.
- **Barge-in:** if the listener speaks (energy above threshold for more than 300ms) while their leg is playing, send Twilio `{event:"clear"}` to flush the playback. Their speech then takes the floor, and we drop the rest of that queued utterance.
- **Language auto-detection:** Deepgram's streaming API doesn't do language ID (*verify*). Buffer the judge's first utterance (about 1.5–4s), send it to Deepgram pre-recorded with `detect_language=true`, and restrict the result to {en, es, uk, ru}. Lock the language, then open streaming STT with it. If confidence is low or detection fails, fall back to `DEFAULT_CALLER_LANG=en`. If both legs come out as the same language, skip translation and pass the audio through. Ukrainian vs Russian confusion is the main risk; give the prompt a bias toward the language most likely in the room.

## 6. Vendor comparison (⚠ = verify it's still current)
| Stage | Option | Latency | Quality / languages | Cost | Setup | Verdict |
|---|---|---|---|---|---|---|
| Telephony | **Twilio Media Streams** | good | n/a | ~$0.0085–0.014/min | known docs | **Pick** |
| | Telnyx Media Streaming | good | n/a | cheaper | new account, KYC delay | backup only |
| | Vonage WebSockets | ok | n/a | similar | slower | skip |
| STT | **Deepgram Nova-3 streaming** | ~300ms, native μ-law | en/es strong; uk/ru streaming ⚠ | free credits | 15 min | **Pick** |
| | Speechmatics realtime | ~0.5–1s | strongest ru/uk | credits | 30 min | swap in if uk is poor |
| | OpenAI realtime transcription (gpt-4o-transcribe ⚠) | 0.5–1s+ | great multilingual + language ID | per-min | 30 min | backup / language-ID alternative |
| Translate | **Groq-hosted Llama 70B-class ⚠** | TTFT ~100–200ms | good es; ok uk/ru | cheap | 10 min | **Pick if uk/ru quality passes** |
| | Claude Haiku 5.5 (`claude-haiku-5-5`) | TTFT ~300ms | strong uk/ru | cheap | 10 min | **Pick if Groq quality is weak** |
| | DeepL API | 150–300ms, no streaming | excellent en/es/uk/ru | free tier | 10 min | deterministic fallback |
| TTS | **ElevenLabs Flash v2.5 + IVC** ⚠ | ~75ms model, ~200–300ms TTFB | 32 langs incl. uk/ru ⚠, cross-lingual clone, `ulaw_8000` output | Starter+ | 20 min | **Pick** |
| | Cartesia Sonic | very fast, μ-law out | uk coverage ⚠ | credits | 30 min | backup |
| | OpenAI TTS | ok | no cloning | — | — | generic-voice fallback only |

**Translation prompt:** the system prompt says "Translate the speaker's words from {src} to {dst}. This is a live phone call. Output only the translation, conversational register, no quotes." It includes the last 3 turns as context, for pronouns and gender agreement in uk/ru/es. In hour 1, run a 10-sentence uk/ru/es bake-off between Groq and Haiku and pick the winner.

## 7. Scope tiers
- **(a) Must work (MVP):** judge calls Olena's number → both legs bridged → STT → translate → TTS with the **pre-enrolled teammate voice** to the judge and a **stock voice** to the teammate. Judge's language is fixed to English via config. One language pair (en↔uk).
- **(b) Strong demo:** add the live judge clone with a mid-call voice swap, the consent prompt, auto-detection of the judge's language, barge-in/clear, the echo gate, a second persona number (Diego, es), and a **live dashboard** (projected transcripts in both languages, latency per turn, clone status).
- **(c) Stretch:** speculative partial translation, Russian persona, a post-call SMS summary to both parties (in their own languages), mid-call language switching, a "loopback" number for solo testing (also a backup demo).

## 8. Milestones (5h, riskiest first, always demoable)
| Time | P1 Telephony | P2 STT + translate | P3 TTS + voice | P4 Harness / dashboard / ops |
|---|---|---|---|---|
| 0:00–0:20 | Buy numbers, ngrok, repo skeleton | Keys, Deepgram on a WAV file | Keys, record teammate enrollment, create IVC | `sim-call.ts` Twilio-protocol simulator |
| **0:20–1:00 SPIKE** | **Call in → hear yourself echoed back.** Then outbound to B and cross-wire **raw** audio A↔B through the server. Prove `clear` and `mark`. | Streaming STT on μ-law frames + language-ID call on a clip | ElevenLabs WS → `ulaw_8000` → play into a live call | Simulator replays WAV, records output |
| **Gate 1:00** | If raw A↔B audio isn't working, everyone helps P1. | | | |
| 1:00–2:00 | CallSession wiring | translate.ts + bake-off | tts.ts warm sockets, playback queue | — |
| **2:00 = Tier A demoable.** Commit and tag `demo-a`. | | | | |
| 2:00–3:00 | barge-in, echo gate | auto language detection | live clone + swap + delete on hangup, consent prompts pre-rendered | dashboard (SSE) + latency timings |
| 3:00–3:45 | deploy to Fly.io/Railway (us-east), point numbers at it | tune endpointing | tune voices | **record the backup video** of a good call |
| **3:45 = Tier B.** Tag `demo-b`. Feature freeze at 4:15. | | | | |
| 4:15–5:00 | Rehearse the demo 3× with real judges-as-strangers, fix only blockers, charge phones | | | |

## 9. Repo structure and config
```
src/
  server.ts            Fastify HTTP + WS upgrade (/media), static dashboard, SSE /events
  twiml.ts             /voice/inbound, /voice/outbound-twiml, /voice/status
  config.ts            env + PERSONAS map (Twilio number → {forwardTo, lang, voiceId, name})
  call/session.ts      CallSession: two legs, language, voices, routing, event emitter
  call/leg.ts          Twilio WS wrapper: sendAudio, mark, clear, isPlaying, playback queue
  pipeline/stt.ts      Deepgram live socket per leg
  pipeline/langid.ts   first-utterance detection
  pipeline/translate.ts streaming LLM with provider switch + DeepL fallback
  pipeline/tts.ts      ElevenLabs input-streaming WS per leg, voice swap, keepalive
  voice/clone.ts       voiced-frame buffer → WAV → IVC add/delete
  audio/mulaw.ts       μ-law codec, WAV writer, RMS VAD
  metrics.ts           per-turn stage timestamps
public/dashboard.html  transcripts both sides, latency bars, clone status
prompts/*.ulaw         consent/hold prompts, pre-rendered per language
scripts/sim-call.ts    fake Twilio client: WAV in → our WS → WAV out (zero phone minutes)
scripts/prerender-prompts.ts, scripts/enroll-voice.ts
test-audio/            short en/es/uk/ru clips (8k μ-law)
```
**Env:** `TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST, PERSONAS_JSON, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, ELEVEN_TTS_MODEL, FALLBACK_VOICE_M, FALLBACK_VOICE_F, TRANSLATE_PROVIDER (groq|anthropic|deepl), GROQ_API_KEY, ANTHROPIC_API_KEY, DEEPL_API_KEY, DEFAULT_CALLER_LANG, CLONE_JUDGE, LOOPBACK_MODE`.

**Run:** `npm run dev` (tsx watch) + `ngrok http 3000`, then set each number's Voice webhook to `https://<ngrok>/voice/inbound`. Prod uses the same container on Fly/Railway with a fixed hostname, so webhooks don't change at the venue.

**Testing without phone minutes:**
- `sim-call.ts` speaks the Media Streams protocol (`connected/start/media/stop`, honors `mark`/`clear`) with two fake legs fed from WAVs, and writes the translated output WAVs.
- `LOOPBACK_MODE=1` uses one real call and translates you back to yourself.

## 10. Demo script (~2.5 min)
1. **0:00 Hook.** The slide shows only a phone number and "Olena — speaks Ukrainian." Pitch line: "No app. No screen. Any phone, even a landline. Just call."
2. **0:15** A judge dials from *their own phone*, held to the ear. Olena's phone is cabled to the room speakers so the audience hears her side. The dashboard is projected.
3. **0:25** The consent line plays. The judge says hello in English, and the dashboard shows "detected: English."
4. **0:35** Olena answers in Ukrainian. The judge hears English in *Olena's* voice, and the room watches both transcripts appear.
5. **1:10 Wow moment.** The dashboard shows "Judge's voice clone ready." The room now hears **the judge's own voice speaking Ukrainian** through Olena's speaker.
6. **1:40** Optional: a second judge calls Diego (es) to show it isn't scripted. Or the judge barges in mid-sentence to show interruption handling.
7. **2:10 Close.** Show the latency panel (~1.3s/turn), the consent and voice-deletion story, and a 1-line architecture slide.

**Backup ladder:**
1. Teammate-to-teammate live call on a hotspot.
2. `LOOPBACK_MODE` on one phone.
3. The recorded video from 3:45.
4. `sim-call` playing through laptop speakers with the dashboard live.

## 11. Risks
| Risk | Mitigation |
|---|---|
| Latency over 2s | Streaming everywhere, prewarm, `is_final` chunking, us-east deploy; the dashboard shows the slow stage so we can tune live |
| 8kHz clone quality | Teammates pre-enrolled wideband; judge clone is a bonus with stock-voice fallback and a kill switch |
| uk/ru STT, language-ID, or translation quality | Hour-1 bake-off; Speechmatics/DeepL swap behind provider flags; `DEFAULT_CALLER_LANG` fallback |
| Acoustic echo / self-translation | Separate legs, playback gate + text-match dedupe, handsets |
| Rate limits / API outage | Pre-check quotas; one fallback provider per stage behind env flags; delete clones to free slots |
| Venue Wi-Fi | The server runs in the cloud, not on the laptop; dashboard only needs a browser; phone hotspot as backup; cellular calls don't touch the Wi-Fi |
| Twilio account issues (trial banner, geo-permissions, international dialing) | Confirm the account is upgraded, enable geo-permissions for teammate cell countries, use US cells for the demo |
| Teammate's phone is busy or doesn't answer | Hard 25s timeout with a spoken message; second persona number ready |
| Live demo nerves / scope creep | Feature freeze at 4:15, three rehearsals, tags `demo-a` and `demo-b` to roll back to |

## Verification
- **Spike gate (1:00):** two real phones hear each other's raw audio through the server.
- **Tier A:** `sim-call` with en/uk WAVs produces correct translated WAVs, then one real call in each direction.
- **Per-turn latency:** read from dashboard timings, target p50 < 1.5s over 10 turns.
- **Barge-in:** speak over playback, and it stops within ~300ms.
- **Echo:** the teammate on speakerphone doesn't cause re-translation loops.
- **Clone:** voice swaps mid-call, and the voice is deleted after hangup (check the ElevenLabs voice list).
- **Full dress rehearsal on the deployed host:** cellular only, laptop Wi-Fi off.
