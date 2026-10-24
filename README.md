# Livetime Translation

Live translation inside phone calls, spoken in the original speaker's voice.

You call someone who speaks another language. They hear your words in their language, in your voice. You hear theirs in yours. The person you call answers a normal phone call and installs nothing.

## Why not just use Apple's Live Translation

iOS 26 already translates phone calls on iPhone 15 Pro and newer. It reads the translation in a generic synthetic voice and supports a handful of languages. Apple's Call Translation API (`CXSetTranslatingCallAction` in CallKit) lets third-party calling apps turn on that same feature, but it uses Apple's translation and Apple's voice. You can't plug in a voice clone.

To speak in the caller's own voice, the call audio has to pass through our server. That decides the architecture.

## Architecture

```
 Your user (iPhone app)                Your server                     Friend (any phone)
 ┌──────────────────┐   live audio  ┌─────────────────────────┐ phone line ┌────────────┐
 │ VoIP call shown  │ ────────────► │ speech-to-text (stream) │ ◄────────► │ normal     │
 │ in native call   │ ◄──────────── │ → translate (stream)    │  Twilio /  │ phone call │
 │ screen (CallKit) │               │ → speak it in the       │  Telnyx    └────────────┘
 └──────────────────┘               │   speaker's own voice   │
                                    └─────────────────────────┘
```

**iPhone app.** Places a VoIP call and reports it to CallKit, so it shows up in the system call screen, the lock screen, Recents and Bluetooth like any other call.

**Phone network bridge.** Twilio or Telnyx dials the friend's real number and streams their call audio to the server over a WebSocket. The friend needs no app.

**Server.** Runs the translation pipeline in both directions at once. Each direction is three streaming steps.

1. Speech to text, streamed word by word (Deepgram or ElevenLabs Scribe realtime).
2. Translation of each chunk as it arrives (a fast LLM such as Claude Haiku or Gemini Flash).
3. Text to speech in the speaker's cloned voice (ElevenLabs Flash or Cartesia).

A single speech-to-speech model (OpenAI `gpt-realtime-translate`, Meta Seamless, DeepL Voice) could replace the three steps. That is simpler but gives less control over the voice, so we start with the three-step pipeline.

## Latency budget

Target is under 1.5 seconds from the end of a phrase to the first translated audio. Published speech-to-speech systems sit around 1.8 to 3 seconds.

| Step | Rough time |
|---|---|
| Speech to text | 200–300 ms |
| Translation | 150–300 ms |
| Cloned voice, first audio | 100–200 ms |
| Network and phone line | 150–300 ms |
| **Total** | **0.7–1.2 s** |

Two techniques buy more headroom.

- Translate partial sentences instead of waiting for the speaker to finish. This saves the most time. Languages with the verb at the end, like German and Japanese, will need tuning.
- Play the original voice quietly under the translation, the way a TV interpreter sounds. Hearing the person talk makes the wait feel shorter.

## Voice cloning

The caller records about 30 seconds of speech once, during app setup.

The friend never installs anything, so the server has to clone their voice from the first seconds of the call. The clone starts rough and improves as the call goes on. This means cloning someone's voice without asking first, which matters for App Store review and for state laws on voice likeness. The plan is a short automated notice at the start of each call.

Phone audio is narrowband (8 kHz), so speech recognition and cloning both do worse on the friend's side than on the caller's.

## Build order

1. **Browser demo.** Two laptops, the full pipeline with voice cloning, no phone network. Proves latency and voice quality first.
2. **Phone network.** Connect Twilio and dial a real number from a simple client.
3. **iOS app.** CallKit for the native call experience, plus the one-time voice recording during setup.
4. **Tuning.** Partial-sentence translation, the interpreter-style background audio, per-language settings.
