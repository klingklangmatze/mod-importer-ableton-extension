import type { NoteDescription } from "@ableton-extensions/sdk";
import type { ModFile, ModNote } from "./mod-parser";
import { MOD_ROOT_MIDI } from "./mod-parser";

export interface MidiPartKey {
  /** 0 means compact/sample-only part, not a single original MOD channel. */
  channel: number;
  sample: number;
  /** MOD 9xx offset parameter for offset-specific Simpler fallback parts. 0 = normal. */
  offsetParam?: number;
}

export interface MidiPart {
  key: MidiPartKey;
  notes: NoteDescription[];
  /** Minimum Simpler voice count needed for this generated part. */
  voices?: number;
}

export interface CuePointInfo {
  beat: number;
  order: number;
  pattern: number;
}

export interface EffectStats {
  implemented: Map<string, number>;
  approximated: Map<string, number>;
  unsupported: Map<string, number>;
}

/**
 * One pad inside a DrumRack-based offset track.
 * The sample WAV is loaded with S Start = frameOffset.
 * All notes in `notes` have pitch = receivingNote (the pad's trigger note).
 * transpose is the semitone offset to apply to Simpler so the pad sounds
 * at the single pitch this offset always plays at.
 */
export interface OffsetPad {
  /** 9xx param value (1–255). */
  offsetParam: number;
  /** Frame offset into the sample (already converted from 9xx pages). */
  frameOffset: number;
  /** MIDI note number this DrumChain listens on (receivingNote). */
  receivingNote: number;
  /** Semitones relative to MOD_ROOT_MIDI to transpose the pad's Simpler. */
  transpose: number;
  notes: NoteDescription[];
}

/**
 * A sample that uses multiple 9xx offsets where every offset is used at
 * a single pitch → represented as one MIDI track + Drum Rack.
 */
export interface DrumRackPart {
  sampleIndex: number;
  pads: OffsetPad[];
}

export interface NativeBuiltNotes {
  /** Regular Simpler MIDI parts (no 9xx, or 9xx offsets used at multiple pitches). */
  parts: MidiPart[];
  /** Samples that get a Drum Rack with one pad per offset. */
  drumRackParts: DrumRackPart[];
  drumHits: Map<number, { startTime: number; velocity: number }[]>;
  totalBeats: number;
  /** Initial/default beats per row. Later speed/tempo effects may make rows variable. */
  beatsPerRow: number;
  cuePoints: CuePointInfo[];
  effects: EffectStats;
  /** Backward compatible alias used by older extension.ts builds. */
  unsupportedEffects: Map<string, number>;
  /**
   * Per sample index: maximum number of MOD channels that play this sample
   * simultaneously across any row in the song. Used to set Simpler Voices so
   * that polyphonic content (multiple channels merged into one Simpler track)
   * is not cut off by a single-voice limit.
   */
  maxSimultaneousChannels: Map<number, number>;
  playbackWarnings: string[];
}

/**
 * Pre-scan all patterns to collect, per sample, per 9xx offset param:
 * which MIDI pitches are used together with that offset.
 *
 * Returns Map<sampleIndex, Map<offsetParam, Set<midiPitch>>>.
 * Offset param 0 means "no 9xx on this row" and is excluded.
 */
