import { YoutubeSource } from '../core/protocol';
import type { AudioLevels } from './highway';
import { t } from '../core/i18n';

/** What the game needs from any audio source (synthesized MP3 or YouTube video). */
export interface GameClock {
  readonly playing: boolean;
  readonly paused: boolean;
  rate: number;
  /**
   * Gets the source ready to start at `chartMs` without a loading delay (e.g. during the countdown). The clock
   * stays paused at that point; play() then only resumes.
   */
  prime?(chartMs: number): void;
  /** Speeds this source can play (null = any). */
  availableRates?(): number[] | null;
  onEnded?: () => void;
  /** The source stopped working for good (e.g. video blocked on YouTube) — the game pauses and switches source. */
  onFailure?: (message: string) => void;
  load(): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  seek(chartMs: number): void;
  mediaAt(perf: number): number;
  tick(perf?: number): void;
  levels(out: AudioLevels): AudioLevels;
  dispose(): void;
}

interface YtPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlaybackRate(): number;
  setPlaybackRate(r: number): void;
  getAvailablePlaybackRates(): number[];
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  destroy(): void;
}

interface YtNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YtPlayer;
}

declare global {
  interface Window { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void; }
}

let apiPromise: Promise<void> | undefined;

function loadYouTubeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiPromise ??= new Promise<void>((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { apiPromise = undefined; reject(new Error(t('yt.apiFailed'))); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

const PLAYING = 1, BUFFERING = 3, ENDED = 0, PAUSED = 2;

/** No playback after play: give up (blocked video, no network…). While loading, wait longer. */
const START_TIMEOUT_MS = 8000;
const BUFFERING_TIMEOUT_MS = 20000;
/**
 * "Playing" with the reported time standing still for longer than this (real ms at 1x; or 2.5x the usual
 * report interval, if larger) = still loading.
 */
const STALL_MS = 600;
/** Priming: how much the muted video must play to count as loaded (s), and the longest it may take (ms). */
const PRIME_PLAYED_S = 0.3;
const PRIME_MAX_MS = 6000;

/** YouTube player error codes → text for the player. */
function ytError(code: number): string {
  if (code === 101 || code === 150 || code === 152) return t('yt.errEmbed');
  if (code === 100) return t('yt.errRemoved');
  if (code === 153) return t('yt.errConfig');
  if (code === 5) return t('yt.errHtml5');
  return t('yt.errOther');
}

/** Errors that depend on how the player is set up: before giving up on the video, try another setup. */
const RETRYABLE = new Set([101, 150, 152, 153]);

/**
 * Player setups. The 1st is the plain embed; the 2nd hides the YouTube
 * controls; the 3rd uses the youtube-nocookie domain. The one that works is remembered for the next videos.
 */
const PLAYER_SETUPS: { host?: string; vars: () => Record<string, unknown> }[] = [
  { vars: () => ({ playsinline: 1, rel: 0 }) },
  { vars: () => ({ controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, modestbranding: 1,
      enablejsapi: 1, origin: location.origin, widget_referrer: location.origin }) },
  { host: 'https://www.youtube-nocookie.com', vars: () => ({ playsinline: 1, rel: 0 }) },
];
const SETUP_KEY = 'drumhero.ytPlayerSetup2';

function readSetup(): number {
  try { const n = Number(localStorage.getItem(SETUP_KEY)); return n >= 0 && n < PLAYER_SETUPS.length ? n : 0; } catch { return 0; }
}
function saveSetup(n: number): void {
  try { localStorage.setItem(SETUP_KEY, String(n)); } catch { /* no storage */ }
}

/**
 * Master clock using the YouTube video Songsterr synced.
 * The sync points say at which second of the video each bar starts;
 * in between, time is interpolated. Ads/buffering simply pause the clock.
 */
export class YouTubeClock implements GameClock {
  onEnded?: () => void;
  onFailure?: (message: string) => void;
  private player?: YtPlayer;
  /** The YouTube player only accepts commands after onReady (including when it is rebuilt). */
  private ready = false;
  private get p(): YtPlayer | undefined { return this.ready ? this.player : undefined; }
  private failed = false;
  /** Player setup in use (PLAYER_SETUPS) and how many were already tried for this video. */
  private setup = readSetup();
  private tried = 0;
  private everPlayed = false;
  private wantPlay = false;
  /**
   * Position requested before the video plays for the first time. YouTube's seekTo on a video that hasn't started
   * already STARTS PLAYING by itself; so the position is kept and only applied on play().
   */
  private pendingSeek: number | null = null;
  private loadDone?: () => void;
  private loadFail?: (e: Error) => void;
  private watchdog?: ReturnType<typeof setTimeout>;
  private state = -1;
  private anchorPerf = 0;
  private anchorMedia = 0;
  private running = false;
  /**
   * YouTube says "playing" but the video doesn't move (still loading — it doesn't always report buffering).
   * Meanwhile the clock stands still, so the track waits for the sound instead of running ahead of it.
   * Also true right after "playing" until the video actually moves for the first time.
   */
  private stalled = false;
  /** Last time the video itself reported (without the API's own extrapolation) and when it changed. */
  private lastRaw = Number.NaN;
  private lastRawChangeAt = 0;
  /** How often the player reports its time while playing (ms, averaged), to tell a stall from a normal gap. */
  private reportEvery = 250;
  /**
   * Countdown priming: the video plays muted from `at` until it really moves (loaded and decoding), then waits
   * paused at `at` again — so the play at the end of the countdown starts at once instead of loading first.
   * Meanwhile the clock keeps showing `at`, stopped. `from` = video time when it started moving.
   */
  private priming: { at: number; from: number; wasMuted: boolean; timer: ReturnType<typeof setTimeout> } | null = null;
  private _rate = 1;
  private chart: number[];
  private video: number[];

  constructor(private host: HTMLElement, private source: YoutubeSource) {
    const pts = [...(source.syncPoints ?? [])].sort((a, b) => a.chartMs - b.chartMs);
    this.chart = pts.map(p => p.chartMs);
    this.video = pts.map(p => p.videoMs);
  }

  get playing(): boolean { return this.running && !this.stalled; }
  get paused(): boolean { return !!this.priming || (this.state !== PLAYING && this.state !== BUFFERING); }
  get rate(): number { return this._rate; }

  /** Speeds YouTube offers for this video (it ignores any other). */
  availableRates(): number[] | null {
    const rates = this.p?.getAvailablePlaybackRates?.();
    return rates?.length ? rates : null;
  }

  /** YouTube only accepts some speeds; uses the closest one and returns the real one. */
  set rate(r: number) {
    if (!this.p) { this._rate = r; return; }
    const rates = this.p!.getAvailablePlaybackRates?.() ?? [1];
    const best = rates.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a), 1);
    this.reanchor();
    this.p!.setPlaybackRate(best);
    this._rate = best;
  }

  async load(): Promise<void> {
    await loadYouTubeApi();
    await new Promise<void>((resolve, reject) => {
      this.loadDone = resolve;
      this.loadFail = reject;
      this.build();
    });
  }

  /** Builds the player with the current setup (PLAYER_SETUPS[this.setup]). */
  private build(): void {
    this.tried++;
    this.player?.destroy();
    this.host.innerHTML = '';
    const el = document.createElement('div');
    this.host.appendChild(el);
    const cfg = PLAYER_SETUPS[this.setup];
    this.state = -1;
    this.ready = false;
    this.player = new window.YT!.Player(el, {
      videoId: this.source.videoId,
      width: '100%',
      height: '100%',
      ...(cfg.host ? { host: cfg.host } : {}),
      playerVars: cfg.vars(),
      events: {
        onReady: () => this.onReady(),
        // may arrive early (failed to load) or only after play (video blocked from embedding)
        onError: (e: { data: number }) => this.onPlayerError(e.data),
        onStateChange: (e: { data: number }) => this.onState(e.data),
      },
    });
  }

  private onReady(): void {
    this.ready = true;
    if (this.loadDone) { const done = this.loadDone; this.loadDone = this.loadFail = undefined; done(); return; }
    // rebuilt after an error: go back to the same point and, if the game was trying to play, play
    this.p?.setPlaybackRate(this._rate);
    this.pendingSeek = this.anchorMedia;
    if (this.wantPlay) void this.play();
  }

  private onPlayerError(code: number): void {
    if (this.failed) return;
    if (!this.everPlayed && RETRYABLE.has(code) && this.tried < PLAYER_SETUPS.length) {
      this.setup = (this.setup + 1) % PLAYER_SETUPS.length;
      clearTimeout(this.watchdog);
      this.build();
      return;
    }
    const msg = t('yt.unavailable', { reason: ytError(code), code, id: this.source.videoId });
    if (this.loadFail) { const fail = this.loadFail; this.loadDone = this.loadFail = undefined; fail(new Error(msg)); }
    this.fail(msg);
  }

  async play(): Promise<void> {
    if (this.failed) return;
    this.wantPlay = true;
    if (!this.ready) return;   // still building: onReady will play
    // the countdown ended before the video finished loading: it keeps playing, from the start point, with sound
    if (this.priming) this.takeOverPrime();
    if (this.pendingSeek !== null) {
      this.p?.seekTo(Math.max(0, this.toVideo(this.pendingSeek)) / 1000, true);
      this.pendingSeek = null;
    }
    this.p?.playVideo();
    // YouTube sometimes reports no error at all and just doesn't play: don't leave the game stuck at 0
    clearTimeout(this.watchdog);
    const started = performance.now();
    const check = (): void => {
      if (this.failed || this.state === PLAYING) return;
      const waited = performance.now() - started;
      const limit = this.state === BUFFERING ? BUFFERING_TIMEOUT_MS : START_TIMEOUT_MS;
      if (waited >= limit) { this.fail(t('yt.didNotStart', { id: this.source.videoId })); return; }
      this.watchdog = setTimeout(check, 500);
    };
    this.watchdog = setTimeout(check, 500);
  }

  pause(): void {
    this.wantPlay = false;
    clearTimeout(this.watchdog);
    if (this.priming) { this.endPrime(); return; }
    this.p?.pauseVideo();
  }

  prime(chartMs: number): void {
    const p = this.p;
    if (this.failed || !p || this.priming || this.state === PLAYING || this.state === BUFFERING) return;
    let wasMuted = false;
    try { wasMuted = p.isMuted(); p.mute(); } catch { return; }
    this.pendingSeek = null;
    this.anchorMedia = chartMs;
    this.anchorPerf = performance.now();
    this.priming = { at: chartMs, from: Number.NaN, wasMuted, timer: setTimeout(() => this.endPrime(), PRIME_MAX_MS) };
    p.seekTo(Math.max(0, this.toVideo(chartMs)) / 1000, true);
    p.playVideo();
  }

  /** Priming done (or cancelled): back to the start point, paused, with the sound as it was. */
  private endPrime(): void {
    const pr = this.priming;
    if (!pr) return;
    clearTimeout(pr.timer);
    this.priming = null;
    const p = this.p;
    if (!p) return;
    p.pauseVideo();
    // a video that never played starts by itself on seekTo: then the position waits for play()
    if (this.everPlayed) {
      p.seekTo(Math.max(0, this.toVideo(pr.at)) / 1000, true);
      this.state = PAUSED;   // already asked for; the player confirms a moment later
    } else {
      this.pendingSeek = pr.at;
    }
    if (!pr.wasMuted) p.unMute();
    this.anchorMedia = pr.at;
    this.anchorPerf = performance.now();
  }

  /** play() while priming: the video is already playing (muted, a little ahead) — back to the start point, with sound. */
  private takeOverPrime(): void {
    const pr = this.priming!;
    clearTimeout(pr.timer);
    this.priming = null;
    const p = this.p!;
    p.seekTo(Math.max(0, this.toVideo(pr.at)) / 1000, true);
    if (!pr.wasMuted) p.unMute();
    this.pendingSeek = null;
    this.anchorMedia = pr.at;
    this.anchorPerf = performance.now();
    if (this.state === PLAYING) this.startRunning();
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    clearTimeout(this.watchdog);
    if (this.priming) { clearTimeout(this.priming.timer); this.priming = null; }
    this.running = false;
    try { this.p?.pauseVideo(); } catch { /* player already has no video */ }
    this.onFailure?.(message);
  }

  seek(chartMs: number): void {
    if (this.priming) this.endPrime();
    // stopped video that hasn't played yet (or was just built): only store it; playing or paused after
    // playing, seekTo doesn't change the state (paused stays paused)
    if (this.state === PLAYING || this.state === BUFFERING || this.state === PAUSED) {
      this.p?.seekTo(Math.max(0, this.toVideo(chartMs)) / 1000, true);
      this.pendingSeek = null;
    } else {
      this.pendingSeek = chartMs;
    }
    this.anchorMedia = chartMs;
    this.anchorPerf = performance.now();
  }

  mediaAt(perf: number): number {
    // stopped (pause, waiting for sound to start, loading after a jump): time doesn't move, but looking
    // into the past (smaller perf, as the audio/video delay does) keeps subtracting — no jump on resume
    if (!this.running || this.stalled) return this.anchorMedia + Math.min(0, perf - this.anchorPerf) * this._rate;
    return this.anchorMedia + (perf - this.anchorPerf) * this._rate;
  }

  tick(perf = performance.now()): void {
    if (!this.p) return;
    if (this.priming) {
      // loaded once the muted video really moves; the clock stays at the start point meanwhile
      const pr = this.priming;
      if (this.state === PLAYING) {
        const raw = this.rawSeconds();
        const target = Math.max(0, this.toVideo(pr.at)) / 1000;
        // right after seekTo the player may still report the old position: wait for one near the start point
        if (raw >= target - 1 && raw <= target + 5) {
          if (Number.isNaN(pr.from)) pr.from = raw;
          else if (raw - pr.from >= PRIME_PLAYED_S) this.endPrime();
        }
      }
      this.anchorMedia = pr.at;
      this.anchorPerf = perf;
      return;
    }
    const real = this.p!.getPlaybackRate?.() ?? this._rate;
    if (Math.abs(real - this._rate) > 0.001) { this.reanchor(perf); this._rate = real; }
    if (!this.running && this.pendingSeek !== null) {
      this.anchorMedia = this.pendingSeek;
      this.anchorPerf = perf;
      return;
    }
    const measured = this.toChart(this.p!.getCurrentTime() * 1000);
    if (!this.running) {
      this.anchorMedia = measured;
      this.anchorPerf = perf;
      return;
    }
    // stuck on "playing" without the video moving: the clock waits at the real position until it moves again
    const raw = this.rawSeconds();
    if (raw !== this.lastRaw) {
      if (!Number.isNaN(this.lastRaw) && !this.stalled) {
        this.reportEvery = this.reportEvery * 0.8 + Math.min(1500, perf - this.lastRawChangeAt) * 0.2;
      }
      this.lastRaw = raw;
      this.lastRawChangeAt = perf;
      if (this.stalled) {
        this.stalled = false;
        this.anchorMedia = measured;
        this.anchorPerf = perf;
        return;
      }
    } else if (!this.stalled && perf - this.lastRawChangeAt > Math.max(STALL_MS, this.reportEvery * 2.5) / this._rate) {
      this.stalled = true;
      this.anchorMedia = this.toChart(raw * 1000);
      this.anchorPerf = perf;
    }
    if (this.stalled) return;
    const err = measured - this.mediaAt(perf);
    // YouTube time moves in steps: only correct big jumps, and slowly on small ones
    if (Math.abs(err) > 150) this.reanchor(perf);
    else this.anchorMedia += err * 0.02;
  }

  levels(out: AudioLevels): AudioLevels {
    // YouTube audio isn't accessible; the scenery reacts to the chart notes
    out.bass = out.mid = out.high = 0;
    out.spectrum.fill(0);
    return out;
  }

  dispose(): void {
    clearTimeout(this.watchdog);
    if (this.priming) clearTimeout(this.priming.timer);
    this.priming = null;
    this.onFailure = undefined;
    this.player?.destroy();
    this.host.innerHTML = '';
  }

  // ------------------------------------------------------------- chart <-> video mapping
  toVideo(chartMs: number): number { return interp(this.chart, this.video, chartMs); }
  toChart(videoMs: number): number { return interp(this.video, this.chart, videoMs); }

  private onState(s: number): void {
    if (this.failed) return;
    this.state = s;
    if (s === PLAYING) {
      clearTimeout(this.watchdog);
      if (!this.everPlayed) { this.everPlayed = true; saveSetup(this.setup); }
    }
    if (this.priming) return;   // the muted priming play is not the game playing
    const wasRunning = this.running;
    if ((s === PLAYING) !== wasRunning) {
      if (s === PLAYING) this.startRunning();
      else {
        this.running = false;
        this.stalled = false;
        this.reanchor();
        this.lastRaw = Number.NaN;
        this.lastRawChangeAt = performance.now();
      }
    }
    if (s === ENDED) this.onEnded?.();
  }

  /** The video started playing for the game: the clock only moves once the video does (it may say "playing" while still loading). */
  private startRunning(): void {
    this.running = true;
    this.reanchor();
    this.stalled = true;
    this.lastRaw = this.rawSeconds();
    this.lastRawChangeAt = performance.now();
  }

  /**
   * Video time as the player last reported it. getCurrentTime() adds the time since that report (up to
   * 1 s) while the state is "playing" — even when the video is stuck loading — so it can't reveal a stall.
   */
  private rawSeconds(): number {
    if (!this.p) return Number.NaN;
    const info = (this.p as unknown as { playerInfo?: { currentTime?: unknown } }).playerInfo;
    return typeof info?.currentTime === 'number' ? info.currentTime : this.p.getCurrentTime();
  }

  private reanchor(perf = performance.now()): void {
    if (!this.p) return;
    this.anchorMedia = this.toChart(this.p!.getCurrentTime() * 1000);
    this.anchorPerf = perf;
  }
}

/** Piecewise linear interpolation; outside the points it uses the slope of the closest segment. */
export function interp(xs: number[], ys: number[], x: number): number {
  const n = xs.length;
  if (n === 0) return x;
  if (n === 1) return ys[0] + (x - xs[0]);
  let i = 0;
  if (x >= xs[n - 1]) i = n - 2;
  else if (x > xs[0]) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    i = lo;
  }
  const dx = xs[i + 1] - xs[i] || 1;
  return ys[i] + ((x - xs[i]) * (ys[i + 1] - ys[i])) / dx;
}
