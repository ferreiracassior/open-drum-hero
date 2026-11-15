import { PlayNote } from './chart';
import { lowerBound } from './scoring';

/**
 * Virtual drummer: plays the chart by itself, with configurable delay and inaccuracy.
 * Useful to test scoring and calibration without the drum kit.
 */
export class VirtualDrummer {
  enabled = false;
  latencyMs = 0;      // simulated fixed delay (e.g. Bluetooth)
  jitterMs = 12;      // standard deviation of human inaccuracy
  missRate = 0.02;
  private next = 0;
  private pending: { note: PlayNote; target: number }[] = [];

  constructor(private play: (note: PlayNote, chartTime: number) => void) {}

  reset(notes: PlayNote[], from: number): void {
    this.next = lowerBound(notes, from);
    this.pending = [];
  }

  /** `now` = chart time heard now; `rate` = speed. */
  update(notes: PlayNote[], now: number, rate: number): void {
    if (!this.enabled) return;
    while (this.next < notes.length && notes[this.next].t <= now + 500 * rate) {
      const note = notes[this.next++];
      if (Math.random() < this.missRate) continue;
      const err = (gauss() * this.jitterMs + this.latencyMs) * rate;
      this.pending.push({ note, target: note.t + err });
    }
    this.pending = this.pending.filter(p => {
      if (p.target > now) return true;
      this.play(p.note, p.target);
      return false;
    });
  }
}

function gauss(): number {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