function scanOffsetPitches(mod: ModFile): Map<number, Map<number, Set<number>>> {
  const result = new Map<number, Map<number, Set<number>>>();
  const lastSamplePerCh = new Array<number>(mod.channels).fill(0);
  const lastOffsetPerCh = new Array<number>(mod.channels).fill(0);

  for (const orderIdx of mod.patternOrder) {
    const pattern = mod.patterns[orderIdx];
    if (!pattern) continue;
    for (const row of pattern.rows) {
      for (let ch = 0; ch < mod.channels; ch++) {
        const n = row.notes[ch];
        if (!n) continue;

        if (n.sample > 0) lastSamplePerCh[ch] = n.sample;
        const sampleIdx = lastSamplePerCh[ch];
        if (sampleIdx === 0) continue;

        // Track current offset for this channel
        if (n.effect === 0x09 && n.param > 0) {
          lastOffsetPerCh[ch] = n.param;
        } else if (n.sample > 0 && n.effect !== 0x09) {
          // New sample trigger without 9xx resets the offset carry
          lastOffsetPerCh[ch] = 0;
        }

        const offsetParam = n.effect === 0x09 && n.param > 0 ? n.param : lastOffsetPerCh[ch];
        if (offsetParam === 0) continue;
        if (n.midi === null) continue;

        if (!result.has(sampleIdx)) result.set(sampleIdx, new Map());
        const byOffset = result.get(sampleIdx)!;
        if (!byOffset.has(offsetParam)) byOffset.set(offsetParam, new Set());
        byOffset.get(offsetParam)!.add(n.midi);
      }
    }
  }
  return result;
}

/**
 * Given the offset/pitch scan, decide per sample how to handle its 9xx offsets:
 *
 * Returns Map<sampleIndex, Map<offsetParam, 'pad' | 'simpler'>>
 *   'pad'     → single pitch for this offset → goes into a DrumRack pad
 *   'simpler' → multiple pitches for this offset → stays as a regular Simpler part
 *
 * Samples with no offsets at all are not present in the map.
 * If ALL offsets for a sample are 'pad', the sample becomes a DrumRack track.
 * If ANY offset is 'simpler', that offset emits a regular Simpler part.
 */
function classifyOffsets(
  offsetPitches: Map<number, Map<number, Set<number>>>,
): Map<number, Map<number, 'pad' | 'simpler'>> {
  const result = new Map<number, Map<number, 'pad' | 'simpler'>>();
  for (const [sampleIdx, byOffset] of offsetPitches) {
    const classification = new Map<number, 'pad' | 'simpler'>();
    for (const [offsetParam, pitches] of byOffset) {
      classification.set(offsetParam, pitches.size === 1 ? 'pad' : 'simpler');
    }
    result.set(sampleIdx, classification);
  }
  return result;
}


/**
 * In compact sample-track mode one Simpler track represents one MOD sample. That
 * breaks when the same sample is triggered by multiple MOD channels at the same
 * time while Simpler Voices is 1: later notes cut earlier ones and MIDI export
 * pairs note-offs oddly. For those samples only, fall back to channel-specific
 * parts. Samples without collisions remain one clean track per sample.
 */
function scanSamplesNeedingChannelSplit(mod: ModFile): Set<number> {
  const result = new Set<number>();
  const lastSamplePerCh = new Array<number>(mod.channels).fill(0);

  for (const orderIdx of mod.patternOrder) {
    const pattern = mod.patterns[orderIdx];
    if (!pattern) continue;
    for (const row of pattern.rows) {
      const rowCounts = new Map<number, number>();
      for (let ch = 0; ch < mod.channels; ch++) {
        const n = row.notes[ch];
        if (!n) continue;
        if (n.sample > 0) lastSamplePerCh[ch] = n.sample;
        if (n.period <= 0) continue;
        const sampleIdx = n.sample > 0 ? n.sample : lastSamplePerCh[ch];
        if (sampleIdx <= 0) continue;
        rowCounts.set(sampleIdx, (rowCounts.get(sampleIdx) ?? 0) + 1);
      }
      for (const [sampleIdx, count] of rowCounts) {
        if (count > 1) result.add(sampleIdx);
      }
    }
  }

  return result;
}

