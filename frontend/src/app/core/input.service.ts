import { Injectable, signal } from '@angular/core';
import { Observable, Subject, merge, share, map, filter } from 'rxjs';
import { MidiService } from '../platform/midi.service';
import { Lane } from './protocol';
import type { Cand, HhArt } from '../game/scoring';
import { KitTarget, SettingsService } from './settings.service';

/** A hit already converted to this device's clock. */
export interface PadHit {
  note: number;
  velocity: number;
  targets: KitTarget[];       // commands the note triggers
  cands: Cand[];              // the same commands as lanes (hi-hat with its type)
  time: number;               // performance.now() at the moment of the hit
  source: 'drum' | 'sim' | 'keyboard' | 'bot';
  midiTs: number | null;      // no longer used (it was the PC timestamp); kept for the debug mode format
  key?: string;               // PC key (KeyboardEvent.code), when it came from the keyboard
}

/** Short name of a key (KeyboardEvent.code) to show on screen. */
export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const names: Record<string, string> = {
    Space: 'Space', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
    BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', IntlRo: '/',
    ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ShiftLeft: 'Shift', ShiftRight: 'Shift R',
    ControlLeft: 'Ctrl', ControlRight: 'Ctrl R', AltLeft: 'Alt', AltRight: 'Alt R', Enter: 'Enter', Tab: 'Tab',
  };
  return names[code] ?? code;
}

/** Hi-hat type of a mapping target (undefined for the other pieces). */
function hhOf(t: KitTarget): HhArt | undefined {
  switch (t) {
    case 'hihat': return 'closed';
    case 'hihat_open': return 'open';
    case 'hihat_half': return 'half';
    case 'hihat_pedal': return 'pedal';
    default: return undefined;
  }
}

/** Mapping command -> lane (and hi-hat type). 'ignore' triggers nothing. */
function candOf(t: KitTarget): Cand | undefined {
  if (t === 'ignore') return undefined;
  if (t.startsWith('hihat')) return { lane: 'hihat', hh: hhOf(t) };
  return { lane: t as Lane };
}

@Injectable({ providedIn: 'root' })
export class InputService {
  readonly lastHit = signal<PadHit | null>(null);
  private readonly local = new Subject<PadHit>();
  /** Every key pressed on the PC (mapped or not) — used to learn keys in Map drum kit. */
  readonly keys$ = new Subject<string>();

  /** All hits (USB drum kit, simulated, keyboard and virtual drummer). */
  readonly hits$: Observable<PadHit>;
  /** Only the hits that fall on a lane. */
  /** Hits that trigger some piece. */
  readonly laneHits$: Observable<PadHit>;

  constructor(midi: MidiService, private settings: SettingsService) {
    const remote$ = midi.hits$.pipe(map(m => this.make(m.note, m.velocity, m.time, 'drum')));
    this.hits$ = merge(remote$, this.local).pipe(share());
    this.laneHits$ = this.hits$.pipe(filter(h => h.cands.length > 0));
    this.hits$.subscribe(h => this.lastHit.set(h));

    // PC keyboard as a drum kit (PC only; keys are mapped in Map drum kit, like the drum kit)
    if (settings.device === 'pc') {
      addEventListener('keydown', e => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (e.repeat || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey) return;
        this.keys$.next(e.code);
        const targets = this.settings.keys()[e.code];
        if (targets?.length) {
          e.preventDefault();
          this.local.next({ ...this.fromTargets(targets, 0, 100, performance.now(), 'keyboard'), key: e.code });
        }
      });
    }
  }

  /** Hit directly on a piece (highway icons, without a drum kit). */
  emitTargets(targets: KitTarget[], source: PadHit['source'] = 'sim', time = performance.now()): void {
    this.local.next(this.fromTargets(targets, 0, 100, time, source));
  }

  /** Hit generated on the device itself (on-screen buttons, virtual drummer). */
  emit(note: number, velocity = 100, source: PadHit['source'] = 'sim', time = performance.now()): void {
    this.local.next(this.make(note, velocity, time, source));
  }

  private make(note: number, velocity: number, time: number, source: PadHit['source'], midiTs: number | null = null): PadHit {
    return this.fromTargets(this.settings.profile().kit[String(note)] ?? [], note, velocity, time, source, midiTs);
  }

  private fromTargets(targets: KitTarget[], note: number, velocity: number, time: number, source: PadHit['source'], midiTs: number | null = null): PadHit {
    const cands: Cand[] = [];
    // screen touch and keyboard: a single hi-hat button, valid for open, half-open and closed
    const anyHh = source === 'sim' || source === 'keyboard';
    for (const t of targets) {
      let c = candOf(t);
      if (c && anyHh && c.lane === 'hihat' && c.hh !== 'pedal') c = { lane: 'hihat', anyHh: true };
      if (c && !cands.some(x => x.lane === c.lane && x.hh === c.hh)) cands.push(c);
    }
    return { note, velocity, targets, cands, time, source, midiTs };
  }
}
