import { AnalysisData, AudioAnalysis } from './audio-analysis';
import { t } from '../core/i18n';

/**
 * "Synthetic" audio generated in the app itself: the song's MIDI (the same file the chart comes from)
 * is played by alphaTab's synthesizer with a General MIDI SoundFont. No MP3: the sync with
 * the notes is exact, because the timing comes from the same file.
 *
 * The sound is generated ONCE per song (a few seconds) and stored in the browser (IndexedDB);
 * next times it opens instantly. The result becomes a WAV played by the usual MediaClock.
 *
 * Designed to run the same in the packaged app (exe/apk, WebView): it receives the MIDI BYTES (not a
 * server address), uses only browser APIs (IndexedDB, Blob, fetch of the SoundFont shipped
 * with the app files) and doesn't depend on any server.
 */

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const SOUNDFONT_URL = 'soundfont/sonivox.sf2';
/** Change it when switching the SoundFont or the generation method, so old cached audio isn't reused. */
const RENDER_VERSION = 1;
const CACHE_MAX_SONGS = 8;

export interface SynthAudio {
  url: string;              // WAV object URL (revoke with URL.revokeObjectURL when leaving)
  analysis: AudioAnalysis;
  fromCache: boolean;
}

interface CacheEntry {
  key: string;
  songId: string;
  wav: Blob;
  analysis: AnalysisData;
  used: number;
}

/** Generates (or takes from the cache) the synthetic audio from the MIDI. `onProgress` gets 0–1. */
export async function renderSynth(songId: string, midiBytes: Uint8Array, onProgress?: (p: number) => void): Promise<SynthAudio> {
  const key = `${songId}|${fnv1a(midiBytes)}|${midiBytes.length}|v${RENDER_VERSION}`;
  const cached = await cacheGet(key).catch(() => undefined);
  if (cached) {
    void cachePut({ ...cached, used: Date.now() }).catch(() => {});
    return { url: URL.createObjectURL(cached.wav), analysis: AudioAnalysis.fromData(cached.analysis), fromCache: true };
  }

  const at = await import('@coderline/alphatab');
  const soundFont = await loadSoundFont();
  const midi = toAlphaTabMidi(at, midiBytes);
  const synth = new at.synth.AlphaSynth(silentOutput(), 500);
  const opts = new at.synth.AudioExportOptions();
  opts.soundFonts = [soundFont];
  opts.sampleRate = SAMPLE_RATE;
  const exporter = synth.exportAudio(opts, midi, [], new Map());

  // interleaved 16-bit PCM, growing as it is generated (doesn't keep the whole float in memory)
  let pcm = new Int16Array(0);
  let used = 0;
  let lastYield = performance.now();
  for (let chunk = exporter.render(1000); chunk; chunk = exporter.render(1000)) {
    const s = chunk.samples;
    if (!pcm.length) pcm = new Int16Array(Math.ceil((chunk.endTime / 1000 + 6) * SAMPLE_RATE) * CHANNELS);
    if (used + s.length > pcm.length) {
      const bigger = new Int16Array(Math.ceil((used + s.length) * 1.25));
      bigger.set(pcm.subarray(0, used));
      pcm = bigger;
    }
    for (let i = 0; i < s.length; i++) {
      const v = Math.max(-1, Math.min(1, s[i]));
      pcm[used + i] = v < 0 ? v * 32768 : v * 32767;
    }
    used += s.length;
    onProgress?.(Math.min(1, chunk.currentTime / Math.max(1, chunk.endTime)));
    // yields to the screen every ~30 ms (the progress bar moves and nothing freezes)
    if (performance.now() - lastYield > 30) {
      await new Promise(r => setTimeout(r));
      lastYield = performance.now();
    }
  }
  pcm = pcm.subarray(0, trimSilence(pcm, used));
  const analysis = AudioAnalysis.fromPcm16(pcm, CHANNELS, SAMPLE_RATE);
  const wav = wavBlob(pcm, CHANNELS, SAMPLE_RATE);
  void cachePut({ key, songId, wav, analysis: analysis.toData(), used: Date.now() }).then(pruneCache).catch(() => {});
  return { url: URL.createObjectURL(wav), analysis, fromCache: false };
}

