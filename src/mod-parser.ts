// ─── MOD File Parser ──────────────────────────────────────────────────────────
// Supports ProTracker / Noisetracker 4-channel M.K. format (31 samples)
// Full effect support: 0-F

export interface ModSample {
  index: number;
  name: string;
  length: number;        // bytes
  finetune: number;      // signed: -8..7
  volume: number;        // 0-64
  loopStart: number;     // bytes
  loopLength: number;    // bytes
  looped: boolean;
  /** Loop type for WAV metadata; MOD uses forward loop. */
  loopType?: 1;
  data: Uint8Array;
  /** Source PCM bit depth in data. 8-bit is signed PCM bytes; 16-bit is signed little-endian PCM bytes. */
  pcmBits?: 8 | 16;
  sampleRate?: number;
}

export interface ModNote {
  sample: number;        // 1-based, 0 = no sample
  period: number;        // raw MOD period
  midi: number | null;   // MIDI note number
  effect: number;        // 0x0-0xF
  param: number;         // 0x00-0xFF
  // Decoded effect params
  effectHi: number;      // param >> 4
  effectLo: number;      // param & 0xF
}

export interface ModRow {
  notes: ModNote[];
}

export interface ModPattern {
  index: number;
  rows: ModRow[];
}

// Per-channel state after full song parse
export interface ChannelEffectSummary {
  usesPortamento: boolean;      // effects 1, 2, 3
  maxPortamentoSpeed: number;
  usesVibrato: boolean;         // effect 4
  maxVibratoDepth: number;
  maxVibratoSpeed: number;
  usesTremolo: boolean;         // effect 7
  usesArpeggio: boolean;        // effect 0
  usesSampleOffset: boolean;    // effect 9
  usesVolumeSlide: boolean;     // effect A
}

export interface LoopSanitizerReport {
  clamped: number;
  disabled: number;
  notes: string[];
}

export interface ModFile {
  title: string;
  /** Human-readable strings embedded in the MOD, mainly title + sample names. */
  internalTexts: string[];
  channels: number;
  samples: ModSample[];
  songLength: number;
  patternOrder: number[];
  patterns: ModPattern[];
  initialTempo: number;
  initialSpeed: number;
  loopSanitizer: LoopSanitizerReport;
  // Per-sample effect summary (for Simpler config)
  sampleEffects: Map<number, ChannelEffectSummary>;
  // Portamento: sampleIndex → maxSpeed
  portamentoSamples: Map<number, number>;
}

// ─── Period → MIDI ────────────────────────────────────────────────────────────
// MOD period 856 should trigger one octave below the previous rootfix.
// This fixes the remaining one-octave-too-low/too-high mismatch against Simpler.
export const MOD_ROOT_MIDI = 48;

const PERIOD_TABLE: Record<number, number> = {
  856:48,808:49,762:50,720:51,678:52,640:53,604:54,570:55,538:56,508:57,480:58,453:59,
  428:60,404:61,381:62,360:63,339:64,320:65,302:66,285:67,269:68,254:69,240:70,226:71,
  214:72,202:73,190:74,180:75,170:76,160:77,151:78,143:79,135:80,127:81,120:82,113:83,
};

export function periodToMidi(period: number): number | null {
  if (period === 0) return null;
  if (PERIOD_TABLE[period] !== undefined) return PERIOD_TABLE[period]!;
  const nearest = Object.keys(PERIOD_TABLE)
    .map(Number)
    .reduce((a, b) => Math.abs(b - period) < Math.abs(a - period) ? b : a);
  return PERIOD_TABLE[nearest] ?? null;
}


