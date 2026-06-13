// ─── WAV Writer ───────────────────────────────────────────────────────────────
// Converts MOD raw signed 8-bit mono PCM to standard WAV files.
// Classic MOD samples use ~8287 Hz C-2 tuning.

import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_SAMPLE_RATE = 8287;

export interface WavLoopOptions {
  sampleRate?: number;
  loopStart?: number;
  loopLength?: number;
  looped?: boolean;
  /** 0/undefined = no loop, 1 = forward, 2 = ping-pong/alternating. */
  loopType?: 0 | 1 | 2;
  /** Input PCM bit depth. 8-bit is signed PCM bytes, 16-bit is signed little-endian PCM bytes. */
  pcmBits?: 8 | 16;
  /** Output WAV bit depth. 8-bit keeps the MOD source representation; 16-bit up-converts without normalizing. */
  outputBits?: 8 | 16;
  /** Optional output sample rate. If different from sampleRate, audio is linearly resampled to keep pitch and duration. */
  outputSampleRate?: number;
}

function writeSmplChunk(buf: Buffer, offset: number, loopStart: number, loopLength: number, loopType: 0 | 1 | 2 = 1): number {
  const loopEndExclusive = loopStart + loopLength;
  const loopEndInclusive = Math.max(loopStart, loopEndExclusive - 1);
  let o = offset;
  buf.write('smpl', o); o += 4;
  buf.writeUInt32LE(60, o); o += 4;       // chunk data size for one loop
  buf.writeUInt32LE(0, o); o += 4;        // manufacturer
  buf.writeUInt32LE(0, o); o += 4;        // product
  buf.writeUInt32LE(0, o); o += 4;        // sample period unknown
  buf.writeUInt32LE(60, o); o += 4;       // MIDI unity note, Simpler can override root key
  buf.writeUInt32LE(0, o); o += 4;        // MIDI pitch fraction
  buf.writeUInt32LE(0, o); o += 4;        // SMPTE format
  buf.writeUInt32LE(0, o); o += 4;        // SMPTE offset
  buf.writeUInt32LE(1, o); o += 4;        // num sample loops
  buf.writeUInt32LE(0, o); o += 4;        // sampler data
  buf.writeUInt32LE(0, o); o += 4;        // cue point id
  buf.writeUInt32LE(loopType === 2 ? 1 : 0, o); o += 4; // type: 0=forward, 1=alternating/ping-pong
  buf.writeUInt32LE(loopStart, o); o += 4;
  buf.writeUInt32LE(loopEndInclusive, o); o += 4;
  buf.writeUInt32LE(0, o); o += 4;        // fraction
  buf.writeUInt32LE(0, o); o += 4;        // play count, 0 = infinite
  return o;
}

function readSigned16(sampleData: Uint8Array, index: number, inputBits: 8 | 16): number {
  if (inputBits === 16) {
    const lo = sampleData[index * 2] ?? 0;
    const hi = sampleData[index * 2 + 1] ?? 0;
    let v = (hi << 8) | lo;
    if (v >= 0x8000) v -= 0x10000;
    return v;
  }
  const b = sampleData[index] ?? 0;
  const signed8 = b > 127 ? b - 256 : b;
  return signed8 << 8;
}

function resampleLinearSigned16(input: Int16Array, sourceRate: number, outputRate: number): Int16Array {
  if (input.length <= 1 || Math.abs(sourceRate - outputRate) < 1) return input;
  const outputLength = Math.max(1, Math.round(input.length * outputRate / sourceRate));
  const out = new Int16Array(outputLength);
  const ratio = sourceRate / outputRate;
  for (let i = 0; i < outputLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[Math.min(idx, input.length - 1)] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? a;
    const v = Math.round(a + (b - a) * frac);
    out[i] = Math.max(-32768, Math.min(32767, v));
  }
  return out;
}

export function writeSampleWav(
  sampleData: Uint8Array,
  outputPath: string,
  options: WavLoopOptions = {},
): void {
  const inputBits = options.pcmBits === 16 ? 16 : 8;
  const outputBits = options.outputBits === 16 ? 16 : 8;
  const sourceSampleRate = Math.max(1000, Math.floor(options.sampleRate ?? DEFAULT_SAMPLE_RATE));
  const sampleRate = Math.max(1000, Math.floor(options.outputSampleRate ?? sourceSampleRate));
  const sourceSamples = inputBits === 16 ? Math.floor(sampleData.length / 2) : sampleData.length;
  const sourcePcm = new Int16Array(sourceSamples);
  for (let i = 0; i < sourceSamples; i++) sourcePcm[i] = readSigned16(sampleData, i, inputBits);
  const pcm = resampleLinearSigned16(sourcePcm, sourceSampleRate, sampleRate);
  const numSamples = pcm.length;
  const numChannels = 1;

  const scale = sampleRate / sourceSampleRate;
  const loopStart = Math.max(0, Math.round((options.loopStart ?? 0) * scale));
  const loopLength = Math.max(0, Math.round((options.loopLength ?? 0) * scale));
  const hasLoop = !!options.looped && loopLength > 2 && loopStart >= 0 && loopStart + loopLength <= numSamples;

  const bitsPerSample = outputBits;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * numChannels * bytesPerSample;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numSamples * blockAlign;
  const smplChunkSize = hasLoop ? 68 : 0;
  const headerSize = 44;
  const totalSize = headerSize + dataSize + smplChunkSize;

  const buf = Buffer.alloc(totalSize);
  let o = 0;

  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(totalSize - 8, o); o += 4;
  buf.write('WAVE', o); o += 4;

  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(16, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;
  buf.writeUInt16LE(numChannels, o); o += 2;
  buf.writeUInt32LE(sampleRate, o); o += 4;
  buf.writeUInt32LE(byteRate, o); o += 4;
  buf.writeUInt16LE(blockAlign, o); o += 2;
  buf.writeUInt16LE(bitsPerSample, o); o += 2;

  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataSize, o); o += 4;

  for (let i = 0; i < numSamples; i++) {
    const signed16 = pcm[i] ?? 0;
    if (outputBits === 16) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, signed16)), o);
      o += 2;
    } else {
      const signed8 = Math.max(-128, Math.min(127, Math.round(signed16 / 256)));
      buf[o++] = signed8 + 128;
    }
  }

  if (hasLoop) {
    o = writeSmplChunk(buf, o, loopStart, loopLength, options.loopType ?? 1);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buf);
}
