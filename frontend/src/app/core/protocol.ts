// Types of the song package (chart) and the library.
import { StringKey, t } from './i18n';

export type Lane = 'crash' | 'hihat' | 'snare' | 'tom1' | 'tom2' | 'floor' | 'crash2' | 'ride' | 'kick';

export const LANES: Lane[] = ['crash', 'hihat', 'snare', 'tom1', 'tom2', 'floor', 'crash2', 'ride', 'kick'];

/** Piece name in the current language. */
export function laneLabel(lane: Lane): string {
  return t(`lane.${lane}` as StringKey);
}

export interface ChartNote {
  t: number;        // chart ms
  tick: number;
  n: number;        // original GM note
  lane: Lane;
  art: string;
  v: number;
  acc: boolean;
  ghost: boolean;
}

export interface DrumTrack { name: string; midiTrack: number; channel: number; notes: ChartNote[]; }
export interface Measure { index: number; ms: number; num: number; den: number; }
export interface Beat { ms: number; downbeat: boolean; }
export interface Section { name: string; measure: number; ms: number; }

export interface YoutubeSource {
  videoId: string;
  kind: 'full' | 'nodrums' | 'backing' | 'unknown';
  syncPoints: { chartMs: number; videoMs: number }[] | null;
}

export interface SongPackage {
  version: number;
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  ppq: number;
  tempoMap: { tick: number; ms: number; bpm: number }[];
  measures: Measure[];
  beats: Beat[];
  sections: Section[];
  drumTracks: DrumTrack[];
  audio: { synth?: { file: string; offsetMs: number }; youtube: YoutubeSource[] };
  lyrics?: { t: number; text: string }[];
  /** 2 = syllables already distributed skipping tied notes (before that the karaoke drifted ahead) */
  lyricsV?: number;
  warnings: string[];
}

export interface SongSummary {
  id: string; title: string; artist: string; durationMs: number; sections: number; audio: string[];
  isNew?: boolean;   // imported and not played yet (shows "new" on the card)
}
