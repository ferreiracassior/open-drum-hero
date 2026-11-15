import { Lane } from '../core/protocol';
import { PlayNote } from './chart';

export type Judgement = 'perfect' | 'great' | 'good' | 'miss' | 'extra';

/** Hit window (real-time ms, on each side of the note): default 117 ms (value provided). */
export const DEFAULT_HIT_WINDOW = 117;
/** Tolerance between notes that should come out together (real ms). */
export const DEFAULT_CHORD_WINDOW = 50;

/** Perfect and great are 1/3 and 2/3 of the hit window. */
export function windowsFor(goodMs: number) {
  const good = Math.min(400, Math.max(10, goodMs));
  return { perfect: good / 3, great: (good * 2) / 3, good };
}
export const WINDOWS = windowsFor(DEFAULT_HIT_WINDOW);
const WEIGHT: Record<Judgement, number> = { perfect: 1, great: 0.8, good: 0.5, miss: 0, extra: 0 };
const POINTS: Record<Judgement, number> = { perfect: 100, great: 80, good: 50, miss: 0, extra: 0 };

export interface JudgeEvent {
  judgement: Judgement;
  lane: Lane;
  note?: PlayNote;
  deltaMs?: number;   // real time: negative = early
}

export interface Stats {
  perfect: number; great: number; good: number; miss: number; extra: number;
  score: number; streak: number; maxStreak: number;
  weight: number; judged: number;
  deltas: number[];
  sections: Record<number, { weight: number; judged: number }>;
}

export const emptyStats = (): Stats => ({
  perfect: 0, great: 0, good: 0, miss: 0, extra: 0, score: 0, streak: 0, maxStreak: 0,
  weight: 0, judged: 0, deltas: [], sections: {},
});

export type HhArt = 'open' | 'closed' | 'half' | 'pedal';

/** A command the hit triggers: the lane (and the type, for the hi-hat). */
export interface Cand {
  lane: Lane;
  hh?: HhArt;
  /** Screen touch or PC key: there is only one hi-hat button, so it counts for open, half-open and closed. */
  anyHh?: boolean;
}

/**
 * Hi-hat: the same type always hits. Half-open (in between) matches open or closed
 * in both directions, because the hit doesn't separate the two well. Pedal only hits pedal.
 */
export function hihatCompatible(noteArt: string, hitArt: HhArt): boolean {
  if (noteArt === hitArt) return true;
  if (noteArt === 'half') return hitArt === 'open' || hitArt === 'closed';
  if (hitArt === 'half') return noteArt === 'open' || noteArt === 'closed';
  return !['open', 'closed', 'pedal'].includes(noteArt);   // note of unknown type accepts any hit
}

export const accuracy = (s: { weight: number; judged: number }) => (s.judged ? s.weight / s.judged : 0);
export const multiplier = (streak: number) => Math.min(4, 1 + Math.floor(streak / 10));

const PENDING = 0, HIT = 1, MISSED = 2, SKIPPED = 3;

/**
 * Scoring engine. Input times in chart ms; `rate` converts real-time
 * windows to chart time.
 */
export class ScoreEngine {
  stats = emptyStats();
  pass = emptyStats();          // current Riff Repeater pass
  strict = false;
  win = WINDOWS;                // hit windows in real ms
  chordTol = DEFAULT_CHORD_WINDOW;   // tolerance between notes at the same instant (real ms)
  earlyMs = 50;                      // an early note only gets priority if it is at most this far away (real ms)
  private notes: PlayNote[] = [];
  private state = new Map<number, number>();
  private byLane = new Map<Lane, PlayNote[]>();
  private chordOf = new Map<number, number[]>();   // note id -> ids of the notes that come out together with it
  private hitT = new Map<number, number>();        // id -> instant (chart) when it was hit
  private sweep = 0;

  constructor(public rate = 1) {}

  /** Applies the calibration: hit window and tolerance between simultaneous notes. */
  configure(hitWindowMs: number, chordMs: number, earlyMs = 50): void {
    if (hitWindowMs !== this.win.good) this.win = windowsFor(hitWindowMs);
    this.chordTol = Math.min(400, Math.max(0, chordMs));
    this.earlyMs = Math.min(400, Math.max(0, earlyMs));
  }

  /**
   * Sets the active notes (e.g. when the difficulty changes). New notes before `from`
   * don't count as misses.
   */
  setNotes(notes: PlayNote[], from = -Infinity): void {
    this.notes = [...notes].sort((a, b) => a.t - b.t);
    this.byLane.clear();
    for (const n of this.notes) {
      if (!this.state.has(n.id)) this.state.set(n.id, n.t < from ? SKIPPED : PENDING);
      const arr = this.byLane.get(n.lane) ?? [];
      arr.push(n);
      this.byLane.set(n.lane, arr);
    }
    // notes at the same instant (same tick) form a group that must come out together
    this.chordOf.clear();
    const byT = new Map<number, number[]>();
    for (const n of this.notes) {
      const k = Math.round(n.t);
      const g = byT.get(k);
      if (g) g.push(n.id); else byT.set(k, [n.id]);
    }
    for (const g of byT.values()) if (g.length > 1) for (const id of g) this.chordOf.set(id, g);
    this.sweep = from === -Infinity ? 0 : lowerBound(this.notes, from - this.win.good * this.rate);
  }

  statusOf(id: number): 'pending' | 'hit' | 'miss' {
    const s = this.state.get(id);
    return s === HIT ? 'hit' : s === MISSED ? 'miss' : 'pending';
  }

  /** Sets the notes in [start, end) back to pending (loop / restart). */
  resetRange(start: number, end: number): void {
    for (const n of this.notes) if (n.t >= start && n.t < end) this.state.set(n.id, PENDING);
    this.sweep = lowerBound(this.notes, start);
    this.pass = emptyStats();
  }

