import * as fs from "node:fs";
import * as path from "node:path";
import {
  initialize,
  Simpler,
  Device,
  DrumRack,
  DrumChain,
  type ActivationContext,
  type ExtensionContext,
} from "@ableton-extensions/sdk";

import dialogHtml from "./dialog.html";
import { parseMod, MOD_ROOT_MIDI, type ModFile, type ModSample } from "./mod-parser";
import { extOf, isTrackerFile } from "./tracker-formats";
import { buildNativeNotesByChannelAndSample, type DrumRackPart } from "./native-note-builder";
import { writeSampleWav } from "./wav-writer";

type Ctx = ExtensionContext<"1.0.0">;

interface ImportOptions {
  /** Local .mod path. Used for folder import and for downloaded ModArchive files. */
  filePath: string;
  /** Original ModArchive URL when imported from URL. */
  sourceUrl?: string;
  /** Canonical ModArchive module page, if known. */
  sourcePageUrl?: string;
  /** Best-effort composer/artist parsed from ModArchive, if available. */
  sourceArtist?: string;
  /** Best-effort license attribution parsed from ModArchive, if available. */
  sourceLicense?: string;
  /** Human-readable source label for result dialog. Never contains private full paths. */
  sourceLabel?: string;
  extractSamples: boolean;
  /** WAV export bit depth for extracted samples. 8-bit preserves the MOD source most directly; 16-bit is an optional compatibility/export format. */
  wavBitDepth?: 8 | 16;
  /** Optional WAV export sample rate. When set above the MOD source rate, samples are resampled to keep pitch and duration. */
  wavSampleRate?: number;
  cuePoints: boolean;
  /** Remove already-existing empty regular tracks after successful import. */
  removeEmptyTracks?: boolean;
  /** Add a built-in Limiter device to the Live Set main track after a successful import. */
  addLimiterToMain?: boolean;
  /** Optional local folder path entered by the user. Empty means extension data folder. */
  localFolder?: string;
}

interface ImportReport {
  title: string;
  tracks: number;
  totalNotes: number;
  samplesLoaded: number;
  totalBeats: number;
  firstSimplerParams: string[];
  errors: string[];
  sourceUrl?: string;
  sourcePageUrl?: string;
  sourceArtist?: string;
  sourceLicense?: string;
  sourceLabel?: string;
  internalTexts?: string[];
  possibleComposer?: string;
  sampleInfo?: string[];
  songInfo?: string[];
  loopInfo?: string[];
  playbackWarnings?: string[];
}


// ─── Helpers ──────────────────────────────────────────────────────────────────





function sanitizeLogText(value: unknown): string {
  const text = value instanceof Error ? (value.stack || value.message) : String(value);
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home ? text.split(home).join('<USER_HOME>') : text;
}

function logInfo(message: string): void {
  console.info(`[MOD Importer] ${message}`);
}

function logWarn(message: string, details?: unknown): void {
  if (details === undefined) {
    console.warn(`[MOD Importer] ${message}`);
    return;
  }
  console.warn(`[MOD Importer] ${message}: ${sanitizeLogText(details)}`);
}

function logError(message: string, error: unknown): void {
  console.error(`[MOD Importer] ${message}: ${sanitizeLogText(error)}`);
}


function findSimpler(devices: Device<"1.0.0">[]): Simpler<"1.0.0"> | null {
  return devices.find((d): d is Simpler<"1.0.0"> => d instanceof Simpler) ?? null;
}

function findDrumRack(devices: Device<"1.0.0">[]): DrumRack<"1.0.0"> | null {
  return devices.find((d): d is DrumRack<"1.0.0"> => d instanceof DrumRack) ?? null;
}

/**
 * Build one MIDI track + Drum Rack for a sample that uses 9xx offsets at single pitches.
 * Each unique offset gets one pad (DrumChain → Simpler) with:
 *   - S Start set to the frame offset (normalised 0–1)
 *   - receivingNote set to the pad's assigned MIDI note
 *   - Transpose set so the pad plays at the original MOD pitch
 * Returns the number of pads loaded successfully.
 */
async function buildDrumRackTrack(
  ctx: Ctx,
  drp: DrumRackPart,
  track: any,
  wavPath: string,
  sampleMeta: ModSample,
  mod: ModFile,
  totalBeats: number,
): Promise<{ samplesLoaded: number; totalNotes: number }> {
  let samplesLoaded = 0;
  let totalNotes = 0;

  // Insert Drum Rack device
  await track.insertDevice("Drum Rack", 0);
  const drumRack = findDrumRack(track.devices);
  if (!drumRack) return { samplesLoaded, totalNotes };

  // Sort pads by offsetParam so pads appear in order in the rack
  const sortedPads = [...drp.pads].sort((a, b) => a.offsetParam - b.offsetParam);

  for (let i = 0; i < sortedPads.length; i++) {
    const pad = sortedPads[i]!;

    // Insert a new chain for this pad
    const chain = await drumRack.insertChain(i) as DrumChain<"1.0.0">;

    // Set receivingNote before loading sample
    chain.receivingNote = pad.receivingNote;

    // Insert Simpler into the pad chain
    await chain.insertDevice("Simpler", 0);
    const simpler = chain.devices.find((d): d is Simpler<"1.0.0"> => d instanceof Simpler) ?? null;
    if (!simpler) continue;

    // Load sample
    await simpler.replaceSample(wavPath);
    samplesLoaded++;

    // Configure Simpler — base settings first (loop, ADSR, root key)
    await configureSimplerParams(ctx, simpler, sampleMeta, mod, pad.transpose, pad.frameOffset, false);
  }

  // Create one MIDI clip with all pad notes merged
  const clip: any = await track.createMidiClip(0, totalBeats);
  const allNotes = sortedPads.flatMap(p => p.notes);
  if (allNotes.length > 0) {
    ctx.withinTransaction(() => { clip.notes = allNotes; });
    totalNotes = allNotes.length;
  }

  const offsetList = sortedPads.map(p => `9${p.offsetParam.toString(16).toUpperCase().padStart(2,'0')}`).join(', ');
  clip.name = `${String(sampleMeta.index).padStart(2,'0')} · ${sampleMeta.name.replace(/^st-\d+:/i,'').replace(/\x00/g,'').trim() || `Sample ${sampleMeta.index}`} [${offsetList}]`;

  return { samplesLoaded, totalNotes };
}