function cleanInternalText(value: string): string {
  return value
    .replace(/\x00/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectInternalTexts(title: string, samples: ModSample[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string) => {
    const t = cleanInternalText(value);
    if (t.length < 2) return;
    if (/^[.\-_#=+*~\s]+$/.test(t)) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  add(title);
  for (const sample of samples) add(sample.name);
  return out.slice(0, 40);
}

// ─── Parser ───────────────────────────────────────────────────────────────────
export function parseMod(buffer: Buffer): ModFile {
  const data = new Uint8Array(buffer);

  const title = String.fromCharCode(...data.slice(0, 20)).replace(/\x00/g, '').trim();
  const tag   = String.fromCharCode(...data.slice(1080, 1084));
  const channels = (tag === 'M.K.' || tag === 'M!K!' || tag === 'FLT4') ? 4 : 4;

  // Parse sample headers. MOD loops are byte offsets in the original sample.
  // Some old modules contain invalid loop headers; sanitize them before writing WAV
  // smpl chunks or Simpler loop parameters so a bad loop cannot disturb playback.
  const loopSanitizer: LoopSanitizerReport = { clamped: 0, disabled: 0, notes: [] };
  const samples: ModSample[] = [];
  for (let i = 0; i < 31; i++) {
    const o = 20 + i * 30;
    const name       = String.fromCharCode(...data.slice(o, o + 22)).replace(/\x00/g, '').trim();
    const length     = ((data[o+22]! << 8) | data[o+23]!) * 2;
    const ftByte     = data[o+24]! & 0x0F;
    const finetune   = ftByte >= 8 ? ftByte - 16 : ftByte;
    const volume     = Math.min(64, data[o+25]!);
    let loopStart    = ((data[o+26]! << 8) | data[o+27]!) * 2;
    let loopLength   = ((data[o+28]! << 8) | data[o+29]!) * 2;
    let looped       = loopLength > 2;

    if (looped) {
      const originalStart = loopStart;
      const originalLength = loopLength;
      if (length <= 0 || loopStart >= length || loopLength <= 2) {
        loopStart = 0;
        loopLength = 0;
        looped = false;
        loopSanitizer.disabled++;
        if (loopSanitizer.notes.length < 12) loopSanitizer.notes.push(`${String(i + 1).padStart(2, '0')}: disabled invalid loop ${originalStart}+${originalLength} for length ${length}`);
      } else if (loopStart + loopLength > length) {
        loopLength = Math.max(0, length - loopStart);
        looped = loopLength > 2;
        loopSanitizer.clamped++;
        if (loopSanitizer.notes.length < 12) loopSanitizer.notes.push(`${String(i + 1).padStart(2, '0')}: clamped loop ${originalStart}+${originalLength} to ${loopStart}+${loopLength}`);
      }
    }

    samples.push({
      index: i + 1, name, length, finetune, volume,
      loopStart, loopLength, looped,
      data: new Uint8Array(0), pcmBits: 8, sampleRate: 8287,
    });
  }

  const songLength   = data[950]!;
  const patternOrder = Array.from(data.slice(952, 952 + songLength));
  const numPatterns  = Math.max(...patternOrder) + 1;
  const patternStart = 1084;
  const rowBytes     = channels * 4;
  const patternSize  = 64 * rowBytes;

  // Parse patterns
  const patterns: ModPattern[] = [];
  for (let p = 0; p < numPatterns; p++) {
    const rows: ModRow[] = [];
    for (let r = 0; r < 64; r++) {
      const notes: ModNote[] = [];
      for (let c = 0; c < channels; c++) {
        const o  = patternStart + p * patternSize + r * rowBytes + c * 4;
        const b0 = data[o]!, b1 = data[o+1]!, b2 = data[o+2]!, b3 = data[o+3]!;
        const sample = (b0 & 0xF0) | (b2 >> 4);
        const period = ((b0 & 0x0F) << 8) | b1;
        const effect = b2 & 0x0F;
        const param  = b3;
        notes.push({
          sample, period, midi: periodToMidi(period),
          effect, param,
          effectHi: param >> 4,
          effectLo: param & 0xF,
        });
      }
      rows.push({ notes });
    }
    patterns.push({ index: p, rows });
  }

  // Extract sample PCM
  let sampleDataOffset = patternStart + numPatterns * patternSize;
  for (const s of samples) {
    s.data = data.slice(sampleDataOffset, sampleDataOffset + s.length);
    sampleDataOffset += s.length;
  }

  // Initial ProTracker timing. Default is speed 6 / tempo 125.
  // Only row 0 of the first played pattern is treated as an initial setting.
  // Later Fxx commands are handled during playback traversal. Scanning the full
  // song here is wrong because a later speed/tempo change would make the import
  // start at the wrong timing.
  let initialTempo = 125;
  let initialSpeed = 6;
  const firstPattern = patterns[patternOrder[0] ?? 0];
  for (const note of firstPattern?.rows[0]?.notes ?? []) {
    if (note.effect === 0xF && note.param > 0) {
      if (note.param < 0x20) initialSpeed = note.param;
      else initialTempo = note.param;
    }
  }

  // Build per-sample effect summary
  const sampleEffects = new Map<number, ChannelEffectSummary>();
  const portamentoSamples = new Map<number, number>();

  const defaultSummary = (): ChannelEffectSummary => ({
    usesPortamento: false, maxPortamentoSpeed: 0,
    usesVibrato: false, maxVibratoDepth: 0, maxVibratoSpeed: 0,
    usesTremolo: false, usesArpeggio: false,
    usesSampleOffset: false, usesVolumeSlide: false,
  });

  // Track last-played sample per channel to attribute effects correctly
  const lastSamplePerChannel = new Array(channels).fill(0);

  for (const pattern of patterns) {
    for (const row of pattern.rows) {
      for (let ch = 0; ch < channels; ch++) {
        const note = row.notes[ch]!;
        if (note.sample > 0) lastSamplePerChannel[ch] = note.sample;
        const sampleIdx = note.sample > 0 ? note.sample : lastSamplePerChannel[ch];
        if (sampleIdx === 0) continue;

        if (!sampleEffects.has(sampleIdx)) sampleEffects.set(sampleIdx, defaultSummary());
        const s = sampleEffects.get(sampleIdx)!;

        switch (note.effect) {
          case 0x0: if (note.param > 0) s.usesArpeggio = true; break;
          case 0x1: case 0x2: case 0x3:
            s.usesPortamento = true;
            s.maxPortamentoSpeed = Math.max(s.maxPortamentoSpeed, note.param);
            if (note.param > 0) portamentoSamples.set(sampleIdx,
              Math.max(portamentoSamples.get(sampleIdx) ?? 0, note.param));
            break;
          case 0x4:
            s.usesVibrato = true;
            s.maxVibratoSpeed = Math.max(s.maxVibratoSpeed, note.effectHi);
            s.maxVibratoDepth = Math.max(s.maxVibratoDepth, note.effectLo);
            break;
          case 0x7: s.usesTremolo = true; break;
          case 0x9: s.usesSampleOffset = true; break;
          case 0xA: s.usesVolumeSlide = true; break;
        }
      }
    }
  }

  const usedSamples = samples.filter(s => s.length > 0);
  const internalTexts = collectInternalTexts(title, usedSamples);

  return {
    title, internalTexts, channels, samples: usedSamples,
    songLength, patternOrder, patterns,
    initialTempo, initialSpeed, loopSanitizer,
    sampleEffects, portamentoSamples,
  };
}

// ─── Timing ───────────────────────────────────────────────────────────────────
export function rowToBeats(rows: number, speed: number): number {
  return rows * (speed / 24);
}

// ─── Sample classification ────────────────────────────────────────────────────
const DRUM_KEYWORDS = ['kick','bass drum','bd','bassdrum','snare','sd','hihat',
  'hi-hat','hat','clap','cymbal','ride','crash','tom','perc','drum','clave','cowbell'];

export function isDrum(name: string): boolean {
  const n = name.toLowerCase();
  return DRUM_KEYWORDS.some(k => n.includes(k));
}

export const DRUM_MIDI: Record<string, number> = {
  kick:36, bassdrum:36, bd:36, snare:38, sd:38,
  hihat:42, hat:42, clap:39, ride:51, crash:49,
};

export function drumMidiNote(name: string): number {
  const n = name.toLowerCase();
  for (const [key, note] of Object.entries(DRUM_MIDI)) {
    if (n.includes(key)) return note;
  }
  return 36;
}
