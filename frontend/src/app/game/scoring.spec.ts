import { describe, expect, it } from 'vitest';
import { PlayNote } from './chart';
import { ScoreEngine, accuracy, hihatCompatible } from './scoring';

const note = (id: number, t: number, lane: PlayNote['lane'] = 'snare'): PlayNote => ({
  id, t, tick: 0, n: 38, lane, art: 'hit', v: 95, acc: false, ghost: false, section: 0, level: 1,
});

describe('ScoreEngine', () => {
  it('julga pelo tempo real e não conta a mesma nota duas vezes', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000), note(1, 1500)]);
    expect(e.hit('snare', 1010).judgement).toBe('perfect');
    expect(e.hit('snare', 1012).judgement).toBe('extra');
    expect(e.hit('snare', 1560).judgement).toBe('great');
    expect(e.stats.perfect).toBe(1);
    expect(e.stats.great).toBe(1);
  });

  it('aceita várias lanes (um crash físico vale para crash 1 e crash 2)', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000, 'crash2')]);
    const ev = e.hit(['crash', 'crash2'], 1005);
    expect(ev.judgement).toBe('perfect');
    expect(ev.lane).toBe('crash2');
  });

  it('chimbal aberto e fechado não se confundem', () => {
    const e = new ScoreEngine(1);
    e.setNotes([{ ...note(0, 1000, 'hihat'), art: 'open' }, { ...note(1, 2000, 'hihat'), art: 'closed' }]);
    expect(e.hit('hihat', 1000, 'closed').judgement).toBe('extra');
    expect(e.hit('hihat', 1000, 'open').judgement).toBe('perfect');
    expect(e.hit('hihat', 2000, 'open').judgement).toBe('extra');
    expect(e.hit('hihat', 2000, 'closed').judgement).toBe('perfect');
  });

  it('pedal do chimbal só acerta nota de pedal', () => {
    const e = new ScoreEngine(1);
    e.setNotes([{ ...note(0, 1000, 'hihat'), art: 'pedal' }, { ...note(1, 2000, 'hihat'), art: 'closed' }]);
    expect(e.hit('hihat', 1000, 'closed').judgement).toBe('extra');
    expect(e.hit('hihat', 1000, 'pedal').judgement).toBe('perfect');
    expect(e.hit('hihat', 2000, 'pedal').judgement).toBe('extra');
    expect(hihatCompatible('pedal', 'closed')).toBe(false);
  });

  it('semiaberto combina com aberto e fechado nas duas direções', () => {
    expect(hihatCompatible('half', 'open')).toBe(true);
    expect(hihatCompatible('half', 'closed')).toBe(true);
    expect(hihatCompatible('half', 'half')).toBe(true);
    expect(hihatCompatible('open', 'half')).toBe(true);
    expect(hihatCompatible('closed', 'half')).toBe(true);
    expect(hihatCompatible('half', 'pedal')).toBe(false);
    expect(hihatCompatible('open', 'closed')).toBe(false);
  });

  it('um input com vários comandos acerta a nota mais próxima entre eles', () => {
    const e = new ScoreEngine(1);
    e.setNotes([{ ...note(0, 1000, 'hihat'), art: 'half' }]);
    const ev = e.hitCands([{ lane: 'crash' }, { lane: 'hihat', hh: 'open' }], 1005);
    expect(ev.judgement).toBe('perfect');
    expect(ev.lane).toBe('hihat');
  });

  it('uma batida pode acertar duas notas de peças diferentes', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000, 'crash'), { ...note(1, 1002, 'hihat'), art: 'half' }]);
    const evs = e.hitAll([{ lane: 'crash' }, { lane: 'hihat', hh: 'open' }], 1001);
    expect(evs.map(x => x.note?.id)).toEqual([0, 1]);
    expect(e.stats.judged).toBe(2);
  });

  it('notas que saem juntas: a segunda batida fora da tolerância entre elas não acerta', () => {
    const e = new ScoreEngine(1);
    e.configure(117, 50);
    e.setNotes([note(0, 1000, 'kick'), note(1, 1000, 'snare')]);
    expect(e.hit('kick', 1000).judgement).toBe('perfect');
    e.hit('snare', 1100);                                    // 100 ms after the kick > 50 ms: doesn't count as a miss
    expect(e.stats.extra).toBe(0);
    expect(e.stats.streak).toBe(1);
    expect(e.statusOf(1)).toBe('pending');
    expect(e.hit('snare', 1020).judgement).not.toBe('extra');  // the snare can still be hit at the right time
  });

  it('notas que saem juntas: dentro da tolerância, as duas são aceitas', () => {
    const e = new ScoreEngine(1);
    e.configure(117, 50);
    e.setNotes([note(0, 1000, 'kick'), note(1, 1000, 'snare')]);
    e.hit('kick', 1000);
    expect(e.hit('snare', 1030).judgement).not.toBe('extra');
  });

  it('janela de acerto configurável', () => {
    const e = new ScoreEngine(1);
    e.configure(60, 50);
    e.setNotes([note(0, 1000)]);
    expect(e.hit('snare', 1050).judgement).toBe('good');     // 50 ms: within 60 ms, outside great (40 ms)
  });

  it('nota adiantada a até 50 ms ganha da que já passou da linha', () => {
    const e = new ScoreEngine(1);
    e.configure(117, 50, 50);
    e.setNotes([0, 107, 214, 321, 428].map((x, i) => note(i, x, 'hihat')));
    e.hit(['hihat'], 0); e.hit(['hihat'], 107); e.hit(['hihat'], 214);
    e.advance(380);
    e.hit(['hihat'], 378);                  // T4 is 50 ms away, T3 passed 57 ms ago
    expect(e.statusOf(4)).toBe('hit');
    expect(e.statusOf(3)).toBe('pending');
  });

  it('nota adiantada a mais de 50 ms não ganha prioridade', () => {
    const e = new ScoreEngine(1);
    e.configure(117, 50, 50);
    e.setNotes([0, 107, 214, 321, 428].map((x, i) => note(i, x, 'hihat')));
    e.hit(['hihat'], 0); e.hit(['hihat'], 107); e.hit(['hihat'], 214);
    e.advance(380);
    e.hit(['hihat'], 368);                  // T4 is 60 ms away: the closest note, T3, stays
    expect(e.statusOf(3)).toBe('hit');
    expect(e.statusOf(4)).toBe('pending');
  });

  it('respeita a lane', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000, 'kick')]);
    expect(e.hit('snare', 1000).judgement).toBe('extra');
    expect(e.hit('kick', 1000).judgement).toBe('perfect');
  });

  it('escala as janelas com a velocidade', () => {
    const e = new ScoreEngine(0.5);
    e.setNotes([note(0, 1000)]);
    // 30 chart ms at 50% = 60 real ms -> great
    expect(e.hit('snare', 1030).judgement).toBe('great');
  });

  it('marca erro quando a janela passa', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000), note(1, 2000)]);
    expect(e.advance(1200).map(x => x.judgement)).toEqual(['miss']);
    e.hit('snare', 2000);
    expect(accuracy(e.stats)).toBeCloseTo(0.5);
    expect(e.stats.streak).toBe(1);
  });

  it('resetRange volta as notas do loop', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000)]);
    e.hit('snare', 1000);
    e.resetRange(0, 1500);
    expect(e.statusOf(0)).toBe('pending');
    expect(e.hit('snare', 1000).judgement).toBe('perfect');
  });

  it('seek: notas puladas não viram erro e as seguintes voltam a valer', () => {
    const e = new ScoreEngine(1);
    e.setNotes([note(0, 1000), note(1, 3000), note(2, 5000)]);
    e.hit('snare', 3000);
    e.seek(2500);
    expect(e.advance(2600)).toEqual([]);
    expect(e.statusOf(1)).toBe('pending');
    e.seek(4000);
    expect(e.advance(4500).length).toBe(0);
    expect(e.advance(6000).map(x => x.note!.id)).toEqual([2]);
  });
});