/** Apply all Simpler parameters based on sample + effect analysis */
async function configureSimplerParams(
  ctx: Ctx,
  simpler: Simpler<"1.0.0">,
  sample: ModSample,
  mod: ModFile,
  transposeSemitones = 0,
  sampleStartOffset = 0,
  ledFilterOn = false,
  voices = 1,
): Promise<void> {
  const fx = mod.sampleEffects.get(sample.index);
  const portoSpeed = mod.portamentoSamples.get(sample.index) ?? 0;
  const rootMidi = MOD_ROOT_MIDI;

  // Set each parameter directly — no transaction wrapper
  // MOD accuracy mode: Simpler should behave like a tracker sample player: instant attack, sustain while gated, short release.
  // (avoids nesting issues inside withinProgressDialog)
  for (const p of simpler.parameters) {
    const n = p.name.trim().toLowerCase();
    try {
      if (n === 'device on') {
        await p.setValue(1);
      } else if (n === 's loop on') {
        await p.setValue(sample.looped ? 1 : 0);
      } else if (n === 'snap' || n === 's snap' || n === 'snap to zero crossing') {
        // MOD accuracy: keep original sample/loop points. Simpler Snap can move them
        // to zero crossings and disturb tracker loop timing, especially for short loops.
        await p.setValue(0);
      } else if ((n === 's start' || n === 'sample start' || n === 'start') && p.min <= 0 && p.max >= 0) {
        // Normal import keeps Sample Start at 0. MOD 9xx sample-offset is reported only
        // by default because per-note sample start is not exposed by the SDK.
        const normalizedStart = sample.length > 0 ? Math.max(0, Math.min(1, sampleStartOffset / sample.length)) : 0;
        await p.setValue(normalizedStart);
      } else if ((n === 's length' || n === 'sample length' || n === 'length') && p.min <= 1 && p.max >= 1) {
        await p.setValue(1);
      } else if (ledFilterOn && n === 'f on') {
        await p.setValue(1);
      } else if (!ledFilterOn && n === 'f on') {
        await p.setValue(0);
      } else if (ledFilterOn && n === 'filter type') {
        await p.setValue(Math.max(p.min, Math.min(p.max, 0))); // Lowpass
      } else if (ledFilterOn && n === 'filter freq') {
        await p.setValue(Math.max(p.min, Math.min(p.max, 0.55)));
      } else if (ledFilterOn && n === 'filter res') {
        await p.setValue(Math.max(p.min, Math.min(p.max, 0)));
      } else if ((n === 's loop start' || n === 'loop start' || n === 'loop position' || n === 's loop position') && sample.looped && sample.length > 0) {
        await p.setValue(Math.max(0, Math.min(1, sample.loopStart / sample.length)));
      } else if ((n === 's loop length' || n === 'loop length') && sample.looped && sample.loopLength > 0 && sample.length > 0) {
        await p.setValue(Math.max(0, Math.min(1, sample.loopLength / sample.length)));
      } else if ((n === 's loop end' || n === 'loop end') && sample.looped && sample.length > 0) {
        await p.setValue(Math.min(1, (sample.loopStart + sample.loopLength) / sample.length));
      } else if ((n === 'attack' || n === 'a attack' || n === 'amp attack') && p.min <= 0) {
        await p.setValue(0);
      } else if ((n === 'decay' || n === 'a decay' || n === 'amp decay') && p.min <= 0) {
        await p.setValue(0);
      } else if ((n === 'sustain' || n === 'a sustain' || n === 'amp sustain') && p.max >= 1) {
        await p.setValue(p.max >= 100 ? 100 : 1);
      } else if ((n === 'release' || n === 'a release' || n === 'amp release') && p.min <= 0) {
        await p.setValue(0);
      } else if ((n === 'root key' || n === 'root note' || n === 'rootkey' || n === 'root') && p.min <= rootMidi && p.max >= rootMidi) {
        await p.setValue(rootMidi);
      } else if ((n === 'transpose' || n === 'transp' || n === 'pitch') && transposeSemitones !== 0 && p.min <= transposeSemitones && p.max >= transposeSemitones) {
        // Optional pitch offset for special import modes. Normal import keeps this at 0.
        await p.setValue(transposeSemitones);
      } else if (n === 'volume') {
        // Map MOD sample-header volume to a static Simpler level, with the old
        // -12 dB headroom as the maximum. MOD sample volume 64 => -12 dB;
        // lower header volumes attenuate below that logarithmically. Dynamic
        // row/channel volume effects are still represented by MIDI velocity.
        const maxDb = -12;
        const headerVolume = Math.max(0, Math.min(64, Math.floor(sample.volume ?? 64)));
        const db = headerVolume <= 0 ? -60 : maxDb + 20 * Math.log10(headerVolume / 64);
        await p.setValue(Math.max(p.min, Math.min(p.max, db)));
      } else if ((n === 'vol < vel' || n === 'volume < velocity' || n === 'vel > vol') && p.min <= 1 && p.max >= 0.35) {
        // Ableton Simpler's useful default is around 35%. Setting this to 100% made
        // tracker velocity changes far too extreme.
        await p.setValue(0.35);
      } else if ((n === 'detune' || n === 'fine' || n === 'fine tune') && sample.finetune !== 0) {
        // ProTracker finetune is in sixteenth-ish semitone steps, not semitones.
        // Do not write it to Transpose, otherwise samples are audibly mistuned.
        const cents = Math.max(p.min, Math.min(p.max, sample.finetune * 12.5));
        await p.setValue(cents);
      } else if (n === 'glide mode') {
        // Keep Simpler neutral. Device-level glide/mono made compact sample tracks
        // sound chopped when the same sample plays polyphonically across MOD channels.
        await p.setValue(0);
      } else if (n === 'glide time') {
        await p.setValue(Math.max(0, Math.min(1, 0)));
      } else if (n === 'voices') {
        // Set voices to match the number of MOD channels that use this sample simultaneously.
        // With Voices=1, every new note kills the previous — correct for single-channel samples,
        // but wrong when the same sample plays on 2+ channels at once (e.g. melody + echo).
        await p.setValue(Math.max(p.min, Math.min(p.max, voices)));
      } else if (fx?.usesVibrato) {
        if (n === 'l on') await p.setValue(1);
        else if (n === 'l wave') await p.setValue(0); // Sine
        else if (n === 'pitch < lfo' && fx.maxVibratoDepth > 0) {
          await p.setValue(Math.min(1, (fx.maxVibratoDepth / 16) * 0.5));
        } else if (n === 'l rate' && fx.maxVibratoSpeed > 0) {
          await p.setValue(Math.min(1, fx.maxVibratoSpeed / 16));
        }
      }
    } catch { /* ignore read-only params */ }
  }
}


function sampleOffsetFramesFrom9xx(sample: ModSample, offsetParam: number | undefined): number {
  const param = Math.max(0, Math.min(255, Math.floor(offsetParam ?? 0)));
  if (param <= 0 || sample.length <= 0) return 0;
  const byteOffset = param * 256;
  const frameOffset = sample.pcmBits === 16 ? Math.floor(byteOffset / 2) : byteOffset;
  return Math.max(0, Math.min(frameOffset, Math.max(0, sample.length - 1)));
}

function offsetLabelFrom9xx(offsetParam: number | undefined): string {
  const param = Math.max(0, Math.min(255, Math.floor(offsetParam ?? 0)));
  return param > 0 ? ` [9${param.toString(16).toUpperCase().padStart(2, '0')}]` : '';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function displayFileName(filePath: string): string {
  return path.basename(filePath || '') || 'selected file';
}

interface UserConfig {
  localFolder?: string;
}

function normalizeUserFolder(input: string, fallback: string): string {
  const raw = (input || '').trim();
  if (!raw) return fallback;
  if (raw === '~') return process.env.HOME || process.env.USERPROFILE || fallback;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || process.env.USERPROFILE || fallback, raw.slice(2));
  return path.resolve(raw);
}

function readUserConfig(configPath: string): UserConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeUserConfig(configPath: string, config: UserConfig): void {
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  } catch (error) {
    logWarn('Could not write user configuration', error);
  }
}

function scanModFolder(folderPath: string): { files: { name: string; path: string }[]; status: string } {
  if (!folderPath || !folderPath.trim()) {
    return { files: [], status: 'Extension data folder is not available.' };
  }
  try {
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) {
      return { files: [], status: 'Extension data folder is not a folder.' };
    }
    const files = fs.readdirSync(folderPath)
      .filter((f: string) => isTrackerFile(f))
      .sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((f: string) => ({ name: f, path: path.join(folderPath, f) }));
    return {
      files,
      status: files.length === 1 ? '1 .mod file found.' : `${files.length} .mod files found.`,
    };
  } catch {
    return { files: [], status: 'Extension data folder cannot be read.' };
  }
}

