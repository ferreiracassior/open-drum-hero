import { describe, expect, it } from 'vitest';
import { difficultyLevel, difficultyOf } from './difficulty';
import type { ChartNote } from './protocol';

const notes = (perSecond: number, seconds: number, from = 0): ChartNote[] =>
  Array.from({ length: perSecond * seconds }, (_, i) => ({
    t: from + (i * 1000) / perSecond, tick: 0, n: 38, lane: 'snare', art: 'hit', v: 90, acc: false, ghost: false,
  }));

describe('difficulty', () => {
  it('measures the notes per second of the busy parts', () => {
    expect(difficultyOf({ drumTracks: [{ name: 'd', midiTrack: 0, channel: 9, notes: notes(6, 60) }] })).toBeCloseTo(6, 0);
  });

  it('a quiet intro does not hide a hard song', () => {
    const song = [...notes(1, 60), ...notes(12, 120, 60_000)];
    expect(difficultyOf({ drumTracks: [{ name: 'd', midiTrack: 0, channel: 9, notes: song }] })).toBeGreaterThanOrEqual(11);
  });

  it('ignores ghost notes and empty tracks', () => {
    const ghosts = notes(20, 30).map(n => ({ ...n, ghost: true }));
    expect(difficultyOf({ drumTracks: [{ name: 'd', midiTrack: 0, channel: 9, notes: ghosts }] })).toBe(0);
    expect(difficultyOf({ drumTracks: [] })).toBe(0);
  });

  it('levels 1 to 5', () => {
    expect([0, 3, 7.5, 8.3, 12, 20].map(difficultyLevel)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
