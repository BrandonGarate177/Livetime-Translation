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
