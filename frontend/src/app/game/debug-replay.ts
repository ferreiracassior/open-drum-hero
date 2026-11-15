import { DEBUG_FORMAT, DebugEvent, DebugHit } from './debug-recorder';
import { ScoreEngine } from './scoring';

export interface ReplayRow {
  seq: number;
  chartT: number;
  source: string;
  note: number | null;
  cands: string;
  live: string;
  sim: string;
  same: boolean;
}

export interface ReplayResult {
  hits: number;
  rows: ReplayRow[];
  mismatches: ReplayRow[];
  liveMisses: number[];
  simMisses: number[];
  missMismatch: { onlyLive: number[]; onlySim: number[] };
}

const fmt = (list: { j: string; noteId: number | null }[]) =>
  list.length ? list.map(x => `${x.j}#${x.noteId ?? '-'}`).join(' + ') : 'blocked';

/**
 * Runs a debug file through the scoring engine again and compares, hit by hit,
 * the live result with what the engine produces now (use it to test changes in the logic).
 */
export function replayDump(dump: { format?: string; meta: Record<string, any>; events: DebugEvent[] }): ReplayResult {
  if (dump.format && dump.format !== DEBUG_FORMAT) throw new Error(`formato desconhecido: ${dump.format}`);
  const m = dump.meta;
  const e = new ScoreEngine(m['rate'] ?? 1);
  e.strict = !!m['strict'];
  e.configure(m['engine'].hitWindowMs, m['engine'].chordWindowMs, m['engine'].earlyWindowMs);

  const rows: ReplayRow[] = [];
  const liveMisses: number[] = [];
  const simMisses: number[] = [];
  for (const ev of dump.events) {
    switch (ev.k) {
      case 'notes': e.setNotes(ev.notes, ev.from ?? -Infinity); break;
      case 'reset': e.resetAll(); break;
      case 'seek': e.seek(ev.t); break;
      case 'range': e.resetRange(ev.start, ev.end); break;
      case 'tick':
        for (const x of e.advance(ev.now)) if (x.note) simMisses.push(x.note.id);
        break;
      case 'miss': liveMisses.push(ev.noteId); break;
      case 'hit': {
        const h = ev as DebugHit;
        const sim = e.hitAll(h.cands, h.chartT).map(x => ({ j: x.judgement, noteId: x.note?.id ?? null }));
        const live = fmt(h.live), simTxt = fmt(sim);
        rows.push({
          seq: h.seq, chartT: h.chartT, source: h.source, note: h.note,
          cands: h.cands.map(c => c.lane + (c.hh ? `(${c.hh})` : '')).join(','),
          live, sim: simTxt, same: live === simTxt,
        });
        break;
      }
      default: break;
    }
  }
  const lm = new Set(liveMisses), sm = new Set(simMisses);
  return {
    hits: rows.length,
    rows,
    mismatches: rows.filter(r => !r.same),
    liveMisses, simMisses,
    missMismatch: {
      onlyLive: [...lm].filter(id => !sm.has(id)),
      onlySim: [...sm].filter(id => !lm.has(id)),
    },
  };
}
