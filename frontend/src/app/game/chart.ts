import { t } from '../core/i18n';
import { Beat, ChartNote, Lane, SongPackage } from '../core/protocol';

export const MAX_LEVEL = 5;

export interface PlayNote extends ChartNote {
  id: number;
  section: number;
  level: number;   // lowest difficulty level at which the note appears (1–5)
}

export interface SectionRange { index: number; name: string; start: number; end: number; }

export interface Chart {
  song: SongPackage;
  trackIndex: number;
  notes: PlayNote[];        // all of them, sorted by time
  beats: Beat[];
  sections: SectionRange[];
  durationMs: number;
}

/**
 * Difficulty level of each note (Rocksmith's "dynamic difficulty" style):
 * 1 kick/snare on the beats · 2 + hi-hat/cymbals on the beats · 3 eighth-note groove
 * 4 + sixteenths and fills · 5 everything (ghost notes and toms off the grid).
 */
export function levelOf(n: ChartNote, ppq: number): number {
  if (n.ghost) return 5;
  const quarter = n.tick % ppq === 0;
  const eighth = n.tick % (ppq / 2) === 0;
  switch (n.lane) {
    case 'kick':
    case 'snare':
      return quarter ? 1 : eighth ? 3 : 4;
    case 'hihat':
    case 'ride':
    case 'crash':
    case 'crash2':
      return quarter ? 2 : eighth ? 3 : 4;
    default: // toms
      return eighth ? 4 : 5;
  }
}

export function buildChart(song: SongPackage, trackIndex = 0): Chart {
  const track = song.drumTracks[trackIndex] ?? song.drumTracks[0];
  const end = song.durationMs;
  const secs = song.sections.length ? song.sections : [{ name: t('common.song'), measure: 0, ms: 0 }];
  const sections: SectionRange[] = secs.map((s, i) => ({
    index: i,
    name: s.name,
    start: i === 0 ? 0 : s.ms,
    end: i + 1 < secs.length ? secs[i + 1].ms : end,
  }));
  const sectionAt = (t: number) => {
    let k = 0;
    while (k + 1 < sections.length && sections[k + 1].start <= t) k++;
    return k;
  };
  const notes: PlayNote[] = [...track.notes]
    .sort((a, b) => a.t - b.t)
    .map((n, id) => ({ ...n, id, section: sectionAt(n.t), level: levelOf(n, song.ppq) }));
  return { song, trackIndex, notes, beats: song.beats, sections, durationMs: end };
}

/** Active notes given each section's level. */
export function notesForLevels(chart: Chart, levelBySection: number[]): PlayNote[] {
  return chart.notes.filter(n => n.level <= (levelBySection[n.section] ?? MAX_LEVEL));
}

export function laneCount(notes: PlayNote[]): Record<Lane, number> {
  const out = { crash: 0, hihat: 0, snare: 0, tom1: 0, tom2: 0, floor: 0, crash2: 0, ride: 0, kick: 0 } as Record<Lane, number>;
  for (const n of notes) out[n.lane]++;
  return out;
}