/** Converts a Standard MIDI File (type 0 or 1) into alphaTab events. */
export function toAlphaTabMidi(at: typeof import('@coderline/alphatab'), data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  if (tag(0) !== 'MThd') throw new Error(t('err.invalidMidi'));
  const headerLen = dv.getUint32(4);
  const tracks = dv.getUint16(10);
  const division = dv.getUint16(12);
  if (division & 0x8000) throw new Error(t('err.smpte'));
  const out = new at.midi.MidiFile();
  out.division = division;
  let pos = 8 + headerLen;
  for (let t = 0; t < tracks && pos + 8 <= data.length; t++) {
    if (tag(pos) !== 'MTrk') break;
    const len = dv.getUint32(pos + 4);
    let i = pos + 8;
    const end = Math.min(data.length, i + len);
    pos = end;
    let tick = 0, status = 0;
    const vlq = () => {
      let v = 0, b = 0;
      do { b = data[i++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && i < end);
      return v;
    };
    while (i < end) {
      tick += vlq();
      const b = data[i];
      if (b === 0xff) {                       // meta
        const type = data[i + 1];
        i += 2;
        const l = vlq();
        if (type === 0x51 && l === 3) out.addEvent(new at.midi.TempoChangeEvent(tick, (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]));
        i += l;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {         // sysex
        i++;
        i += vlq();
        continue;
      }
      if (b & 0x80) { status = b; i++; }      // otherwise: running status
      const kind = status & 0xf0, ch = status & 0x0f;
      if (kind === 0xc0 || kind === 0xd0) {
        if (kind === 0xc0) out.addEvent(new at.midi.ProgramChangeEvent(t, tick, ch, data[i]));
        i += 1;
        continue;
      }
      const a = data[i], c = data[i + 1];
      i += 2;
      if (kind === 0x90 && c > 0) out.addEvent(new at.midi.NoteOnEvent(t, tick, ch, a, c));
      else if (kind === 0x80 || kind === 0x90) out.addEvent(new at.midi.NoteOffEvent(t, tick, ch, a, c));
      else if (kind === 0xb0) out.addEvent(new at.midi.ControlChangeEvent(t, tick, ch, a, c));
      else if (kind === 0xe0) out.addEvent(new at.midi.PitchBendEvent(t, tick, ch, (c << 7) | a));
    }
  }
  return out;
}

let soundFontBytes: Promise<Uint8Array> | undefined;
function loadSoundFont(): Promise<Uint8Array> {
  soundFontBytes ??= fetch(SOUNDFONT_URL)
    .then(r => {
      if (!r.ok) throw new Error(t('err.soundfont'));
      return r.arrayBuffer();
    })
    .then(b => new Uint8Array(b))
    .catch(e => { soundFontBytes = undefined; throw e; });
  return soundFontBytes;
}

/** Audio output that plays nothing: the synthesizer is only used to generate the file. */
function silentOutput() {
  const ev = { on() {}, off() {} };
  return {
    sampleRate: SAMPLE_RATE,
    open() {}, play() {}, destroy() {}, pause() {}, addSamples() {}, resetSamples() {}, activate() {},
    ready: ev, samplesPlayed: ev, sampleRequest: ev,
    enumerateOutputDevices: async () => [],
    setOutputDevice: async () => {},
    getOutputDevice: async () => null,
  } as never;
}

/** Trims the silence at the end (reverb tail), keeping 1 s. */
function trimSilence(pcm: Int16Array, used: number): number {
  let i = used - 1;
  while (i > 0 && Math.abs(pcm[i]) < 8) i--;
  return Math.min(used, (Math.floor(i / CHANNELS) + 1 + SAMPLE_RATE) * CHANNELS);
}

function wavBlob(pcm: Int16Array, channels: number, rate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const bytes = pcm.length * 2;
  const str = (o: number, t: string) => { for (let i = 0; i < 4; i++) header.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); header.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, channels, true);
  header.setUint32(24, rate, true); header.setUint32(28, rate * channels * 2, true);
  header.setUint16(32, channels * 2, true); header.setUint16(34, 16, true);
  str(36, 'data'); header.setUint32(40, bytes, true);
  return new Blob([header.buffer, pcm.slice().buffer], { type: 'audio/wav' });
}

function fnv1a(data: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) { h ^= data[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

// ------------------------------------------------------------------ IndexedDB cache

const DB = 'drumhero-synth';
const STORE = 'audio';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function cacheGet(key: string): Promise<CacheEntry | undefined> {
  return tx('readonly', s => s.get(key) as IDBRequest<CacheEntry | undefined>);
}

function cachePut(e: CacheEntry): Promise<IDBValidKey> {
  return tx('readwrite', s => s.put(e));
}

/** Keeps only the most recently used songs (each takes tens of MB). */
async function pruneCache(): Promise<void> {
  const all = await tx('readonly', s => s.getAll() as IDBRequest<CacheEntry[]>);
  all.sort((a, b) => b.used - a.used);
  const seen = new Set<string>();
  for (const e of all) {
    // one version per song; and at most CACHE_MAX_SONGS songs
    if (seen.has(e.songId) || seen.size >= CACHE_MAX_SONGS) await tx('readwrite', s => s.delete(e.key));
    else seen.add(e.songId);
  }
}
