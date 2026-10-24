// Pretends to be Twilio: streams WAV files into /media as legs A and B, honors mark/clear like a
// real phone would, and records what each leg "heard" to out/heard-<leg>.wav on a wall-clock timeline.
//
//   npm run sim -- --a test-audio/en-hello.wav --b test-audio/uk-hello.wav [--b-delay 3] [--tail 8]
//   npm run sim -- --a test-audio/en-hello.wav            # echo mode: only leg A
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { FRAME_BYTES, SAMPLE_RATE, decodeWav, encodeWav, mulawToPcm16, pcm16ToMulaw } from "../src/audio/mulaw.js";

const { values: args } = parseArgs({
  options: {
    a: { type: "string" },
    b: { type: "string" },
    url: { type: "string", default: "ws://localhost:3000/media" },
    to: { type: "string", default: "" },
    "b-delay": { type: "string", default: "0" },
    tail: { type: "string", default: "8" },
    out: { type: "string", default: "out" },
  },
});

const FRAME_MS = 20;
const sid = `SIM${Date.now()}`;
const t0 = Date.now();

function loadUlaw(path: string): Buffer {
  const { pcm, sampleRate } = decodeWav(readFileSync(path));
  if (sampleRate !== SAMPLE_RATE) throw new Error(`${path}: need 8kHz, got ${sampleRate}`);
  return pcm16ToMulaw(pcm);
}

function runLeg(leg: "A" | "B", input: Buffer, startDelayMs: number, tailMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(args.url!);
    const streamSid = `MZ${leg}${sid}`;
    const heard = new Int16Array(SAMPLE_RATE * 600);
    let heardEnd = 0; // samples written to the timeline
    let playheadMs = 0; // wall time at which the phone finishes playing what it has received
    const pendingMarks: { name: string; timer: NodeJS.Timeout }[] = [];

    ws.on("error", reject);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const now = Date.now();
      if (msg.event === "media") {
        const pcm = mulawToPcm16(Buffer.from(msg.media.payload, "base64"));
        playheadMs = Math.max(playheadMs, now) + (pcm.length / SAMPLE_RATE) * 1000;
        const at = Math.max(heardEnd, Math.floor(((now - t0) / 1000) * SAMPLE_RATE));
        heard.set(pcm.subarray(0, Math.max(0, heard.length - at)), at);
        heardEnd = at + pcm.length;
      } else if (msg.event === "mark") {
        const name = msg.mark.name;
        const timer = setTimeout(() => {
          pendingMarks.splice(pendingMarks.findIndex((m) => m.name === name), 1);
          send({ event: "mark", streamSid, mark: { name } });
        }, Math.max(0, playheadMs - now));
        pendingMarks.push({ name, timer });
      } else if (msg.event === "clear") {
        console.log(`[sim ${leg}] clear at ${((now - t0) / 1000).toFixed(2)}s`);
        playheadMs = now;
        heardEnd = Math.floor(((now - t0) / 1000) * SAMPLE_RATE);
        for (const m of pendingMarks.splice(0)) {
          clearTimeout(m.timer);
          send({ event: "mark", streamSid, mark: { name: m.name } });
        }
      }
    });

    function send(msg: object): void {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }

    ws.on("open", async () => {
      await sleep(startDelayMs);
      send({ event: "connected", protocol: "Call", version: "1.0.0" });
      send({
        event: "start",
        sequenceNumber: "1",
        start: {
          streamSid,
          callSid: `CA${leg}${sid}`,
          tracks: ["inbound"],
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: SAMPLE_RATE, channels: 1 },
          customParameters: { sid, leg, sim: "1", to: args.to },
        },
        streamSid,
      });
      console.log(`[sim ${leg}] streaming ${(input.length / SAMPLE_RATE).toFixed(1)}s of audio`);

      // Real phones send frames continuously, so pad the input with silence for the tail.
      const silence = Buffer.alloc(Math.ceil((tailMs / 1000) * SAMPLE_RATE), 0xff);
      const all = Buffer.concat([input, silence]);
      const start = Date.now();
      for (let i = 0, n = 0; i < all.length; i += FRAME_BYTES, n++) {
        if (ws.readyState !== WebSocket.OPEN) break;
        send({
          event: "media",
          streamSid,
          media: { track: "inbound", chunk: String(n + 1), timestamp: String(n * FRAME_MS), payload: all.subarray(i, i + FRAME_BYTES).toString("base64") },
        });
        await sleep(start + (n + 1) * FRAME_MS - Date.now());
      }
      send({ event: "stop", streamSid, stop: { callSid: `CA${leg}${sid}` } });
      ws.close();
    });

    ws.on("close", () => {
      mkdirSync(args.out!, { recursive: true });
      const path = `${args.out}/heard-${leg}.wav`;
      writeFileSync(path, encodeWav(heard.subarray(0, heardEnd)));
      console.log(`[sim ${leg}] wrote ${path} (${(heardEnd / SAMPLE_RATE).toFixed(1)}s)`);
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

if (!args.a) {
  console.error("usage: npm run sim -- --a <8k mono wav> [--b <8k mono wav>] [--to <persona number>]");
  process.exit(1);
}
const tailMs = Number(args.tail) * 1000;
const legs = [runLeg("A", loadUlaw(args.a), 0, tailMs)];
if (args.b) legs.push(runLeg("B", loadUlaw(args.b), Number(args["b-delay"]) * 1000, tailMs));
await Promise.all(legs);
