import { describe, expect, it } from 'vitest';
import { PlayNote } from './chart';
import { DebugRecorder } from './debug-recorder';
import { replayDump } from './debug-replay';
import { ScoreEngine } from './scoring';

const note = (id: number, t: number, lane: PlayNote['lane'] = 'hihat'): PlayNote => ({
  id, t, tick: 0, n: 42, lane, art: 'closed', v: 95, acc: false, ghost: false, section: 0, level: 1,
});

describe('debug: gravar e reproduzir', () => {
  it('a reprodução do arquivo dá o mesmo resultado ao vivo', () => {
    const notes = [0, 107, 214, 321, 428, 535].map((t, i) => note(i, t));
    const live = new ScoreEngine(1);
    live.configure(117, 50, 50);
    live.setNotes(notes);
    const rec = new DebugRecorder();
    rec.start({ rate: 1, strict: false, engine: { hitWindowMs: 117, chordWindowMs: 50, earlyWindowMs: 50 } });
    rec.push({ k: 'notes', at: 0, from: null, notes });
    rec.push({ k: 'reset', at: 0 });
    live.resetAll();

    const play = (t: number, cands: { lane: PlayNote['lane'] }[]) => {
      const misses = live.advance(t);
      rec.push({ k: 'tick', at: 0, now: t });
      for (const m of misses) if (m.note) rec.push({ k: 'miss', at: 0, noteId: m.note.id, t: m.note.t, lane: m.lane });
      if (!cands.length) return;
      const evs = live.hitAll(cands, t);
      rec.hit({ at: 0, source: 'keyboard', midiTs: null, note: 42, velocity: 100, cands, chartT: t, nowChart: t, near: [], playing: true, audioOffsetMs: 0,
        live: evs.length ? evs.map(x => ({ j: x.judgement, noteId: x.note?.id ?? null })) : [{ j: 'blocked', noteId: null }] });
    };
    play(0, [{ lane: 'hihat' }]);
    play(107, [{ lane: 'hihat' }]);
    play(214, [{ lane: 'hihat' }]);
    play(380, []);                       // note 321 passes without a hit
    play(368, [{ lane: 'hihat' }]);      // early: 428 wins (60 to go — closest note, 321)
    play(500, [{ lane: 'hihat' }]);

    const res = replayDump({ meta: rec.dump(0).meta, events: rec.dump(0).events });
    expect(res.hits).toBe(5);
    expect(res.mismatches).toEqual([]);
    expect(res.missMismatch).toEqual({ onlyLive: [], onlySim: [] });
  });
});
