import { describe, expect, it } from 'vitest';
import { BarLayoutInput, layoutBar } from './bar-layout';

const base = (over: Partial<BarLayoutInput>): BarLayoutInput => ({
  stageWidth: 1400,
  rows: [['rate', 'src', 'level', 'riff', 'library', 'gear'], ['view', 'size', 'track']],
  widths: { rate: 90, src: 120, level: 90, riff: 140, library: 100, gear: 40, view: 160, size: 90, track: 70 },
  anchors: new Set(['view']),
  playWidth: 52, row0Height: 52, rowHeight: 40,
  video: null,
  fs: { width: 150, height: 40 },
  ...over,
});

describe('layoutBar', () => {
  it('keeps everything in place when there is room', () => {
    const out = layoutBar(base({}));
    expect(out.rows).toEqual([['rate', 'src', 'level', 'riff', 'library', 'gear'], ['view', 'size', 'track']]);
    expect(out.fs).toEqual({ right: 16, bottom: 22 });
  });

  it('sends speed, source and difficulty, in order, to the end of the row above', () => {
    const out = layoutBar(base({ stageWidth: 800 }));
    expect(out.rows[0][0]).not.toBe('rate');
    expect(out.rows[1].slice(0, 3)).toEqual(['view', 'size', 'track']);
    expect(out.rows[1][3]).toBe('rate');
  });

  it('moves the fullscreen button on top of the video before moving buttons', () => {
    // video at the bottom right (score view): 256x144
    const video = { left: 1400 - 16 - 256, right: 1400 - 16, bottom: 16, top: 160 };
    const out = layoutBar(base({ stageWidth: 1400, video, rows: [['rate', 'src', 'level', 'riff', 'library', 'gear', 'x'], ['view']], widths: { ...base({}).widths, x: 280 } }));
    expect(out.fs).toEqual({ right: 16, bottom: 172 });
    expect(out.rows[0]).toContain('rate');
  });
});
