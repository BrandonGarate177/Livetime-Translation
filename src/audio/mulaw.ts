// G.711 μ-law codec, WAV I/O and frame energy. Twilio media is 8kHz mono μ-law in 20ms (160-byte) frames.

export const SAMPLE_RATE = 8000;
export const FRAME_BYTES = 160;

const BIAS = 0x84;
const CLIP = 32635;

const DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  DECODE_TABLE[i] = sign ? -magnitude : magnitude;
}

function encodeSample(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let s = Math.min(Math.abs(sample), CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

export function mulawToPcm16(ulaw: Buffer): Int16Array {
  const out = new Int16Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i++) out[i] = DECODE_TABLE[ulaw[i]];
  return out;
}

export function pcm16ToMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]);
  return out;
}

/** RMS of a μ-law frame on the 16-bit scale. Speech on a phone line is roughly 500–5000. */
export function frameRms(ulaw: Buffer): number {
  if (ulaw.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < ulaw.length; i++) {
    const s = DECODE_TABLE[ulaw[i]];
    sum += s * s;
  }
  return Math.sqrt(sum / ulaw.length);
}

export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE): Buffer {
  const dataBytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes).copy(buf, 44);
  return buf;
}

/** Reads a mono 16-bit PCM WAV. Convert other audio first: `afconvert -f WAVE -d LEI16@8000 -c 1 in.m4a out.wav`. */
export function decodeWav(buf: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (channels !== 1 || bits !== 16) {
        throw new Error(`need mono 16-bit PCM WAV, got ${channels}ch ${bits}-bit`);
      }
      const samples = new Int16Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(body + i * 2);
      return { pcm: samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
