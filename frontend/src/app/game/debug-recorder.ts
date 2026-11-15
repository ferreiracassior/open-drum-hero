import type { PlayNote } from './chart';
import type { Cand } from './scoring';

/** Debug file format: everything needed to replay the session in the engine. */
export const DEBUG_FORMAT = 'drumhero-debug-v1';

export interface LiveResult { j: string; noteId: number | null; deltaMs?: number; }

export interface DebugHit {
  k: 'hit';
  seq: number;
  at: number;                 // performance.now() (device) when the hit arrived
  source: string;             // drum | sim | keyboard | bot
  midiTs: number | null;      // original PC timestamp (ms, server clock), unconverted
  note: number | null;        // MIDI number of the note
  velocity: number | null;
  cands: Cand[];              // commands used for judging (already with the crash expansion)
  chartT: number;             // chart time used for judging
  nowChart: number;           // where the song was when the hit arrived
  playing: boolean;           // the song clock was playing (false = frozen position)
  audioOffsetMs: number;      // audio delay used for this hit
  near: { id: number; t: number; lane: string; art: string; status: string }[];   // nearby notes, before the hit
  live: LiveResult[];         // live result ('blocked' = no note accepted it)
}

export type DebugEvent =
  | { k: 'notes'; at: number; from: number | null; notes: PlayNote[] }
  | { k: 'reset'; at: number }
  | { k: 'seek'; at: number; t: number }
  | { k: 'range'; at: number; start: number; end: number }
  | { k: 'tick'; at: number; now: number }
  | { k: 'miss'; at: number; noteId: number; t: number; lane: string }
  | DebugHit
  | { k: 'end'; at: number };

/** Keeps events in memory during a song in debug mode. */
export class DebugRecorder {
  active = false;
  private meta: Record<string, unknown> = {};
  private events: DebugEvent[] = [];
  private seq = 0;

  start(meta: Record<string, unknown>): void {
    this.meta = meta;
    this.events = [];
    this.seq = 0;
    this.active = true;
  }

  clear(): void {
    this.active = false;
    this.events = [];
    this.seq = 0;
  }

  push(e: DebugEvent): void {
    if (this.active) this.events.push(e);
  }

  hit(h: Omit<DebugHit, 'k' | 'seq'>): void {
    this.push({ k: 'hit', seq: ++this.seq, ...h });
  }

  dump(at: number): { format: string; meta: Record<string, unknown>; events: DebugEvent[] } {
    return { format: DEBUG_FORMAT, meta: this.meta, events: [...this.events, { k: 'end', at }] };
  }
}
