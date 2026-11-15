import type { AudioLevels } from './highway';
import { t } from '../core/i18n';
import type { GameClock } from './youtube-clock';

/**
 * Song master clock, based on an <audio> (synthesized MP3 from Songsterr).
 *
 * - `mediaAt(perf)` gives the media position (ms) for a performance.now() instant.
 * - Interpolates between currentTime readings and corrects drift smoothly.
 * - If the media stalls (buffering), the clock stops with it.
 * - Sound goes straight from the <audio> to the output (no Web Audio, which added delay on Windows).
 *   The scenery reacts to an analysis done before playing (AudioAnalysis).
 */
export class MediaClock implements GameClock {
  readonly el: HTMLAudioElement;
  private anchorPerf = 0;
  private anchorMedia = 0;
  private running = false;
  private _rate = 1;
  onEnded?: () => void;

  constructor(src: string, private offsetMs = 0) {
    const el = new Audio();
    el.preload = 'auto';
    el.src = src;
    el.preservesPitch = true;
    el.addEventListener('playing', () => { this.running = true; this.reanchor(); });
    el.addEventListener('waiting', () => { this.running = false; this.reanchor(); });
    el.addEventListener('pause', () => { this.running = false; this.reanchor(); });
    el.addEventListener('seeked', () => this.reanchor());
    el.addEventListener('ended', () => { this.running = false; this.onEnded?.(); });
    this.el = el;
  }

  get playing(): boolean { return this.running; }
  get paused(): boolean { return this.el.paused; }
  get rate(): number { return this._rate; }
  get durationMs(): number { return (this.el.duration || 0) * 1000 - this.offsetMs; }

  set rate(r: number) {
    this.reanchor();
    this._rate = r;
    this.el.playbackRate = r;
    this.el.preservesPitch = true;
  }

  async load(): Promise<void> {
    if (this.el.readyState >= 3) return;
    await new Promise<void>((resolve, reject) => {
      this.el.addEventListener('canplaythrough', () => resolve(), { once: true });
      this.el.addEventListener('error', () => reject(new Error(t('err.audioLoad'))), { once: true });
      this.el.load();
    });
  }

  play(): Promise<void> { return this.el.play(); }

  /** Lows, mids, highs and spectrum (0–1) of what is playing now. */
  levels(out: AudioLevels): AudioLevels {
    out.bass = out.mid = out.high = 0;
    out.spectrum.fill(0);
    return out;
  }

  pause(): void { this.el.pause(); }

  /** Jumps to a chart instant (ms). */
  seek(chartMs: number): void {
    this.el.currentTime = Math.max(0, (chartMs + this.offsetMs) / 1000);
    this.anchorMedia = chartMs;
    this.anchorPerf = performance.now();
  }

  /** Chart position (ms) at a performance.now() instant. */
  mediaAt(perf: number): number {
    // stopped (pause, waiting for sound to start, loading after a jump): time doesn't move, but looking
    // into the past (smaller perf, as the audio/video delay does) keeps subtracting — no jump on resume
    if (!this.running) return this.anchorMedia + Math.min(0, perf - this.anchorPerf) * this._rate;
    return this.anchorMedia + (perf - this.anchorPerf) * this._rate;
  }

  /** Call every frame: aligns the interpolation with the real currentTime. */
  tick(perf = performance.now()): void {
    const measured = this.el.currentTime * 1000 - this.offsetMs;
    if (!this.running) {
      this.anchorMedia = measured;
      this.anchorPerf = perf;
      return;
    }
    const err = measured - this.mediaAt(perf);
    if (Math.abs(err) > 60) this.reanchor(perf);
    else this.anchorMedia += err * 0.04;
  }

  dispose(): void {
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
  }

  private reanchor(perf = performance.now()): void {
    this.anchorMedia = this.el.currentTime * 1000 - this.offsetMs;
    this.anchorPerf = perf;
  }
}