function modEffectLabel(code: string): string {
  const effect = code[0]?.toUpperCase() ?? '?';
  const param = code.slice(1).toUpperCase().padStart(2, '0');
  const hi = param[0] ?? '0';
  const lo = param[1] ?? '0';
  const names: Record<string, string> = {
    '0': 'arpeggio', '1': 'pitch slide up', '2': 'pitch slide down',
    '3': 'tone portamento / glide', '4': 'vibrato', '5': 'portamento + volume slide',
    '6': 'vibrato + volume slide', '7': 'tremolo', '8': 'set panning',
    '9': 'sample offset', 'A': 'volume slide', 'B': 'position jump',
    'C': 'set volume', 'D': 'pattern break', 'F': 'set speed/tempo',
  };
  if (effect === 'E') {
    const eNames: Record<string, string> = {
      '0': 'LED lowpass filter', '1': 'fine pitch slide up', '2': 'fine pitch slide down',
      '3': 'glissando control', '4': 'set vibrato waveform', '5': 'set finetune',
      '6': 'pattern loop', '7': 'set tremolo waveform', '8': 'extended panning',
      '9': 'sample retrigger', 'A': 'fine volume slide up', 'B': 'fine volume slide down',
      'C': 'note cut', 'D': 'note delay', 'E': 'pattern delay', 'F': 'invert loop / funk repeat',
    };
    return `${code} (${eNames[hi] ?? 'extended MOD effect'} E${hi}${lo})`;
  }
  return `${code} (${names[effect] ?? 'MOD effect'} ${effect}xx, param ${param})`;
}

function effectGroup(code: string): string {
  const effect = code[0]?.toUpperCase() ?? '?';
  const hi = code[1]?.toUpperCase() ?? '?';
  if (effect === 'A' || effect === 'C' || (effect === 'E' && ['A','B'].includes(hi)) || effect === '5' || effect === '6') return 'Volume / note volume';
  if (['1','2','3','4','7'].includes(effect) || (effect === 'E' && ['1','2','3','4','5','7','F'].includes(hi))) return 'Pitch / modulation';
  if (effect === '8' || (effect === 'E' && hi === '8')) return 'Panning';
  if (effect === '9') return 'Sample offset';
  if (['B','D','F'].includes(effect) || (effect === 'E' && ['6','E'].includes(hi))) return 'Song structure';
  if (effect === 'E' && ['0','9','C','D'].includes(hi)) return 'Playback helpers';
  return 'Other';
}

function formatEffectDetails(effects: Map<string, number>, max = 5): string {
  return Array.from(effects.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k, v]) => `${modEffectLabel(k)} × ${v}`)
    .join('; ');
}

function groupedEffectSummary(effects: Map<string, number>): string {
  const groups = new Map<string, { total: number; details: Map<string, number> }>();
  for (const [code, count] of effects) {
    const group = effectGroup(code);
    if (!groups.has(group)) groups.set(group, { total: 0, details: new Map() });
    const g = groups.get(group)!;
    g.total += count;
    g.details.set(code, (g.details.get(code) ?? 0) + count);
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, g]) => `${name}: ${g.total} (${formatEffectDetails(g.details, 3)})`)
    .join('\n');
}