/** Part key: adaptive sample-only or channel-specific, with optional offset param. */
function keyOf(channel: number, sample: number, offsetParam = 0, splitByChannel = false): string {
  const channelPart = splitByChannel ? `:ch${channel + 1}` : '';
  const offsetPart = offsetParam > 0 ? `:off${offsetParam}` : '';
  return `${sample}${channelPart}${offsetPart}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function bcdRow(param: number): number {
  const hi = (param >> 4) & 0x0f;
  const lo = param & 0x0f;
  return clamp(hi * 10 + lo, 0, 63);
}

function effectKey(effect: number, param: number): string {
  return `${effect.toString(16).toUpperCase()}${param.toString(16).padStart(2, "0").toUpperCase()}`;
}

function addStat(map: Map<string, number>, n: ModNote) {
  if (n.effect === 0 && n.param === 0) return;
  const k = effectKey(n.effect, n.param);
  map.set(k, (map.get(k) ?? 0) + 1);
}

function buildRowNativeNotesByChannelAndSample(mod: ModFile, drumSamples: Set<number>): NativeBuiltNotes {
  // ── Pre-scan: classify every 9xx offset per sample ───────────────────────
  const offsetPitches    = scanOffsetPitches(mod);
  const offsetClassify   = classifyOffsets(offsetPitches);
  const channelSplitSamples = scanSamplesNeedingChannelSplit(mod);

  // Samples where every offset used is single-pitch get a DrumRack track.
  // We record which samples are "drum-rack candidates" so the main loop knows
  // to route their 9xx-bearing notes into offset-keyed parts.
  const drumRackSamples = new Set<number>();
  for (const [sampleIdx, byOffset] of offsetClassify) {
    if (byOffset.size > 0) drumRackSamples.add(sampleIdx);
  }

  let speed = mod.initialSpeed || 6;
  let tempo = mod.initialTempo || 125;
  const baseTempo = mod.initialTempo || 125;
  const defaultBeatsPerRow = speed / 24;
  const rowBeats = () => Math.max(1 / 128, (speed * baseTempo) / (24 * Math.max(32, tempo)));

  let currentBeat = 0;

  interface ChanState {
    lastSample: number;
    volume: number;
    openBySample: Map<number, { note: NoteDescription; startBeat: number }>;
    volSlideParam: number;
    /** Last non-zero 9xx sample offset parameter. Reported only by default to avoid track explosion. */
    sampleOffset: number;
    /** E6x pattern loop start row for this tracker channel. */
    patternLoopStart: number;
    /** Remaining repetitions for an active E6x pattern loop on this channel. */
    patternLoopRemaining: number | null;
    /** ProTracker E5x finetune override for subsequent periods on this channel. */
    finetune: number;
    /** Current approximate Amiga LED lowpass filter state. Reported only by default to avoid extra split tracks. */
    ledFilterOn: boolean;
  }

  const chanState: ChanState[] = Array.from({ length: mod.channels }, (_, ch) => ({
    lastSample: 0,
    volume: 64,
    openBySample: new Map(),
    volSlideParam: 0,
    sampleOffset: 0,
    patternLoopStart: 0,
    patternLoopRemaining: null,
    finetune: 0,
    ledFilterOn: false,
  }));

  const parts = new Map<string, MidiPart>();
  const drumHits = new Map<number, { startTime: number; velocity: number }[]>();
  const cuePoints: CuePointInfo[] = [];
  const effects: EffectStats = {
    implemented: new Map(),
    approximated: new Map(),
    unsupported: new Map(),
  };
  const sampleByIndex = new Map(mod.samples.map(s => [s.index, s]));

  const sampleOffsetFrames = (sampleIndex: number, param: number): number => {
    const sample = sampleByIndex.get(sampleIndex);
    if (!sample || param <= 0) return 0;
    // MOD 9xx is counted in 256-byte pages in the original 8-bit sample stream.
    const byteOffset = param * 256;
    const frames = sample.pcmBits === 16 ? Math.floor(byteOffset / 2) : byteOffset;
    return clamp(frames, 0, Math.max(0, sample.length - 1));
  };

  const getPart = (channel: number, sample: number, offsetParam = 0): MidiPart => {
    const splitByChannel = channelSplitSamples.has(sample);
    const key = keyOf(channel, sample, offsetParam, splitByChannel);
    let part = parts.get(key);
    if (!part) {
      part = { key: { channel: splitByChannel ? channel + 1 : 0, sample, offsetParam }, notes: [] };
      parts.set(key, part);
    }
    return part;
  };

  const closeOpenNote = (cs: ChanState, sample: number, beatTime: number) => {
    const open = cs.openBySample.get(sample);
    if (!open) return;
    const dur = beatTime - open.startBeat;
    if (dur > 0) open.note.duration = Math.max(1 / 128, dur * 0.98);
    cs.openBySample.delete(sample);
  };

  const closeAllChannelNotes = (cs: ChanState, beatTime: number) => {
    for (const sample of Array.from(cs.openBySample.keys())) closeOpenNote(cs, sample, beatTime);
  };

  const addNote = (channel: number, sample: number, pitch: number, startTime: number, duration: number, velocity: number, offsetParam = 0) => {
    const note: NoteDescription = {
      pitch: clamp(Math.round(pitch), 0, 127),
      startTime,
      duration: Math.max(1 / 128, duration),
      velocity: clamp(Math.round(velocity), 1, 127),
    };
    getPart(channel, sample, offsetParam).notes.push(note);
    return note;
  };

  const maxOverlappingNotes = (notes: NoteDescription[]): number => {
    const events: { time: number; delta: number }[] = [];
    for (const note of notes) {
      const start = note.startTime;
      const end = note.startTime + Math.max(0, note.duration);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      events.push({ time: start, delta: 1 });
      events.push({ time: end, delta: -1 });
    }
    events.sort((a, b) => (a.time - b.time) || (a.delta - b.delta));
    let current = 0;
    let max = 1;
    for (const event of events) {
      current += event.delta;
      if (current > max) max = current;
    }
    return Math.max(1, max);
  };

  const pitchWithFineTune = (midi: number, cs: ChanState, sample: number): number => {
    const sampleFine = sampleByIndex.get(sample)?.finetune ?? 0;
    // E5x overrides finetune for the channel. SDK notes cannot store cents, so the
    // note pitch stays integer; Simpler Detune handles the sample-header finetune.
    // We keep the hook here so E5x is recognized and documented without fake pitchbend.
    void sampleFine;
    void cs;
    return midi;
  };

  let orderPos = 0;
  let startRowForOrder = 0;
  let safety = 0;
  const playbackWarnings: string[] = [];
  const visitedOrderRows = new Set<string>();
  const maxPlayedOrders = Math.max(128, mod.patternOrder.length * 4);
  const maxTotalBeats = 32768;
  const stopAtSongLoop = (nextOrder: number, nextRow: number): boolean => {
    const key = `${nextOrder}:${nextRow}`;
    if (visitedOrderRows.has(key)) {
      playbackWarnings.push(`Song loop detected at order ${nextOrder}, row ${nextRow}; import stopped after one loop pass.`);
      return true;
    }
    return false;
  };

  while (orderPos < mod.patternOrder.length && safety++ < maxPlayedOrders && currentBeat < maxTotalBeats) {
    const orderRowKey = `${orderPos}:${startRowForOrder}`;
    if (visitedOrderRows.has(orderRowKey)) {
      playbackWarnings.push(`Song loop detected at order ${orderPos}, row ${startRowForOrder}; import stopped.`);
      break;
    }
    visitedOrderRows.add(orderRowKey);

    const patIdx = mod.patternOrder[orderPos]!;
    const pattern = mod.patterns[patIdx];
    cuePoints.push({ beat: currentBeat, order: orderPos, pattern: patIdx });

    if (!pattern) {
      currentBeat += 64 * rowBeats();
      orderPos++;
      continue;
    }

    let row = clamp(startRowForOrder, 0, pattern.rows.length - 1);
    startRowForOrder = 0;
    let jumpOrder: number | null = null;
    let breakRow: number | null = null;

    let rowSafety = 0;
    while (row < pattern.rows.length) {
      if (rowSafety++ > 4096) {
        addStat(effects.unsupported, { effect: 0x0e, param: 0x60, effectHi: 0x06, effectLo: 0x00, sample: 0, period: 0, midi: null });
        break;
      }
      const rowNotes = pattern.rows[row]?.notes ?? [];

      // Apply Fxx timing commands before calculating this row duration.
      // This matters for row 0 initial tempo/speed and for later timing changes.
      for (let ch = 0; ch < mod.channels; ch++) {
        const n = rowNotes[ch];
        if (!n || n.effect !== 0x0f || n.param <= 0) continue;
        if (n.param < 0x20) speed = n.param;
        else tempo = n.param;
      }

      const rb = rowBeats();
      const beatTime = currentBeat;
      let patternDelayRows = 0;
      let patternLoopJumpRow: number | null = null;
      const volumeDeltasAfterRow = new Array(mod.channels).fill(0) as number[];

      // First pass: row-global timing/navigation effects and immediate sample/volume state.
      for (let ch = 0; ch < mod.channels; ch++) {
        const n = rowNotes[ch];
        if (!n) continue;
        const cs = chanState[ch]!;

        if (n.sample > 0) {
          cs.lastSample = n.sample;
          cs.volume = clamp(sampleByIndex.get(n.sample)?.volume ?? cs.volume, 0, 64);
          if (n.effect !== 0x09) cs.sampleOffset = 0;
        }

        switch (n.effect) {
          case 0x08:
            // Panning is intentionally ignored. Static Simpler pan caused one-sided output.
            addStat(effects.unsupported, n);
            break;
          case 0x09: {
            const sample = n.sample > 0 ? n.sample : cs.lastSample;
            if (sample > 0 && n.param > 0) cs.sampleOffset = sampleOffsetFrames(sample, n.param);
            // 9xx cannot be represented per note in the current SDK. Earlier builds split
            // every offset into a dedicated Simpler track, but some modules generate hundreds
            // of offsets. Report it instead of exploding the Live set.
            if (n.param > 0) addStat(effects.unsupported, n);
            break;
          }
          case 0x0a: {
            // Axy volume slide: no continuous automation in the SDK, but the channel
            // volume state can be updated so later note-ons get the correct velocity.
            if (n.param > 0) cs.volSlideParam = n.param;
            const up = n.effectHi;
            const down = n.effectLo;
            volumeDeltasAfterRow[ch] += up > 0 ? up : -down;
            addStat(effects.approximated, n);
            break;
          }
          case 0x0b:
            jumpOrder = clamp(n.param, 0, mod.patternOrder.length);
            breakRow = 0;
            addStat(effects.implemented, n);
            break;
          case 0x0c:
            // Cxx Set Volume is safe when used as note-on velocity.
            // Important for compact sample-track mode: do not create automation and do
            // not alter already-running notes. We only store the channel volume state;
            // the second pass applies it to a newly triggered note on this row.
            cs.volume = clamp(n.param, 0, 64);
            addStat(effects.implemented, n);
            break;
          case 0x0d:
            breakRow = bcdRow(n.param);
            if (jumpOrder === null) jumpOrder = orderPos + 1;
            addStat(effects.implemented, n);
            break;
          case 0x0e:
            switch (n.effectHi) {
              case 0x00:
                // E00 enables the Amiga LED lowpass filter; E01 disables it in many players.
                // This is reported only. Splitting by filter state creates extra tracks and
                // static Simpler filtering is not a faithful row-level effect.
                cs.ledFilterOn = n.effectLo === 0;
                addStat(effects.unsupported, n);
                break;
              case 0x01:
              case 0x02:
                addStat(effects.unsupported, n);
                break;
              case 0x03:
              case 0x04:
              case 0x07:
              case 0x0f:
                // Recognized, but no direct SDK target. Keep as reported.
                addStat(effects.unsupported, n);
                break;
              case 0x08:
                // Panning is intentionally ignored. Static Simpler pan caused one-sided output.
                addStat(effects.unsupported, n);
                break;
              case 0x05:
                cs.finetune = n.effectLo >= 8 ? n.effectLo - 16 : n.effectLo;
                addStat(effects.approximated, n);
                break;
              case 0x06:
                // E60 marks the loop start. E6x repeats the marked block x times.
                if (n.effectLo === 0) {
                  cs.patternLoopStart = row;
                  // Important: when an active E6x loop jumps back over its E60 marker,
                  // ProTracker must not reinitialize the repeat counter. Resetting here
                  // caused infinite loops on modules such as X-Airwolf-X.
                } else {
                  if (cs.patternLoopRemaining === null) cs.patternLoopRemaining = n.effectLo;
                  if (cs.patternLoopRemaining > 0) {
                    cs.patternLoopRemaining--;
                    patternLoopJumpRow = cs.patternLoopStart;
                  } else {
                    cs.patternLoopRemaining = null;
                  }
                }
                addStat(effects.implemented, n);
                break;
              case 0x09:
              case 0x0c:
              case 0x0d:
                addStat(effects.implemented, n);
                break;
              case 0x0a:
                volumeDeltasAfterRow[ch] += n.effectLo;
                addStat(effects.approximated, n);
                break;
              case 0x0b:
                volumeDeltasAfterRow[ch] -= n.effectLo;
                addStat(effects.approximated, n);
                break;
              case 0x0e:
                patternDelayRows = Math.max(patternDelayRows, n.effectLo);
                addStat(effects.implemented, n);
                break;
            }
            break;
          case 0x0f:
            if (n.param > 0 && n.param < 0x20) speed = n.param;
            else if (n.param >= 0x20) tempo = n.param;
            if (n.param > 0) addStat(effects.implemented, n);
            break;
          case 0x05:
          case 0x06: {
            // 5xy / 6xy combine pitch modulation with a volume-slide component.
            // Pitch modulation remains reported-only, but the volume-slide part is
            // safe as channel state for subsequent note-on velocities.
            if (n.param > 0) cs.volSlideParam = n.param;
            const up = n.effectHi;
            const down = n.effectLo;
            volumeDeltasAfterRow[ch] += up > 0 ? up : -down;
            addStat(effects.unsupported, n);
            break;
          }
          default:
            if ([0x01, 0x02, 0x03, 0x04, 0x07].includes(n.effect)) addStat(effects.unsupported, n);
            break;
        }
      }

      // Second pass: musical note events only. No per-tick MIDI segmentation.
      for (let ch = 0; ch < mod.channels; ch++) {
        const n = rowNotes[ch];
        if (!n) continue;
        const cs = chanState[ch]!;

        const sample = n.sample > 0 ? n.sample : cs.lastSample;
        if (n.sample > 0 && n.effect === 0x09 && n.param > 0) cs.sampleOffset = sampleOffsetFrames(sample, n.param);
        const pitch = sample > 0 && n.midi !== null ? pitchWithFineTune(n.midi, cs, sample) : null;
        if (sample <= 0 || pitch === null) continue;

        // MOD tracker channels are monophonic. Closing all sample tracks for this channel
        // prevents false polyphony when the same hardware channel switches instruments.
        closeAllChannelNotes(cs, beatTime);

        // Velocity follows dynamic MOD channel volume state. The selected sample's
        // header volume is mapped to Simpler Volume, so default notes must not be
        // attenuated a second time. Therefore velocity is relative to the sample
        // header volume: sample default => 127, lower Cxx/slides => quieter.
        const sampleHeaderVolume = clamp(sampleByIndex.get(sample)?.volume ?? 64, 1, 64);
        const velocity = clamp((cs.volume / sampleHeaderVolume) * 127, 1, 127);
        const baseDuration = rb * 0.95;
        let delay = 0;
        let cutAt: number | null = null;
        let retrig = 0;

        if (n.effect === 0x0e) {
          if (n.effectHi === 0x0d) delay = (n.effectLo / Math.max(1, speed)) * rb;
          else if (n.effectHi === 0x0c) cutAt = (n.effectLo / Math.max(1, speed)) * rb;
          else if (n.effectHi === 0x09) retrig = n.effectLo;
        }

        const start = beatTime + delay;
        const dur = Math.max(1 / 128, cutAt !== null ? Math.min(baseDuration, cutAt) : baseDuration - delay);
        closeOpenNote(cs, sample, start);

        if (drumSamples.has(sample)) {
          if (!drumHits.has(sample)) drumHits.set(sample, []);
          drumHits.get(sample)!.push({ startTime: start, velocity });
          continue;
        }

        // ── 9xx offset routing ─────────────────────────────────────────────
        // If this row carries a 9xx and the sample has offset classification,
        // route into an offset-keyed part. Pitch remapping for 'pad' offsets
        // (single-pitch → DrumRack) happens in the post-processing step below.
        const activeOffset = n.effect === 0x09 && n.param > 0 ? n.param : 0;
        if (activeOffset > 0 && drumRackSamples.has(sample)) {
          const classification = offsetClassify.get(sample)?.get(activeOffset);
          if (classification === 'pad' || classification === 'simpler') {
            // Both pad and simpler offsets get their own offset-keyed part.
            // For 'pad': pitch stays as original for now; remapped after loop.
            // For 'simpler': pitch stays as original always.
            const note = addNote(ch, sample, pitch, start, dur, velocity, activeOffset);
            if (cutAt === null) cs.openBySample.set(sample, { note, startBeat: start });
            continue;
          }
        }

        // ── Normal (no-offset) note ────────────────────────────────────────
        // Keep note generation conservative in compact sample-track mode.
        // 0xy arpeggio and E9x retrigger are tracker tick effects. Earlier builds emitted
        // extra very short MIDI notes for them, but after merging all MOD channels of the
        // same sample into one polyphonic Simpler track those micro-notes can sound like
        // wrong pre-hits before sustained notes. Report them instead of creating extra notes.
        if (n.effect === 0x00 && n.param > 0) addStat(effects.unsupported, n);
        if (retrig > 0) addStat(effects.unsupported, n);

        const note = addNote(ch, sample, pitch, start, dur, velocity);
        if (cutAt === null) cs.openBySample.set(sample, { note, startBeat: start });
      }

      // Apply row-level volume-slide state changes after note-on handling, matching
      // the conservative MIDI model: no automation of already-running notes, but
      // later note triggers inherit the updated channel volume.
      for (let ch = 0; ch < mod.channels; ch++) {
        if (volumeDeltasAfterRow[ch] !== 0) {
          chanState[ch]!.volume = clamp(chanState[ch]!.volume + volumeDeltasAfterRow[ch]!, 0, 64);
        }
      }

      currentBeat += rb * (1 + patternDelayRows);
      if (currentBeat >= maxTotalBeats) {
        playbackWarnings.push(`Import stopped at ${maxTotalBeats} beats to prevent an excessive song loop.`);
        break;
      }

      if (jumpOrder !== null) break;
      if (patternLoopJumpRow !== null) {
        row = clamp(patternLoopJumpRow, 0, pattern.rows.length - 1);
        continue;
      }
      row++;
    }

    if (jumpOrder !== null) {
      const nextOrder = jumpOrder;
      const nextRow = breakRow ?? 0;
      if (stopAtSongLoop(nextOrder, nextRow)) break;
      orderPos = nextOrder;
      startRowForOrder = nextRow;
    } else {
      const nextOrder = orderPos + 1;
      if (nextOrder < mod.patternOrder.length && stopAtSongLoop(nextOrder, 0)) break;
      orderPos = nextOrder;
    }
  }

  if (safety >= maxPlayedOrders) {
    playbackWarnings.push(`Import stopped after ${maxPlayedOrders} played orders to prevent excessive repetition.`);
  }
  if (currentBeat >= maxTotalBeats) {
    currentBeat = Math.min(currentBeat, maxTotalBeats);
  }

  for (const cs of chanState) closeAllChannelNotes(cs, currentBeat);

  // ── Post-processing: separate offset parts into DrumRackParts ────────────
  const regularParts: MidiPart[] = [];
  const drumRackPartMap = new Map<number, DrumRackPart>(); // sampleIndex → DrumRackPart
  const PAD_BASE_NOTE = 36; // C1 — first receivingNote for pads

  for (const [key, part] of parts) {
    if (part.notes.length === 0) continue;

    const sampleIdx = part.key.sample;
    const offsetParam = part.key.offsetParam ?? 0;

    if (offsetParam === 0) {
      regularParts.push(part);
      continue;
    }

    const classification = offsetClassify.get(sampleIdx)?.get(offsetParam);

    if (classification === 'simpler') {
      // Multi-pitch offset → regular Simpler part, pitches unchanged
      regularParts.push(part);
      continue;
    }

    if (classification === 'pad') {
      // Single-pitch offset → DrumRack pad
      if (!drumRackPartMap.has(sampleIdx)) {
        drumRackPartMap.set(sampleIdx, { sampleIndex: sampleIdx, pads: [] });
      }
      const drp = drumRackPartMap.get(sampleIdx)!;
      const padIndex = drp.pads.length;
      const receivingNote = PAD_BASE_NOTE + padIndex;

      const pitchSet = offsetPitches.get(sampleIdx)?.get(offsetParam);
      const originalPitch = pitchSet ? Array.from(pitchSet)[0]! : MOD_ROOT_MIDI;
      const transpose = originalPitch - MOD_ROOT_MIDI;

      const sampleData = mod.samples.find(s => s.index === sampleIdx);
      const byteOffset = offsetParam * 256;
      const frameOffset = sampleData?.pcmBits === 16 ? Math.floor(byteOffset / 2) : byteOffset;
      const clampedFrame = Math.max(0, Math.min(
        frameOffset, sampleData ? Math.max(0, sampleData.length - 1) : 0,
      ));

      // Remap all note pitches to this pad's receivingNote
      const remappedNotes = part.notes.map(n => ({ ...n, pitch: receivingNote }));

      drp.pads.push({ offsetParam, frameOffset: clampedFrame, receivingNote, transpose, notes: remappedNotes });

      // Mark as approximated
      const fakeN = { effect: 0x09, param: offsetParam,
        effectHi: (offsetParam >> 4) & 0xf, effectLo: offsetParam & 0xf,
        sample: sampleIdx, period: 0, midi: null } as ModNote;
      addStat(effects.approximated, fakeN);
    }
  }

  for (const part of regularParts) {
    part.voices = maxOverlappingNotes(part.notes);
  }

  const drumRackParts = Array.from(drumRackPartMap.values()).filter(d => d.pads.length > 0);

  // Backward-compatible sample-level voice estimate retained for older callers.
  // The extension now prefers MidiPart.voices, which is based on actual note overlap
  // in the generated Ableton track rather than on row-level sample usage.
  // Compute max simultaneous channels per sample across all patterns in song order.
  // A "simultaneous" use means two or more channels fire a note for the same sample
  // on the same row. This tells us how many Simpler voices are needed.
  const maxSimultaneousChannels = new Map<number, number>();
  for (const patIdx of mod.patternOrder) {
    const pattern = mod.patterns[patIdx];
    if (!pattern) continue;
    for (const row of pattern.rows) {
      const rowSmpCount = new Map<number, number>();
      for (const note of row.notes) {
        if (note.sample > 0 && note.period > 0) {
          rowSmpCount.set(note.sample, (rowSmpCount.get(note.sample) ?? 0) + 1);
        }
      }
      for (const [smp, count] of rowSmpCount) {
        if (count > (maxSimultaneousChannels.get(smp) ?? 0)) {
          maxSimultaneousChannels.set(smp, count);
        }
      }
    }
  }

  return {
    parts: regularParts,
    drumRackParts,
    drumHits,
    totalBeats: currentBeat,
    beatsPerRow: defaultBeatsPerRow,
    cuePoints,
    effects,
    unsupportedEffects: effects.unsupported,
    maxSimultaneousChannels,
    playbackWarnings,
  };
}

export function buildNativeNotesByChannelAndSample(mod: ModFile, drumSamples: Set<number>): NativeBuiltNotes {
  return buildRowNativeNotesByChannelAndSample(mod, drumSamples);
}