  /** Jumped to `t` (timeline): what comes after counts again, what was left behind doesn't count. */
  seek(t: number): void {
    for (const n of this.notes) {
      if (n.t >= t) this.state.set(n.id, PENDING);
      else if (this.state.get(n.id) === PENDING) this.state.set(n.id, SKIPPED);
    }
    this.sweep = lowerBound(this.notes, t);
    this.pass = emptyStats();
  }

  resetAll(): void {
    this.state.clear();
    for (const n of this.notes) this.state.set(n.id, PENDING);
    this.stats = emptyStats();
    this.pass = emptyStats();
    this.sweep = 0;
  }

  /** Hit on one or more lanes (no hi-hat type). */
  hit(lanes: Lane | Lane[], t: number, hihatArt?: HhArt): JudgeEvent {
    const list = Array.isArray(lanes) ? lanes : [lanes];
    return this.hitCands(list.map(lane => ({ lane, hh: hihatArt })), t);
  }

  /** Hit that may match any of the given commands (one input can trigger several pieces). */
  /**
   * A hit that triggers several commands: each command hits its closest pending note.
   * It can hit more than one note (one per piece); if none matches, it counts as a miss (extra).
   */
  hitAll(cands: Cand[], t: number): JudgeEvent[] {
    const win = this.win.good * this.rate;
    const found = new Map<number, PlayNote>();
    let blocked = false;   // found a compatible note, but the hit fell outside the simultaneity window
    for (const c of cands) {
      let best: PlayNote | undefined;
      let bestAbs = Infinity;
      let bestUpcoming = false;
      const arr = this.byLane.get(c.lane) ?? [];
      for (let i = Math.max(0, lowerBound(arr, t - win)); i < arr.length && arr[i].t <= t + win; i++) {
        const n = arr[i];
        if (this.state.get(n.id) !== PENDING) continue;
        if (c.lane === 'hihat' && !(c.anyHh ? n.art !== 'pedal' : hihatCompatible(n.art, c.hh ?? 'closed'))) continue;
        if (!this.chordOk(n, t)) { blocked = true; continue; }
        // an early note (hasn't passed the line yet and is at most earlyMs away) has priority over one that already passed
        const upcoming = n.t >= t && Math.abs(t - n.t) / this.rate <= this.earlyMs;
        const d = Math.abs(t - n.t);
        if (best === undefined || (upcoming && !bestUpcoming) || (upcoming === bestUpcoming && d < bestAbs)) {
          bestAbs = d; best = n; bestUpcoming = upcoming;
        }
      }
      if (best) found.set(best.id, best);
    }
    if (!found.size) {
      // outside the simultaneity window: not the player's mistake. The note stays pending
      // (and can be hit by a hit within the tolerance), without penalizing or resetting the streak.
      if (blocked) return [];
      this.record('extra');
      return [{ judgement: 'extra', lane: cands[0].lane }];
    }
    const out: JudgeEvent[] = [];
    for (const n of found.values()) {
      const realDelta = (t - n.t) / this.rate;
      const a = Math.abs(realDelta);
      const j: Judgement = a <= this.win.perfect ? 'perfect' : a <= this.win.great ? 'great' : 'good';
      this.state.set(n.id, HIT);
      this.hitT.set(n.id, t);
      this.record(j, n, realDelta);
      out.push({ judgement: j, lane: n.lane, note: n, deltaMs: realDelta });
    }
    return out;
  }

  /**
   * Notes that come out together are only accepted if the hits of the whole group fall within the
   * tolerance of each other (e.g. two notes at the same time played 100 ms apart = miss).
   */
  private chordOk(n: PlayNote, t: number): boolean {
    const g = this.chordOf.get(n.id);
    if (!g) return true;
    for (const id of g) {
      if (id === n.id || this.state.get(id) !== HIT) continue;
      const other = this.hitT.get(id) ?? t;
      if (Math.abs(t - other) / this.rate > this.chordTol) return false;
    }
    return true;
  }

  /** Single-hit version: the first result of `hitAll`. */
  hitCands(cands: Cand[], t: number): JudgeEvent {
    return this.hitAll(cands, t)[0] ?? { judgement: 'extra', lane: cands[0].lane };
  }

  /** Marks as missed the notes whose window has passed. */
  advance(now: number): JudgeEvent[] {
    const out: JudgeEvent[] = [];
    const limit = now - this.win.good * this.rate;
    while (this.sweep < this.notes.length && this.notes[this.sweep].t < limit) {
      const n = this.notes[this.sweep++];
      if (this.state.get(n.id) === PENDING) {
        this.state.set(n.id, MISSED);
        this.record('miss', n);
        out.push({ judgement: 'miss', lane: n.lane, note: n });
      }
    }
    return out;
  }

  private record(j: Judgement, n?: PlayNote, delta?: number): void {
    for (const s of [this.stats, this.pass]) {
      s[j]++;
      if (j === 'extra') {
        if (this.strict) s.streak = 0;
        continue;
      }
      s.judged++;
      s.weight += WEIGHT[j];
      if (j === 'miss') s.streak = 0;
      else {
        s.streak++;
        s.maxStreak = Math.max(s.maxStreak, s.streak);
        s.score += POINTS[j] * multiplier(s.streak);
        if (delta !== undefined) s.deltas.push(delta);
      }
      if (n) {
        const sec = (s.sections[n.section] ??= { weight: 0, judged: 0 });
        sec.judged++;
        sec.weight += WEIGHT[j];
      }
    }
  }
}

export function lowerBound(arr: { t: number }[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function meanStd(xs: number[]): { mean: number; std: number } {
  if (!xs.length) return { mean: 0, std: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, std };
}