function possibleComposerFromInternalTexts(texts: string[]): string | undefined {
  const bad = /^(sample|instrument|untitled|loop|bass|snare|kick|hat|lead|chord|strings?|drum|bd|sd|hh|tom|cymbal|blank|empty)\b/i;
  const patterns = [
    /\b(?:composed|written|tracked|made|coded|music)\s+by\s+(.{2,48})/i,
    /\bby\s+(.{2,48})/i,
    /\(c\)\s*(.{2,48})/i,
    /copyright\s+(.{2,48})/i,
  ];
  for (const raw of texts) {
    const t = raw.replace(/[_*~=+#\[\]{}<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (bad.test(t)) continue;
    for (const re of patterns) {
      const m = t.match(re);
      if (!m?.[1]) continue;
      const v = m[1].replace(/\b(?:of|for|in|on)\b.*$/i, '').replace(/[.,;:!?)]+$/g, '').trim();
      if (v.length >= 2 && !bad.test(v)) return v;
    }
  }
  return undefined;
}

function buildSampleInfo(mod: ModFile, wavBitDepth: 8 | 16 = 8, wavSampleRate?: number): string[] {
  const used = mod.samples.filter(s => s.length > 0);
  const loops = used.filter(s => s.looped).length;
  const tuned = used.filter(s => s.finetune !== 0).length;
  const rates = Array.from(new Set(used.map(s => s.sampleRate ?? 8287))).sort((a,b) => a - b);
  const rateLabel = rates.length === 1 ? `${(rates[0]! / 1000).toFixed(3)} kHz` : rates.map(r => `${(r / 1000).toFixed(3)} kHz`).join(', ');
  const outputRate = wavSampleRate && wavSampleRate > 0 ? wavSampleRate : undefined;
  return [
    `${used.length} used / 31 slots`,
    `Source samples: 8-bit mono signed MOD PCM`,
    `WAV export: ${wavBitDepth}-bit mono PCM, ${outputRate ? `${(outputRate / 1000).toFixed(1)} kHz resampled` : 'source-rate'}, no normalize, no dither, no snap`,
    `Source sample rate: ${rateLabel}`,
    `Looped samples: ${loops}`,
    `Header finetune samples: ${tuned}`,
  ];
}

function buildSongInfo(mod: ModFile, cuePoints: { order: number; pattern: number }[]): string[] {
  const uniquePatterns = new Set(mod.patternOrder).size;
  const orderPreview = mod.patternOrder.slice(0, 24).map(n => String(n).padStart(2, '0')).join(' ');
  return [
    `Channels: ${mod.channels}`,
    `Order length: ${mod.songLength}`,
    `Patterns used: ${uniquePatterns}`,
    `Initial speed/tempo: ${mod.initialSpeed}/${mod.initialTempo}`,
    `Orders: ${orderPreview}${mod.patternOrder.length > 24 ? ' …' : ''}`,
  ];
}

function buildLoopInfo(mod: ModFile): string[] {
  const out: string[] = [];
  if (mod.loopSanitizer.clamped > 0 || mod.loopSanitizer.disabled > 0) {
    out.push(`Sanitized loops: ${mod.loopSanitizer.clamped} clamped, ${mod.loopSanitizer.disabled} disabled`);
    out.push(...mod.loopSanitizer.notes);
  } else {
    out.push('Loop headers: ok');
  }
  return out;
}


interface ModArchiveDownload {
  buffer: Buffer;
  filePath: string;
  fileName: string;
  sourceUrl: string;
  sourcePageUrl?: string;
  artist?: string;
  license?: string;
}

const MODARCHIVE_HOSTS = new Set([
  'modarchive.org',
  'www.modarchive.org',
  'api.modarchive.org',
]);

const PROTRACKER_MOD_TAGS = new Set(['M.K.', 'M!K!', 'FLT4', '4CHN']);

function isLikelyProTrackerMod(buffer: Buffer): boolean {
  if (buffer.length < 1084) return false;
  const tag = buffer.toString('latin1', 1080, 1084);
  return PROTRACKER_MOD_TAGS.has(tag);
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').trim();
  return cleaned || `modarchive_${Date.now()}.mod`;
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf?.[1]) {
    try { return decodeURIComponent(utf[1]); } catch { return utf[1]; }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

interface ParsedUrlLite {
  protocol: string;
  hostname: string;
  pathname: string;
  search: string;
  href: string;
}

function decodeQueryPart(value: string): string {
  try { return decodeURIComponent(value.replace(/\+/g, ' ')); }
  catch { return value; }
}

function parseAbsoluteUrlLite(input: string): ParsedUrlLite {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('No URL entered.');

  // Avoid global URL / node:url. The Ableton Extension runtime does not expose URL reliably.
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(?:#.*)?$/i.exec(trimmed);
  if (!match) throw new Error('Invalid URL. Paste a full ModArchive URL starting with https://');

  const protocol = `${match[1].toLowerCase()}:`;
  const hostPort = match[2];
  const hostname = hostPort.split(':')[0].toLowerCase();
  const pathname = match[3] || '/';
  const search = match[4] || '';
  return { protocol, hostname, pathname, search, href: trimmed };
}

function queryParam(url: ParsedUrlLite, name: string): string | null {
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (!query) return null;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeQueryPart(eq >= 0 ? part.slice(0, eq) : part);
    const value = decodeQueryPart(eq >= 0 ? part.slice(eq + 1) : '');
    if (key === name) return value;
  }
  return null;
}

function firstNumericUrlParamLite(url: ParsedUrlLite): string | null {
  const query = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (!query) return null;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodeQueryPart(eq >= 0 ? part.slice(0, eq) : part);
    const value = decodeQueryPart(eq >= 0 ? part.slice(eq + 1) : '');
    if (/^\d+$/.test(key)) return key;
    if (/^\d+$/.test(value)) return value;
  }
  return null;
}

function resolveModArchiveModuleId(input: string): string | null {
  const url = parseAbsoluteUrlLite(input);
  const moduleId = queryParam(url, 'moduleid')
    ?? (url.pathname.endsWith('/module.php') ? firstNumericUrlParamLite(url) : null)
    ?? ((url.pathname.endsWith('/index.php') && queryParam(url, 'request') === 'view_by_moduleid')
      ? queryParam(url, 'query')
      : null);
  return moduleId && /^\d+$/.test(moduleId) ? moduleId : null;
}

function modArchiveModulePageUrl(moduleId: string): string {
  return `https://modarchive.org/module.php?${moduleId}`;
}

function htmlEntityDecodeLite(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = Number.parseInt(n, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

function normalizeText(value: string): string {
  return htmlEntityDecodeLite(value.replace(/\s+/g, ' ').trim());
}

function stripHtmlToText(value: string): string {
  return normalizeText(value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
}

const BAD_META_VALUES = new Set([
  'chart', 'charts', 'member chart', 'artist chart', 'top favourites', 'most downloads', 'most revered',
  'all featured modules', 'featured modules', 'download', 'downloads', 'download mirrors', 'forum', 'forums',
  'comments', 'comment', 'your comments', 'reviews', 'review', 'your reviews', 'ratings', 'rating',
  'license', 'licenses', 'mod archive', 'mod archive distribution license',
  'the mod archive', 'artist', 'artists', 'composer', 'author', 'title', 'filename',
  'format', 'protracker', 'module', 'modules', 'search', 'home', 'help', 'wanted',
]);

function isGoodMetaValue(value: string | undefined): value is string {
  if (!value) return false;
  const v = normalizeText(value);
  const lower = v.toLowerCase();
  if (v.length < 2 || v.length > 120) return false;
  if (BAD_META_VALUES.has(lower)) return false;
  if (/^(title|artist|composer|author|license|downloads?|comments?|filename|format|chart|rating|reviews?|member\s+chart|artist\s+chart|all\s+featured\s+modules)\b/i.test(v)) return false;
  if (/(chart|download|rating|review|comment|favourite|favorite|featured module)/i.test(v)) return false;
  if (/^(\d+[\s.,]*)+$/.test(v)) return false;
  return true;
}

function firstGoodMatch(html: string, patterns: RegExp[]): string | undefined {
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const text = stripHtmlToText(m[1] ?? '');
      if (isGoodMetaValue(text)) return text;
    }
  }
  return undefined;
}

function firstCleanLineAfterLabel(lines: string[], labels: string[]): string | undefined {
  const lowerLabels = labels.map(l => l.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const lower = line.toLowerCase().replace(/:$/, '');
    const labelIndex = lowerLabels.findIndex(l => lower === l || lower.startsWith(`${l}:`));
    if (labelIndex < 0) continue;
    const label = lowerLabels[labelIndex]!;
    const sameLine = line.slice(label.length).replace(/^\s*:\s*/, '').trim();
    if (isGoodMetaValue(sameLine)) return normalizeText(sameLine);
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const candidate = lines[j]?.trim();
      if (!candidate) continue;
      if (/^(title|artist|composer|author|license|downloads?|comments?|filename|format|chart|rating|reviews?)\b/i.test(candidate)) break;
      if (isGoodMetaValue(candidate)) return normalizeText(candidate);
    }
  }
  return undefined;
}

function sliceBetween(input: string, start: RegExp, end?: RegExp): string {
  const m = start.exec(input);
  if (!m) return '';
  const from = m.index + m[0].length;
  if (!end) return input.slice(from);
  const rest = input.slice(from);
  const e = end.exec(rest);
  return e ? rest.slice(0, e.index) : rest;
}

function firstInternalTextArtist(text: string): string | undefined {
  const patterns = [
    /(?:composition\s+done\s+by|composed\s+by|composition\s+by|music\s+by|tracked\s+by|written\s+by|made\s+by|by)\s*:?\s*([\s\S]{2,90})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const raw = normalizeText((m[1] ?? '').split(/[\r\n]/)[0] ?? '');
    const cleaned = raw
      .replace(/^[-–—\s]+/, '')
      .replace(/\s+(?:in|on|for|with|using)\b[\s\S]*$/i, '')
      .replace(/[.;,]+$/, '')
      .trim();
    if (isGoodMetaValue(cleaned)) return cleaned;
  }
  return undefined;
}

function parseModArchiveMetaHtml(html: string): { artist?: string; license?: string } {
  // Work only on the actual module content. The page navigation contains misleading
  // labels such as "Member Chart" and "All Featured Modules" that must never become metadata.
  const mainHtml = sliceBetween(html, /<h1\b[\s\S]*?<\/h1>/i) || html;
  const beforeComments = sliceBetween(mainHtml, /^/i, /<h2\b[\s\S]*?(?:Comments|Reviews|People who like this tune|Download mirrors)/i) || mainHtml;
  const internalHtml = sliceBetween(mainHtml, /Internal\s+Texts?[\s\S]{0,200}/i, /As per section|Disclaimer|Up\s*<|Modarchive\.org Website/i);

  const artistFromLink = firstGoodMatch(beforeComments, [
    /<a\b[^>]*href=["'][^"']*(?:request=view_by_artistid|view_by_artistid|artistid|artist\.php|profile\.php|request=view_by_memberid|view_by_memberid|memberid)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    /(?:artist|composer|author)\s*:?\s*<\/[^>]+>\s*<[^>]*>\s*<a\b[^>]*>([\s\S]*?)<\/a>/gi,
    /(?:artist|composer|author)[\s\S]{0,240}?<a\b[^>]*>([\s\S]*?)<\/a>/gi,
  ]);

  const artistFromTable = firstGoodMatch(beforeComments, [
    /<(?:td|th)[^>]*>\s*(?:Artist|Composer|Author)\s*:?\s*<\/(?:td|th)>\s*<td[^>]*>([\s\S]*?)<\/td>/gi,
    /<(?:dt|strong|b)[^>]*>\s*(?:Artist|Composer|Author)\s*:?\s*<\/(?:dt|strong|b)>\s*<(?:dd|span|div|p)[^>]*>([\s\S]*?)<\/(?:dd|span|div|p)>/gi,
  ]);

  const licenseFromModuleSection = firstGoodMatch(beforeComments, [
    /Licensed\s+under\s+the\s+([\s\S]{2,180}?)(?:<\/li>|<\/p>|\n)/gi,
    /License\s*Attribution[\s\S]{0,240}?Licensed\s+under\s+the\s+([\s\S]{2,180}?)(?:<\/li>|<\/p>|\n)/gi,
  ]);
  const licenseFromTable = firstGoodMatch(beforeComments, [
    /<(?:td|th)[^>]*>\s*(?:License Attribution|License)\s*:?\s*<\/(?:td|th)>\s*<td[^>]*>([\s\S]*?)<\/td>/gi,
    /<(?:dt|strong|b)[^>]*>\s*(?:License Attribution|License)\s*:?\s*<\/(?:dt|strong|b)>\s*<(?:dd|span|div|p)[^>]*>([\s\S]*?)<\/(?:dd|span|div|p)>/gi,
  ]);

  const cleaned = beforeComments
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(?:tr|p|div|li|dd|dt|td|th|h1|h2|h3)>/gi, '\n')
    .replace(/<[^>]+>/g, '\n');
  const lines = cleaned.split(/\n+/).map(normalizeText).filter(Boolean);
  const internalText = stripHtmlToText(internalHtml || '');

  const artist = artistFromLink
    ?? artistFromTable
    ?? firstCleanLineAfterLabel(lines, ['Artist', 'Composer', 'Author'])
    ?? firstInternalTextArtist(internalText);
  const license = licenseFromModuleSection
    ?? licenseFromTable
    ?? firstCleanLineAfterLabel(lines, ['License Attribution', 'License']);

  return {
    artist: isGoodMetaValue(artist) ? normalizeText(artist) : undefined,
    license: isGoodMetaValue(license) ? normalizeText(license) : undefined,
  };
}

async function fetchModArchiveMeta(moduleId: string): Promise<{ sourcePageUrl: string; artist?: string; license?: string }> {
  const sourcePageUrl = modArchiveModulePageUrl(moduleId);
  try {
    const res = await fetch(sourcePageUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Ableton-MOD-Importer/4.5 (+single-user-url-import)',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
    });
    if (!res.ok) return { sourcePageUrl };
    const html = await res.text();
    return { sourcePageUrl, ...parseModArchiveMetaHtml(html) };
  } catch {
    return { sourcePageUrl };
  }
}

