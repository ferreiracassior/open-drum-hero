import type { SongPackage } from './protocol';

/**
 * Song difficulty for the library: how many notes per second the drummer plays in the busy parts.
 * It takes the note density (ghost notes left out) over 4-second windows and keeps the 90th percentile —
 * an average would hide hard sections behind quiet intros, the maximum would be one single fill.
 * Reference: Stairway to Heaven ≈ 7.5, Enter Sandman ≈ 8.3, fast metal with double bass 15+.
 */
export function difficultyOf(pkg: Pick<SongPackage, 'drumTracks'>, track = 0): number {
  const notes = pkg.drumTracks[track]?.notes ?? [];
  const times = notes.filter(n => !n.ghost).map(n => n.t).sort((a, b) => a - b);
  if (times.length < 2) return 0;
  const dens: number[] = [];
  for (let i = 0, j = 0; i < times.length; i++) {
    while (times[i] - times[j] > WINDOW_MS) j++;
    dens.push((i - j + 1) / (WINDOW_MS / 1000));
  }
  dens.sort((a, b) => a - b);
  return Math.round(dens[Math.floor((dens.length - 1) * 0.9)] * 10) / 10;
}

const WINDOW_MS = 4000;
/** Notes per second where each level (1–5) starts. */
const LEVELS = [0, 5, 8, 11, 15];

/** 1 (easy) to 5 (very hard); 0 when the song has no notes. */
export function difficultyLevel(nps: number): number {
  if (!nps) return 0;
  let level = 0;
  for (const start of LEVELS) if (nps >= start) level++;
  return level;
}
