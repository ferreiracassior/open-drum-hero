import type { AudioLevels } from './highway';

const HOP = 1024;        // ~23 ms per frame at 44.1 kHz
const N = 1024;          // FFT size
const BANDS = 48;

/**
 * Audio analysis done ONCE, before playing: lows/mids/highs and spectrum every ~23 ms.
 * The scenery queries it by chart time, so it stays in sync without touching the sound path
 * (routing the <audio> through Web Audio added delay on Windows).
 */
export interface AnalysisData { frames: number; secondsPerFrame: number; bands: Uint8Array; bmh: Uint8Array; }

export class AudioAnalysis {
  private constructor(
    private frames: number,
    private secondsPerFrame: number,
    private bands: Uint8Array,     // frames × BANDS
    private bmh: Uint8Array,       // frames × 3 (lows, mids, highs)
    private offsetMs: number,
  ) {}

  static async fromUrl(url: string, offsetMs = 0): Promise<AudioAnalysis> {
    const buf = await (await fetch(url)).arrayBuffer();
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const audio = await ctx.decodeAudioData(buf);
    return AudioAnalysis.fromBuffer(audio, offsetMs);
  }

  static fromBuffer(audio: AudioBuffer, offsetMs = 0): AudioAnalysis {
    const len = audio.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / audio.numberOfChannels;
    }
    return AudioAnalysis.fromSampler(len, audio.sampleRate, i => mono[i], offsetMs);
  }

  /** From interleaved 16-bit PCM (the synthesized audio), without copying everything to float. */
  static fromPcm16(pcm: Int16Array, channels: number, sampleRate: number, offsetMs = 0): AudioAnalysis {
    const len = Math.floor(pcm.length / channels);
    const k = 1 / (32768 * channels);
    return AudioAnalysis.fromSampler(len, sampleRate, i => {
      let v = 0;
      for (let c = 0; c < channels; c++) v += pcm[i * channels + c];
      return v * k;
    }, offsetMs);
  }

  /** Data to cache (IndexedDB) and recreate later with `fromData`. */
  toData(): AnalysisData {
    return { frames: this.frames, secondsPerFrame: this.secondsPerFrame, bands: this.bands, bmh: this.bmh };
  }

  static fromData(d: AnalysisData, offsetMs = 0): AudioAnalysis {
    return new AudioAnalysis(d.frames, d.secondsPerFrame, d.bands, d.bmh, offsetMs);
  }

  private static fromSampler(len: number, sr: number, sample: (i: number) => number, offsetMs: number): AudioAnalysis {
    const frames = Math.max(1, Math.floor((len - N) / HOP));
    const binHz = sr / N;
    const window = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
    const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
    const rawBands = new Float32Array(frames * BANDS);
    const rawBmh = new Float32Array(frames * 3);
    const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.max(1, Math.round((40 * Math.pow(12000 / 40, i / BANDS)) / binHz)));
    const range = (from: number, to: number) => {
      let s = 0;
      for (let k = from; k < to; k++) s += mag[k];
      return s / Math.max(1, to - from);
    };
    const bin = (hz: number) => Math.max(1, Math.round(hz / binHz));
    for (let f = 0; f < frames; f++) {
      const o = f * HOP;
      for (let i = 0; i < N; i++) { re[i] = sample(o + i) * window[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k < N / 2; k++) mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      for (let b = 0; b < BANDS; b++) rawBands[f * BANDS + b] = range(edges[b], Math.max(edges[b] + 1, edges[b + 1])) * (1 + b / BANDS);
      rawBmh[f * 3] = range(bin(40), bin(160));
      rawBmh[f * 3 + 1] = range(bin(250), bin(2500));
      rawBmh[f * 3 + 2] = range(bin(4000), bin(12000)) * 2;
    }
    return new AudioAnalysis(frames, HOP / sr, normalize(rawBands, BANDS), normalize(rawBmh, 3), offsetMs);
  }

  /** Levels at chart instant `chartMs`. */
  at(chartMs: number, out: AudioLevels): AudioLevels {
    const f = Math.floor((chartMs + this.offsetMs) / 1000 / this.secondsPerFrame);
    if (f < 0 || f >= this.frames) {
      out.bass = out.mid = out.high = 0;
      out.spectrum.fill(0);
      return out;
    }
    out.bass = this.bmh[f * 3] / 255;
    out.mid = this.bmh[f * 3 + 1] / 255;
    out.high = this.bmh[f * 3 + 2] / 255;
    const n = Math.min(out.spectrum.length, BANDS);
    for (let b = 0; b < n; b++) out.spectrum[b] = this.bands[f * BANDS + b] / 255;
    return out;
  }
}

/** Normalizes each column by the 98th percentile (rare peaks don't flatten the rest). */
function normalize(raw: Float32Array, cols: number): Uint8Array {
  const rows = raw.length / cols;
  const out = new Uint8Array(raw.length);
  for (let c = 0; c < cols; c++) {
    const col = new Float32Array(rows);
    for (let r = 0; r < rows; r++) col[r] = raw[r * cols + c];
    const sorted = Float32Array.from(col).sort();
    const top = sorted[Math.floor(rows * 0.98)] || 1;
    const floor = sorted[Math.floor(rows * 0.2)] || 0;
    for (let r = 0; r < rows; r++) {
      const v = (col[r] - floor) / Math.max(1e-9, top - floor);
      out[r * cols + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
    }
  }
  return out;
}

const COS = new Float32Array(N / 2).map((_, k) => Math.cos((-2 * Math.PI * k) / N));
const SIN = new Float32Array(N / 2).map((_, k) => Math.sin((-2 * Math.PI * k) / N));

/** FFT radix-2 in-place (tamanho N). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, stride = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * stride], wi = SIN[k * stride];
        const a = i + k, b = a + half;
        const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}