function pathBaseNameFromUrlLike(url: string): string {
  const clean = url.split('#')[0].split('?')[0];
  const parts = clean.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function resolveModArchiveDownloadUrl(input: string): string {
  const url = parseAbsoluteUrlLite(input);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http/https ModArchive URLs are supported.');
  }
  const host = url.hostname.toLowerCase();
  if (!MODARCHIVE_HOSTS.has(host)) {
    throw new Error(`Only modarchive.org URLs are allowed, not ${url.hostname}.`);
  }

  // Already a direct .mod link from ModArchive. Keep it as-is, but the downloaded bytes
  // still have to pass the ProTracker MOD signature check.
  if (url.pathname.toLowerCase().endsWith('.mod')) return url.href;

  // Official direct download endpoint. This does not need an API key when the module id is known.
  const moduleId = resolveModArchiveModuleId(input);

  if (moduleId) {
    return `https://api.modarchive.org/downloads.php?moduleid=${moduleId}`;
  }

  throw new Error('Unsupported ModArchive URL. Use a module page URL or downloads.php?moduleid=12345.');
}

async function downloadModArchiveMod(sourceUrl: string, tempDir: string): Promise<ModArchiveDownload> {
  const moduleId = resolveModArchiveModuleId(sourceUrl);
  const meta: { sourcePageUrl?: string; artist?: string; license?: string } = moduleId ? await fetchModArchiveMeta(moduleId) : {};
  const downloadUrl = resolveModArchiveDownloadUrl(sourceUrl);
  const res = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'Ableton-MOD-Importer/4.5.14 (+single-user-url-import)',
      'Accept': 'application/octet-stream, audio/mod, */*',
    },
  });

  if (!res.ok) {
    throw new Error(`ModArchive download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const lengthHeader = res.headers.get('content-length');
  const maxBytes = 12 * 1024 * 1024;
  if (lengthHeader && Number(lengthHeader) > maxBytes) {
    throw new Error(`Download is too large for this MOD importer (${lengthHeader} bytes).`);
  }

  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxBytes) {
    throw new Error(`Download is too large for this MOD importer (${arrayBuffer.byteLength} bytes).`);
  }

  const buffer = Buffer.from(arrayBuffer);
  if (!isLikelyProTrackerMod(buffer)) {
    const filename = filenameFromContentDisposition(res.headers.get('content-disposition'))
      ?? path.basename(pathBaseNameFromUrlLike(res.url));
    const hint = filename ? ` Downloaded file: ${filename}.` : '';
    throw new Error(`Downloaded file is not a supported 4-channel ProTracker .mod.${hint}`);
  }

  const headerName = filenameFromContentDisposition(res.headers.get('content-disposition'));
  const urlName = path.basename(pathBaseNameFromUrlLike(res.url));
  let fileName = safeFileName(headerName || urlName || `modarchive_${Date.now()}.mod`);
  if (!fileName.toLowerCase().endsWith('.mod')) fileName += '.mod';

  const dir = path.join(tempDir, 'modarchive-downloads');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);

  return {
    buffer,
    filePath,
    fileName,
    sourceUrl: downloadUrl,
    sourcePageUrl: meta.sourcePageUrl,
    artist: meta.artist,
    license: meta.license,
  };
}

function errorDialogHtml(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <style>
    html{background:#383838;color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:11px;height:100%}
    body{margin:0;min-height:100%;display:flex;flex-direction:column;gap:7px;padding:10px;background:#383838;color:#FFFFFF}
    h2{font-size:13px;color:#FFFFFF;margin:0;font-weight:700}
    p{background:#4E4E4E;border:1px solid #2C2C2C;border-radius:2px;color:#FFFFFF;font-size:11px;line-height:1.45;padding:7px;white-space:pre-wrap;word-break:break-word}
    button{font:inherit;align-self:flex-end;margin-top:4px;background:#5a5a5a;color:#FFFFFF;border:1px solid #2C2C2C;height:26px;padding:0 16px;border-radius:20px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4),inset 0 1px rgba(255,255,255,.05)}
    button:hover{background:#676767}button:active{background:#424242;box-shadow:inset 0 1px 3px rgba(0,0,0,.5)}
    </style></head>
    <body><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>
    <button id="c">Close</button>
    <script>function close(){const m={method:"close_and_send",params:["err"]};
    if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)
      window.webkit.messageHandlers.live.postMessage(m);
    else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}
    document.getElementById("c").addEventListener("click",close);
    document.addEventListener("keydown",function(e){if(e.key==="Escape"||e.key==="Enter")close();});
    <\/script></body></html>`;
}

// Result dialog
function resultHtml(r: ImportReport): string {
  const sourceLabel = r.sourcePageUrl || r.sourceUrl || r.sourceLabel || 'Local file';
  const isModArchiveSource = /(^|\.)modarchive\.org\b/i.test(`${r.sourcePageUrl ?? ''} ${r.sourceUrl ?? ''}`);
  const composerText = r.sourceArtist || (r.possibleComposer ? `Possible internal text: ${r.possibleComposer}` : 'unknown / not found');
  const licenseText = r.sourceLicense || (isModArchiveSource
    ? 'Check the ModArchive module page before reuse'
    : 'Check the module text, source, or author before reuse');
  const licenseNote = isModArchiveSource
    ? 'ModArchive modules may still be copyrighted. Check the module page license before reuse outside private listening/import.'
    : 'Local modules may still be copyrighted. Check the module text/source and get permission before reuse or redistribution.';
  const effectLines = r.errors.length
    ? r.errors.slice(0, 4).map(escapeHtml).join('<br>')
    : 'No reported-only effects.';
  const internalTexts = (r.internalTexts ?? []).filter(Boolean).slice(0, 10);
  const internal = internalTexts.length
    ? `<details class="section"><summary>Internal texts</summary><div class="mono small-scroll">${internalTexts.map(escapeHtml).join('<br>')}</div></details>`
    : '';
  const sampleRows = (r.sampleInfo ?? []).slice(0, 6);
  const sampleInfo = sampleRows.length
    ? `<details class="section"><summary>Sample info</summary><div class="mono">${sampleRows.map(escapeHtml).join('<br>')}</div></details>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    *{box-sizing:border-box}html{background:#383838;color:#cfcfcf;font-family:Arial,Helvetica,sans-serif;font-size:11px;height:100%;overflow:hidden}
    body{margin:0;height:100%;display:flex;flex-direction:column;padding:10px;background:#383838;color:#cfcfcf;overflow:hidden;gap:6px}
    h1{font-size:13px;color:#d4d4d4;margin:0;font-weight:700;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 0 auto}
    .top{line-height:1.35;flex:0 0 auto;color:#cfcfcf}.top b{color:#d7d7d7}.content{min-height:0;flex:1 1 auto;overflow:auto;padding-right:3px;border-top:1px solid #252525;border-bottom:1px solid #252525}
    .section{border-bottom:1px solid #2b2b2b}.section:last-child{border-bottom:0}summary{list-style:none;cursor:pointer;font-weight:700;color:#a8a8a8;padding:6px 0 5px;outline:none}summary::-webkit-details-marker{display:none}summary:before{content:'›';display:inline-block;width:10px;color:#a8a8a8;transform:rotate(0deg);transition:transform .08s}details[open] summary:before{transform:rotate(90deg)}details>div{padding:0 0 6px 10px}.value{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#d0d0d0;line-height:1.35}.artist{color:#FFA500;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.license-note{font-size:10px;color:#bdbdbd;line-height:1.25;margin-top:4px}.mono{font-family:Arial,Helvetica,sans-serif;color:#d0d0d0;line-height:1.35;white-space:pre-wrap;word-break:break-word}.small-scroll{max-height:72px;overflow:auto}.effects{max-height:90px;overflow:auto;white-space:pre-wrap;word-break:break-word;color:#d0d0d0;line-height:1.35}
    button{font:inherit;align-self:flex-end;flex:0 0 auto;background:#242424;color:#d0d0d0;border:1px solid #202020;height:22px;padding:0 12px;border-radius:11px;cursor:pointer;box-shadow:none}button:hover{background:#2f2f2f}button:active{background:#1c1c1c}
    </style></head><body>
    <h1>"${escapeHtml(r.title)}" imported</h1>
    <div class="top"><b>Tracks</b> ${r.tracks} &nbsp; <b>Notes</b> ${r.totalNotes} &nbsp; <b>Length</b> ${r.totalBeats.toFixed(1)} beats</div>
    <div class="top"><b>Samples loaded</b> ${r.samplesLoaded}</div>
    <div class="content">
      <details class="section"><summary>Source</summary><div class="value">${escapeHtml(sourceLabel)}</div></details>
      <details class="section"><summary>Artist / composer</summary><div class="artist">${escapeHtml(composerText)}</div></details>
      <details class="section"><summary>License</summary><div class="value">${escapeHtml(licenseText)}</div><div class="license-note">${escapeHtml(licenseNote)}</div></details>
      ${sampleInfo}
      ${internal}
      <details class="section"><summary>Reported effects / notes</summary><div class="effects">${effectLines}</div></details>
    </div>
    <button id="c">Close</button>
    <script>function x(){const m={method:"close_and_send",params:["ok"]};
      if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live)window.webkit.messageHandlers.live.postMessage(m);
      else if(window.chrome&&window.chrome.webview)window.chrome.webview.postMessage(m);}
      document.getElementById("c").addEventListener("click",x);
      document.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key==="Escape")x();});
    <\/script></body></html>`;
}

function isEmptyRegularTrackForImportCleanup(track: any): boolean {
  try {
    // Only remove truly blank regular tracks: no arrangement clips, no session clips,
    // no devices. This avoids deleting prepared instrument/audio tracks that simply
    // do not contain clips yet. song.tracks excludes return/master tracks.
    if ((track.arrangementClips?.length ?? 0) > 0) return false;
    if ((track.devices?.length ?? 0) > 0) return false;
    const slots = track.clipSlots ?? [];
    for (const slot of slots) {
      if (slot?.clip) return false;
    }
    return true;
  } catch {
    return false;
  }
}


async function addLimiterToMainTrack(ctx: Ctx): Promise<string | null> {
  const mainTrack = ctx.application.song.mainTrack;
  const existingLimiter = mainTrack.devices.find(d => d.name.trim().toLowerCase() === 'limiter');
  if (existingLimiter) return 'Limiter already present on Main.';

  try {
    await mainTrack.insertDevice('Limiter', mainTrack.devices.length);
    return 'Added Limiter to Main.';
  } catch (error) {
    logWarn('Could not add Limiter to Main', error);
    return 'Could not add Limiter to Main. Add it manually if needed.';
  }
}

async function removeExistingEmptyTracks(song: any): Promise<number> {
  const tracks = Array.from(song.tracks ?? []);
  const emptyTracks = tracks.filter(isEmptyRegularTrackForImportCleanup);
  let removed = 0;
  for (const track of emptyTracks) {
    try {
      await song.deleteTrack(track);
      removed++;
    } catch {
      // Ignore tracks Live refuses to delete. Import should continue.
    }
  }
  return removed;
}

// ─── Main import ──────────────────────────────────────────────────────────────
async function importTrackerProject(mod: ModFile, options: ImportOptions, ctx: Ctx): Promise<ImportReport> {
  const report: ImportReport = {
    title: mod.title, tracks: 0, totalNotes: 0,
    samplesLoaded: 0, totalBeats: 0,
    firstSimplerParams: [], errors: [],
    sourceUrl: options.sourceUrl,
    sourcePageUrl: options.sourcePageUrl,
    sourceArtist: options.sourceArtist,
    sourceLicense: options.sourceLicense,
    sourceLabel: options.sourceLabel || (options.filePath ? `Local file: ${displayFileName(options.filePath)}` : undefined),
    internalTexts: mod.internalTexts ?? [],
    possibleComposer: possibleComposerFromInternalTexts(mod.internalTexts ?? []),
    sampleInfo: buildSampleInfo(mod, options.wavBitDepth === 16 ? 16 : 8, options.wavSampleRate),
    loopInfo: buildLoopInfo(mod),
  };

  const song    = ctx.application.song;
  const tempDir = ctx.environment.tempDirectory ?? '/tmp';

  song.tempo = mod.initialTempo;

  // Compact Simpler layout: one Ableton track per unique MOD sample.
  // This avoids repeated Simpler tracks when the same sample is used on several MOD channels.
  // Parallel uses are represented as overlapping polyphonic notes in the same MIDI clip.
  const drumSamples = new Set<number>();

  const { parts, drumRackParts, totalBeats, cuePoints, effects, unsupportedEffects, playbackWarnings } = buildNativeNotesByChannelAndSample(mod, drumSamples);
  report.totalBeats = totalBeats;
  report.songInfo = buildSongInfo(mod, cuePoints);
  report.playbackWarnings = playbackWarnings;
  if (playbackWarnings.length > 0) {
    report.errors.push(`Playback structure notes:\n${playbackWarnings.join("\n")}`);
  }
  if (effects?.approximated?.size > 0) {
    const top = groupedEffectSummary(effects.approximated);
    report.errors.push(`Approximated effects:\n${top}`);
  }
  if (unsupportedEffects.size > 0) {
    const top = groupedEffectSummary(unsupportedEffects);
    report.errors.push(`Reported-only effects requiring pitchbend/automation/audio rendering or manual interpretation:\n${top}`);
  }

  const sampleByIndex = new Map(mod.samples.map(s => [s.index, s]));

  // Keep generated MIDI tracks deterministic and compact:
  // - remove any note-less parts before creating tracks
  // - keep only parts with a valid MOD sample
  // - sort by MOD sample number (01, 02, 03, ...) instead of discovery order
  const activeMelodicParts = parts
    .filter(p => p.notes.length > 0 && sampleByIndex.has(p.key.sample))
    .sort((a, b) => (a.key.sample - b.key.sample) || ((a.key.channel ?? 0) - (b.key.channel ?? 0)) || ((a.key.offsetParam ?? 0) - (b.key.offsetParam ?? 0)));

  await ctx.ui.withinProgressDialog(
    `Importing "${mod.title}"…`,
    { progress: 5 },
    async (update: (msg: string, progress: number) => Promise<void>, signal: AbortSignal) => {

      // Empty regular-track cleanup intentionally runs after successful MOD track
      // creation, not before. Ableton Live may refuse to delete the last regular
      // track in a set; creating the MOD tracks first avoids a temporary zero-track
      // state and lets the default empty Audio/MIDI track be removed afterwards.

      // Step 1: Extract WAVs to temp dir
      await update("Extracting samples…", 10);
      const wavMap = new Map<number, string>();
      if (options.extractSamples) {
        const dir = path.join(tempDir, `mod-${Date.now()}`);
        fs.mkdirSync(dir, { recursive: true });
        for (const s of mod.samples) {
          if (s.length < 4) continue;
          const safeName = s.name.replace(/[^a-zA-Z0-9_\-]/g, '_') || `sample_${s.index}`;
          const wavPath  = path.join(dir, `${String(s.index).padStart(2,'0')}_${safeName}.wav`);
          writeSampleWav(s.data, wavPath, { sampleRate: s.sampleRate, outputSampleRate: options.wavSampleRate, loopStart: s.loopStart, loopLength: s.loopLength, looped: s.looped, loopType: s.loopType, pcmBits: s.pcmBits, outputBits: options.wavBitDepth === 16 ? 16 : 8 });
          try {
            const imported = await ctx.resources.importIntoProject(wavPath);
            wavMap.set(s.index, imported);
          } catch (e) {
            report.errors.push(`Sample ${s.index}: ${e}`);
          }
        }
      }

      if (signal.aborted) return;
      await update("Creating tracks…", 25);

      // Step 2: Create one MIDI track per non-empty sample part, plus one per drum rack part.
      // Parts are already sorted by sample number, so the created tracks appear
      // as 01, 02, 03... in Ableton instead of in parser discovery order.
      const trackCount = activeMelodicParts.length + drumRackParts.length;
      const newTracks = trackCount > 0
        ? await ctx.withinTransaction(() =>
            Promise.all(Array.from({ length: trackCount }, () => song.createMidiTrack()))
          )
        : [];

      const melodicTracks = newTracks.slice(0, activeMelodicParts.length);
      const drumRackTracks = newTracks.slice(activeMelodicParts.length);

      // Step 3: Name tracks
      ctx.withinTransaction(() => {
        activeMelodicParts.forEach((part, i) => {
          const sample = sampleByIndex.get(part.key.sample)!;
          const name = sample.name.replace(/^st-\d+:/i, '').replace(/\x00/g, '').trim()
            || `Sample ${sample.index}`;
          const channelLabel = part.key.channel && part.key.channel > 0 ? ` · Ch ${part.key.channel}` : '';
          melodicTracks[i]!.name = `${String(sample.index).padStart(2, "0")} · ${name}${channelLabel}${offsetLabelFrom9xx(part.key.offsetParam)}`;
        });
        drumRackParts.forEach((drp, i) => {
          const sample = sampleByIndex.get(drp.sampleIndex)!;
          if (!sample) return;
          const name = sample.name.replace(/^st-\d+:/i, '').replace(/\x00/g, '').trim()
            || `Sample ${sample.index}`;
          drumRackTracks[i]!.name = `${String(sample.index).padStart(2, "0")} · ${name} [9xx]`;
        });
      });

      if (signal.aborted) return;
      await update("Loading samples into Simpler…", 40);

      // Step 4: Insert devices + load samples (async, sequential)
      const simplerMap: { sampleIndex: number; channel?: number; offsetParam?: number; simpler: Simpler<"1.0.0"> }[] = [];

      for (let i = 0; i < activeMelodicParts.length; i++) {
        const part = activeMelodicParts[i]!;
        const sample = sampleByIndex.get(part.key.sample)!;
        const track  = melodicTracks[i]!;
        if (!options.extractSamples) continue;

        await track.insertDevice("Simpler", 0);
        const simpler = findSimpler(track.devices);
        const wavPath = wavMap.get(sample.index);
        if (simpler && wavPath) {
          await simpler.replaceSample(wavPath);
          simplerMap.push({ sampleIndex: sample.index, channel: part.key.channel ?? 0, offsetParam: part.key.offsetParam ?? 0, simpler });
          report.samplesLoaded++;
          if (report.firstSimplerParams.length === 0) {
            report.firstSimplerParams = simpler.parameters.map(
              (p: { name: string; min: number; max: number; defaultValue: number }) =>
                `${p.name} [${p.min}…${p.max}] def=${p.defaultValue}`
            );
          }
        }
      }

      if (signal.aborted) return;
      await update("Configuring Simpler parameters…", 60);

      // Step 5: Configure all Simpler parameters (portamento, vibrato, loop etc.)
      for (const { sampleIndex, simpler, channel, offsetParam } of simplerMap) {
        const sample = mod.samples.find(s => s.index === sampleIndex);
        if (!sample) continue;
        const matchingPart = activeMelodicParts.find(part =>
          part.key.sample === sampleIndex
          && (part.key.channel ?? 0) === (channel ?? 0)
          && (part.key.offsetParam ?? 0) === (offsetParam ?? 0)
        );
        const voices = Math.max(1, Math.ceil(matchingPart?.voices ?? 1));
        const sampleStartOffset = sampleOffsetFramesFrom9xx(sample, offsetParam);
        await configureSimplerParams(ctx, simpler, sample, mod, 0, sampleStartOffset, false, voices);
      }

      if (signal.aborted) return;
      await update("Building Drum Rack tracks (9xx offsets)…", 68);

      // Step 5b: Build Drum Rack tracks for samples that use 9xx at single pitches.
      // Each unique offset → one pad with S Start set and receivingNote assigned.
      for (let i = 0; i < drumRackParts.length; i++) {
        if (signal.aborted) return;
        const drp = drumRackParts[i]!;
        const track = drumRackTracks[i];
        const sample = sampleByIndex.get(drp.sampleIndex);
        const wavPath = wavMap.get(drp.sampleIndex);
        if (!track || !sample || !wavPath || !options.extractSamples) continue;

        const { samplesLoaded: sl, totalNotes: tn } = await buildDrumRackTrack(
          ctx, drp, track, wavPath, sample, mod, totalBeats,
        );
        report.samplesLoaded += sl;
        report.totalNotes   += tn;
        if (sl > 0) report.tracks++;
      }

      if (signal.aborted) return;
      await update("Writing MIDI notes…", 75);

      // Step 6: Create clips
      const clips = await ctx.withinTransaction(() =>
        Promise.all(melodicTracks.map((t: any) => t.createMidiClip(0, totalBeats)))
      );

      // Step 7: Write clip names + notes. Empty parts were filtered before track
      // creation, but keep this defensive so a malformed parse result cannot leave
      // generated empty clips/tracks behind.
      const emptyGeneratedTracks: any[] = [];
      ctx.withinTransaction(() => {
        for (let i = 0; i < activeMelodicParts.length; i++) {
          const part = activeMelodicParts[i]!;
          const sample = sampleByIndex.get(part.key.sample)!;
          const clip = clips[i];
          const track = melodicTracks[i];
          const cleanName = sample.name.replace(/^st-\d+:/i, '').replace(/\x00/g, '').trim()
            || `Sample ${sample.index}`;
          const channelLabel = part.key.channel && part.key.channel > 0 ? ` · Ch ${part.key.channel}` : '';
          clip.name  = `${String(sample.index).padStart(2, "0")} · ${cleanName}${channelLabel}${offsetLabelFrom9xx(part.key.offsetParam)}`;
          if (part.notes.length > 0) {
            clip.notes = part.notes;
            report.tracks++;
            report.totalNotes += clip.notes.length;
          } else if (track) {
            emptyGeneratedTracks.push(track);
          }
        }
      });

      // Step 7b: Remove any generated track that still ended up empty. In normal
      // operation this list is empty because empty parts are skipped before track
      // creation, but this prevents empty MIDI/audio leftovers after edge cases.
      if (emptyGeneratedTracks.length > 0) {
        await update("Removing empty generated tracks…", 82);
        for (const track of emptyGeneratedTracks) {
          try { await song.deleteTrack(track); } catch { /* ignore cleanup errors */ }
        }
      }

      // Step 7c: Optionally clean truly blank pre-existing tracks after the import
      // succeeded. This also removes Live's final default empty Audio track, because
      // new MOD tracks now exist and the set no longer enters a zero-track state.
      if (options.removeEmptyTracks !== false && report.tracks > 0) {
        await update("Removing empty tracks…", 86);
        const removed = await removeExistingEmptyTracks(song);
        if (removed > 0) {
          report.errors.push(`Removed ${removed} empty pre-existing track${removed === 1 ? "" : "s"}.`);
        }
      }

      if (signal.aborted) return;

      if (options.addLimiterToMain) {
        await update("Adding Limiter to Main…", 88);
        const limiterMessage = await addLimiterToMainTrack(ctx);
        if (limiterMessage) report.errors.push(limiterMessage);
      }

      if (signal.aborted) return;

      // Step 8: Arrangement locators / cue points. This is optional because
      // song.createCuePoint can be slow or unstable in the current beta SDK on
      // MODs with many pattern/order boundaries. Keep it off by default.
      if (options.cuePoints) {
        const maxCuePoints = 64;
        const selectedCuePoints = cuePoints.slice(0, maxCuePoints);
        await update(`Adding arrangement locators (${selectedCuePoints.length})…`, 90);
        for (const cp of selectedCuePoints) {
          if (signal.aborted) return;
          try {
            const cue = await song.createCuePoint(cp.beat);
            cue.name  = `Ord ${cp.order} · Pat ${cp.pattern}`;
          } catch { /* ignore */ }
        }
        if (cuePoints.length > maxCuePoints) {
          report.errors.push(`Skipped ${cuePoints.length - maxCuePoints} extra arrangement locator${cuePoints.length - maxCuePoints === 1 ? "" : "s"} to avoid slow SDK cue-point creation.`);
        }
      }

      await update(`Done! ${report.tracks} tracks, ${report.totalNotes} notes`, 100);
    }
  );

  return report;
}

// ─── activate ─────────────────────────────────────────────────────────────────
export function activate(activation: ActivationContext) {
  const ctx = initialize(activation, "1.0.0");
  logInfo('Extension activated');

  ctx.commands.registerCommand("tracker.import", () => {
    void (async () => {
      const storageDir = ctx.environment.storageDirectory ?? ctx.environment.tempDirectory ?? "/tmp";
      // Ensure extension storage exists for config and downloaded ModArchive files.
      try { fs.mkdirSync(storageDir, { recursive: true }); } catch {}

      const configPath = path.join(storageDir, 'config.json');
      const config = readUserConfig(configPath);
      let localFolderInput = config.localFolder || '';

      // Loop to handle reload requests. Empty localFolderInput means: use the
      // Ableton extension data folder internally. The actual user path is never
      // injected into the UI as a default value.
      let options: ImportOptions | null = null;
      while (true) {
        const scanFolder = normalizeUserFolder(localFolderInput, storageDir);
        const scan = scanModFolder(scanFolder);

        const dialogWithData = dialogHtml
          .replace(/__FOLDER_STATUS__/g, escapeHtml(scan.status))
          .replace(/__LOCAL_FOLDER_VALUE__/g, escapeHtmlAttr(localFolderInput))
          .replace('__MOD_FILES__', JSON.stringify(scan.files));

        const raw = await ctx.ui.showModalDialog(
          `data:text/html,${encodeURIComponent(dialogWithData)}`, 760, 600,
        );

        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { return; }
        if (!parsed) return;

        // Handle reload — rescan the selected folder. Empty value means
        // the Ableton extension data folder.
        if (parsed.action === 'refresh') {
          localFolderInput = typeof parsed.localFolder === 'string' ? parsed.localFolder.trim() : '';
          writeUserConfig(configPath, { localFolder: localFolderInput });
          continue;
        }

        options = parsed as ImportOptions;
        if (typeof options.localFolder === 'string') {
          localFolderInput = options.localFolder.trim();
          writeUserConfig(configPath, { localFolder: localFolderInput });
        }
        if (!options.sourceUrl && options.filePath) {
          options.sourceLabel = `Local file: ${displayFileName(options.filePath)}`;
          options.sourceArtist = 'unknown / not found';
          options.sourceLicense = 'Check the module comments/source before reuse';
        }
        break;
      }
      if (!options) return;

      // Read local .mod file or download one explicitly requested ModArchive URL.
      let modBuffer: Buffer | null = null;
      try {
        await ctx.ui.withinProgressDialog(
          options.sourceUrl ? "Downloading MOD from ModArchive…" : "Preparing MOD import…",
          { progress: 2 },
          async (update: (msg: string, progress: number) => Promise<void>, signal: AbortSignal) => {
            let loadedBuffer: Buffer;
            if (options.sourceUrl) {
              await update("Resolving ModArchive URL…", 8);
              if (signal.aborted) return;
              await update("Downloading and checking .mod file…", 18);
              const downloaded = await downloadModArchiveMod(options.sourceUrl, ctx.environment.tempDirectory ?? storageDir);
              if (signal.aborted) return;
              loadedBuffer = downloaded.buffer;
              options.filePath = downloaded.filePath;
              options.sourceUrl = downloaded.sourceUrl;
              options.sourcePageUrl = downloaded.sourcePageUrl;
              options.sourceArtist = downloaded.artist;
              options.sourceLicense = downloaded.license;
              await update("Parsing MOD patterns…", 82);
            } else {
              await update("Reading local .mod file…", 15);
              const ext = extOf(options.filePath);
              if (ext !== ".mod") {
                throw new Error(`This build imports .mod files only. Selected file has extension: ${ext || "none"}.`);
              }
              loadedBuffer = fs.readFileSync(options.filePath);
              if (signal.aborted) return;
              await update("Checking MOD signature…", 50);
              if (!isLikelyProTrackerMod(loadedBuffer)) {
                throw new Error('Selected file is not a supported 4-channel ProTracker .mod.');
              }
              await update("Parsing MOD patterns…", 82);
            }
            modBuffer = loadedBuffer;
            await update("Opening import progress…", 100);
          }
        );
      } catch (e) {
        logError('Import preparation failed', e);
        const message = options.sourceUrl
          ? `URL: ${options.sourceUrl}

${String(e)}`
          : `File: ${displayFileName(options.filePath)}

${String(e)}

Put .mod files into the extension data folder, press Reload, then choose a .mod file.`;
        await ctx.ui.showModalDialog(
          "data:text/html," + encodeURIComponent(errorDialogHtml('Cannot import MOD', message)), 430, 300,
        );
        return;
      }
      if (!modBuffer) return;
      const mod: ModFile = parseMod(modBuffer);
      const report = await importTrackerProject(mod, options, ctx);

      await ctx.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(resultHtml(report))}`, 520, 420,
      );
    })().catch(async e => {
      logError('Unhandled extension error', e);
      try {
        await ctx.ui.showModalDialog(
          "data:text/html," + encodeURIComponent(errorDialogHtml('MOD Importer error', String(e))), 430, 260,
        );
      } catch (dialogError) {
        logError('Could not show error dialog', dialogError);
      }
    });
  });

  ctx.ui.registerContextMenuAction("MidiTrack",  "Import MOD file…", "tracker.import");
  ctx.ui.registerContextMenuAction("AudioTrack", "Import MOD file…", "tracker.import");
}
