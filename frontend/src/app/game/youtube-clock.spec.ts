import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { YouTubeClock } from './youtube-clock';

const PLAYING = 1, PAUSED = 2, BUFFERING = 3;

/** Minimal YouTube player: reports state changes through the clock's onState, like the real API. */
class FakePlayer {
  time = 0;            // video seconds
  muted = false;
  state = -1;
  calls: string[] = [];
  constructor(private onState: (s: number) => void) {}
  setState(s: number): void { this.state = s; this.onState(s); }
  playVideo(): void { this.calls.push('play'); if (this.state !== PLAYING) this.setState(BUFFERING); }
  pauseVideo(): void { this.calls.push('pause'); }
  /** Like the real player, the reported time can lag behind seekTo until its next report. */
  lag = false;
  private reported: number | null = null;
  seekTo(s: number): void {
    this.calls.push(`seek ${s}`);
    if (this.lag && this.reported === null) this.reported = this.time;
    this.time = s;
  }
  /** The player's next report: the reported time catches up with the real one. */
  report(): void { this.reported = null; }
  getCurrentTime(): number { return this.reported ?? this.time; }
  get playerInfo() { return { currentTime: this.reported ?? this.time }; }
  getPlaybackRate(): number { return 1; }
  setPlaybackRate(): void { /* only 1x here */ }
  getAvailablePlaybackRates(): number[] { return [1]; }
  mute(): void { this.muted = true; }
  unMute(): void { this.muted = false; }
  isMuted(): boolean { return this.muted; }
  destroy(): void { /* nothing */ }
}

function setup(everPlayed: boolean): { clock: YouTubeClock; p: FakePlayer } {
  // chart ms == video ms (sync points 1:1)
  const clock = new YouTubeClock({ innerHTML: '' } as unknown as HTMLElement,
    { kind: 'full', videoId: 'x', syncPoints: [{ chartMs: 0, videoMs: 0 }, { chartMs: 100_000, videoMs: 100_000 }] } as never);
  const c = clock as unknown as Record<string, unknown>;
  const p = new FakePlayer(s => (c['onState'] as (s: number) => void).call(clock, s));
  c['player'] = p;
  c['ready'] = true;
  if (everPlayed) {
    c['everPlayed'] = true;
    p.setState(PAUSED);
  }
  return { clock, p };
}

describe('YouTubeClock priming (countdown)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('loads the video muted and waits paused at the start point, with the clock stopped', () => {
    const { clock, p } = setup(true);
    clock.seek(10_000);
    clock.prime(10_000);
    expect(p.muted).toBe(true);
    expect(clock.paused).toBe(true);
    p.setState(PLAYING);                 // muted play started
    expect(clock.playing).toBe(false);   // not the game playing
    clock.tick();
    p.time = 10.1; clock.tick();         // starts moving (first reading near the start point)
    expect(clock.mediaAt(performance.now())).toBe(10_000);
    p.time = 10.5; clock.tick();         // played enough: back to the start, paused, with sound
    expect(p.calls.slice(-2)).toEqual(['pause', 'seek 10']);
    expect(p.muted).toBe(false);
    expect(clock.paused).toBe(true);
    expect(clock.mediaAt(performance.now())).toBe(10_000);
  });

  it('play() after priming only resumes from the start point', async () => {
    const { clock, p } = setup(true);
    clock.seek(5_000);
    clock.prime(5_000);
    p.setState(PLAYING); clock.tick();
    p.time = 5.1; clock.tick();
    p.time = 5.5; clock.tick();
    p.setState(PAUSED);
    p.calls = [];
    await clock.play();
    expect(p.calls).toEqual(['play']);   // no seek, no reload
    p.setState(PLAYING);
    p.time = 5.25; clock.tick();         // the video moves: the clock runs
    expect(clock.playing).toBe(true);
  });

  it('countdown ends while still loading: keeps playing from the start point, with sound', async () => {
    const { clock, p } = setup(true);
    clock.seek(20_000);
    clock.prime(20_000);
    p.setState(PLAYING);
    p.time = 20.2;                        // played a little, muted
    p.calls = [];
    await clock.play();
    expect(p.calls[0]).toBe('seek 20');   // back to the start point
    expect(p.muted).toBe(false);
    p.time = 20.3; clock.tick();
    expect(clock.playing).toBe(true);
  });

  it('pausing (countdown cancelled) stops the priming and restores the sound', () => {
    const { clock, p } = setup(true);
    clock.prime(0);
    p.setState(PLAYING);
    clock.pause();
    expect(p.calls.slice(-2)).toEqual(['pause', 'seek 0']);
    expect(p.muted).toBe(false);
    expect(clock.paused).toBe(true);
  });

  it('keeps the user muted if the video was already muted', () => {
    const { clock, p } = setup(true);
    p.muted = true;
    clock.prime(0);
    clock.pause();
    expect(p.muted).toBe(true);
  });

  it('gives up priming after a while without the video moving', () => {
    const { clock, p } = setup(true);
    clock.prime(3_000);
    vi.advanceTimersByTime(6_100);
    expect(p.calls).toContain('pause');
    expect(p.muted).toBe(false);
    expect(clock.paused).toBe(true);
  });

  it('restart: the countdown starts from the beginning even while the player still reports the old time', () => {
    const { clock, p } = setup(true);
    p.time = 50;                          // paused at 50 s
    clock.tick();
    p.lag = true;
    clock.seek(0);                        // restart
    clock.tick();                         // the player still says 50 s
    expect(clock.mediaAt(performance.now())).toBe(0);
    clock.prime(clock.mediaAt(performance.now()));
    expect(p.calls.slice(-2)).toEqual(['seek 0', 'play']);   // loads from the beginning, not from 50 s
    p.report();
    clock.tick();
    expect(clock.mediaAt(performance.now())).toBe(0);
  });
});
