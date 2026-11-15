/**
 * Layout of the bottom bar (pause screen): rows of buttons that grow upwards from the bottom-left
 * corner, and the PC fullscreen button on the right. When a row would run into something on the right
 * (the fullscreen button, the YouTube video, the screen edge), its buttons move, in order, to the end of
 * the row above:
 *  1. if the bottom row hits the fullscreen button while it sits beside the video (score view), the
 *     button first goes on top of the video, with the usual gap;
 *  2. still colliding: the bottom row sends speed, audio source and difficulty (in that order, then the
 *     rest) to the end of the row above (the highway/score switch row);
 *  3. any row that collides does the same with the row above it.
 * Pure function: everything comes in measured (px), so it can be tested without a browser.
 */

/** Rectangle measured from the stage's bottom-left corner (y grows upwards). */
export interface BarRect { left: number; right: number; bottom: number; top: number; }

export interface BarLayoutInput {
  stageWidth: number;
  /** Rows before any move (row 0 = bottom). Keys of the items. */
  rows: string[][];
  /** Item width by key (px). */
  widths: Record<string, number>;
  /** Items that never leave their row (e.g. the switch that starts row 1). */
  anchors: ReadonlySet<string>;
  /** Width of the play button, which always starts row 0. */
  playWidth: number;
  /** Height of row 0 (play button) and of the other rows (bar buttons). */
  row0Height: number;
  rowHeight: number;
  /** YouTube video, if it is on screen. */
  video: BarRect | null;
  /** Fullscreen button size, if it is shown (PC). */
  fs: { width: number; height: number } | null;
}

export interface BarLayout {
  rows: string[][];
  /** Fullscreen button position (distance from the right and from the bottom of the stage). */
  fs: { right: number; bottom: number } | null;
}

export const BAR_MARGIN = 16;   // distance from the screen edges
export const BAR_GAP = 10;      // between buttons in a row
export const ROW_GAP = 12;      // between rows
export const CLEAR = 12;        // breathing room next to the video / fullscreen button
const MAX_ROWS = 6;

/** Vertical band of row `r` (from the stage bottom). */
export function rowBand(r: number, row0Height: number, rowHeight: number): { bottom: number; top: number } {
  if (r === 0) return { bottom: BAR_MARGIN, top: BAR_MARGIN + row0Height };
  const bottom = BAR_MARGIN + row0Height + ROW_GAP + (r - 1) * (rowHeight + ROW_GAP);
  return { bottom, top: bottom + rowHeight };
}

const overlaps = (a: { bottom: number; top: number }, b: { bottom: number; top: number }) => a.bottom < b.top && b.bottom < a.top;

export function layoutBar(inp: BarLayoutInput): BarLayout {
  const w = (k: string) => inp.widths[k] ?? 0;
  const rowWidth = (r: number, row: string[]) => {
    const items = row.reduce((s, k) => s + w(k), 0) + (r === 0 ? inp.playWidth : 0);
    const n = row.length + (r === 0 ? 1 : 0);
    return items + Math.max(0, n - 1) * BAR_GAP;
  };
  const band0 = rowBand(0, inp.row0Height, inp.rowHeight);

  // fullscreen button: at the right of the bottom row; beside the video if the video sits there
  let fsRect: BarRect | null = null;
  let fsPos: BarLayout['fs'] = null;
  if (inp.fs) {
    const { width, height } = inp.fs;
    const bottom = band0.bottom + (inp.row0Height - height) / 2;
    const videoInRow0 = inp.video && overlaps(inp.video, band0);
    const right = videoInRow0 ? inp.stageWidth - inp.video!.left + CLEAR : BAR_MARGIN;
    fsRect = { left: inp.stageWidth - right - width, right: inp.stageWidth - right, bottom, top: bottom + height };
    fsPos = { right, bottom };
    // 1. the bottom row hits it: the button goes on top of the video
    if (videoInRow0 && BAR_MARGIN + rowWidth(0, inp.rows[0] ?? []) + CLEAR > fsRect.left) {
      const r2 = inp.stageWidth - inp.video!.right;
      const b2 = inp.video!.top + CLEAR;
      fsRect = { left: inp.video!.right - width, right: inp.video!.right, bottom: b2, top: b2 + height };
      fsPos = { right: r2, bottom: b2 };
    }
  }
  const obstacles = [inp.video, fsRect].filter((o): o is BarRect => !!o);

  // 2/3. each row that doesn't fit sends its first movable items to the end of the row above
  const rows = inp.rows.map(r => [...r]);
  for (let r = 0; r < rows.length && r < MAX_ROWS; r++) {
    const band = rowBand(r, inp.row0Height, inp.rowHeight);
    const limit = obstacles.filter(o => overlaps(o, band)).reduce((m, o) => Math.min(m, o.left - CLEAR), inp.stageWidth - BAR_MARGIN);
    const room = limit - BAR_MARGIN;
    while (rowWidth(r, rows[r]) > room && r < MAX_ROWS - 1) {
      const i = rows[r].findIndex(k => !inp.anchors.has(k));
      if (i < 0) break;
      const [k] = rows[r].splice(i, 1);
      if (!rows[r + 1]) rows[r + 1] = [];
      rows[r + 1].push(k);
    }
  }
  return { rows: rows.filter((row, i) => i === 0 || row.length), fs: fsPos };
}
