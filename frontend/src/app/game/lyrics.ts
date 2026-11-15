/** Synced lyrics (Guitar Pro syllables with each beat's time). */
export interface LyricSyl { t: number; text: string; join: boolean; }
export interface LyricLine { start: number; end: number; syls: LyricSyl[]; }

/**
 * Groups the syllables into lines to show karaoke style:
 * breaks on a long pause or when the line gets long (without splitting words).
 */
export function buildLyricLines(raw: { t: number; text: string }[] | undefined): LyricLine[] {
  const lines: LyricLine[] = [];
  let cur: LyricLine | undefined;
  let chars = 0;
  for (const x of raw ?? []) {
    const text = x.text.trim();
    if (!text) continue;
    const join = text.endsWith('-');
    const clean = join ? text.slice(0, -1) : text;
    const prev = cur?.syls[cur.syls.length - 1];
    const gap = prev ? x.t - prev.t : Infinity;
    if (!cur || gap > 1800 || (chars > 34 && prev && !prev.join)) {
      cur = { start: x.t, end: x.t, syls: [] };
      lines.push(cur);
      chars = 0;
    }
    cur.syls.push({ t: x.t, text: clean, join });
    cur.end = x.t;
    chars += clean.length + (join ? 0 : 1);
  }
  return lines;
}

/** Index of the line to show at instant `now` (it appears a little before it starts). */
export function lyricLineAt(lines: LyricLine[], now: number, leadMs = 1500): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (now >= lines[i].start - leadMs) idx = i;
    else break;
  }
  if (idx >= 0 && now > lines[idx].end + 2500 && (idx + 1 >= lines.length || now < lines[idx + 1].start - leadMs)) return -1;
  return idx;
}
