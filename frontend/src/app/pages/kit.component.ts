import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { InputService, keyLabel } from '../core/input.service';
import { StringKey, t } from '../core/i18n';
import { LANE_COLOR } from '../core/lane-colors';
import { Lane, laneLabel } from '../core/protocol';
import { KitTarget, SettingsService } from '../core/settings.service';
import { MidiService } from '../platform/midi.service';

/** Mapping piece: name (text key or piece), color and zones (center/rim or a single note). */
interface Piece { id: KitTarget; lane?: Lane; labelKey?: StringKey; colorLane?: Lane; color?: string; zones: StringKey[]; }

const ONE: StringKey[] = ['kit.zoneNote'];                     // piece with a single note
const CYM: StringKey[] = ['kit.zoneCenter', 'kit.zoneEdge'];   // crash and ride cymbals: center and edge (dual zone)

/** All the functions the app recognizes. A drum kit note can be learned on more than one piece. */
const PIECES: Piece[] = [
  { id: 'crash', lane: 'crash', zones: CYM },
  { id: 'crash2', lane: 'crash2', zones: CYM },
  { id: 'ride', lane: 'ride', zones: CYM },
  { id: 'hihat', labelKey: 'kit.hhClosed', colorLane: 'hihat', zones: ONE },
  { id: 'hihat_half', labelKey: 'kit.hhHalf', colorLane: 'hihat', zones: ONE },
  { id: 'hihat_open', labelKey: 'kit.hhOpen', colorLane: 'hihat', zones: ONE },
  { id: 'hihat_pedal', labelKey: 'kit.hhPedal', color: '#8a93a6', zones: ONE },
  { id: 'snare', lane: 'snare', zones: ONE },
  { id: 'tom1', lane: 'tom1', zones: ONE },
  { id: 'tom2', lane: 'tom2', zones: ONE },
  { id: 'floor', lane: 'floor', zones: ONE },
  { id: 'kick', lane: 'kick', zones: ONE },
  { id: 'ignore', labelKey: 'kit.ignore', color: '#555', zones: [] },
];

const pieceLabel = (p: Piece) => (p.lane ? laneLabel(p.lane) : t(p.labelKey!));
const pieceColor = (p: Piece) => p.color ?? LANE_COLOR[p.lane ?? p.colorLane!];

/** Learn mode: pick the zone and hit the pad. The same hit can be learned on other pieces too. */
@Component({
  selector: 'app-kit',
  imports: [FormsModule],
  template: `
    <main class="page kit-page">
      <header class="window-head page-head">
        <h2>{{ t('kit.title') }}</h2>
        <button class="close-x" (click)="back()" [attr.aria-label]="t('common.close')" [title]="t('common.close')">✕</button>
      </header>
      <p class="explain">
        {{ isPc ? t('kit.explainPc') : t('kit.explain') }}
        <b>{{ t('settings.drum') }}: {{ midi.status().connected ? midi.status().ports.join(', ') : (midi.status().error ?? t('kit.notConnected')) }}</b>
      </p>

      <div class="last" [style.--c]="lastColor()">
        @if (input.lastHit(); as h) {
          <b>{{ h.key ? t('kit.key', { key: keyName(h.key) }) : t('kit.note', { n: h.note }) }}</b>
          <span>{{ h.key ? '' : 'vel ' + h.velocity + ' · ' }}{{ labelsOf(h.targets) }}</span>
        } @else { <span>{{ isPc ? t('kit.hitAPadOrKey') : t('kit.hitAPad') }}</span> }
      </div>

      <div class="kit-grid">
        @for (p of targets; track p.id) {
          <section class="piece" [style.--c]="color(p)" [class.learning]="learning()?.startsWith(p.id + ':')">
            <h3>{{ label(p) }}</h3>
            @for (z of p.zones; track z; let zi = $index) {
              <div class="zone">
                <span class="zn">{{ t(z) }}</span>
                <span class="vals">
                  @if (slotNote(p.id, zi); as n) {
                    <span class="chip-note">{{ n }} <button (click)="settings.removeTarget(+n, p.id)" [title]="t('kit.remove')">×</button></span>
                  } @else { <span class="empty">—</span> }
                </span>
                <button class="secondary learn" [class.on]="learning() === p.id + ':' + zi" (click)="learn(p.id, zi)">
                  {{ learning() === p.id + ':' + zi ? t('kit.hitPad') : t('kit.learn') }}</button>
              </div>
            }
            @if (extraNotes(p).length) {
              <div class="zone">
                <span class="zn">{{ t('kit.extra') }}</span>
                <span class="vals">
                  @for (n of extraNotes(p); track n) {
                    <span class="chip-note">{{ n }} <button (click)="settings.removeTarget(+n, p.id)" [title]="t('kit.remove')">×</button></span>
                  }
                </span>
                <span></span>
              </div>
            }
            @if (isPc && p.id !== 'ignore') {
              <div class="zone">
                <span class="zn">{{ t('kit.keyboard') }}</span>
                <span class="vals">
                  @for (k of keysFor(p.id); track k) {
                    <span class="chip-note key">{{ keyName(k) }} <button (click)="settings.removeKeyTarget(k, p.id)" [title]="t('kit.remove')">×</button></span>
                  } @empty { <span class="empty">—</span> }
                </span>
                <button class="secondary learn" [class.on]="learning() === p.id + ':key'" (click)="learnKey(p.id)">
                  {{ learning() === p.id + ':key' ? t('kit.pressKey') : t('kit.learnKey') }}</button>
              </div>
            }
          </section>
        }
      </div>

      <p class="explain">{{ t('kit.twoCrashesHelp') }}</p>

      <div class="btn-row">
        <button class="secondary" (click)="settings.resetKit()">{{ t('kit.reset') }}</button>
      </div>
    </main>
  `,
  styleUrl: './pages.scss',
})
export class KitComponent implements OnDestroy {
  readonly midi = inject(MidiService);
  readonly input = inject(InputService);
  readonly settings = inject(SettingsService);
  private location = inject(Location);
  private router = inject(Router);
  readonly t = t;
  readonly targets = PIECES;
  readonly label = pieceLabel;
  readonly color = pieceColor;
  readonly keyName = keyLabel;
  /** Keyboard keys only apply on the PC. */
  readonly isPc = this.settings.device === 'pc';
  readonly learning = signal<string | null>(null);   // "piece:zone" waiting for a pad
  readonly lastColor = computed(() => {
    const first = this.input.lastHit()?.targets[0];
    const p = PIECES.find(x => x.id === first);
    return p ? pieceColor(p) : '#555';
  });
  private sub?: Subscription;

  /** Notes that trigger the piece, in ascending order. */
  notesFor(id: KitTarget): string[] {
    return Object.entries(this.settings.profile().kit).filter(([, ts]) => ts.includes(id)).map(([n]) => n)
      .sort((a, b) => +a - +b);
  }

  slotNote(id: KitTarget, zone: number): string | undefined {
    return this.notesFor(id)[zone];
  }

  /** Notes that don't fit the piece's zones (e.g. extra ones, or the "ignore" piece). */
  extraNotes(t: Piece): string[] {
    return this.notesFor(t.id).slice(t.zones.length);
  }

  /** PC keys that trigger the piece. */
  keysFor(id: KitTarget): string[] {
    return Object.entries(this.settings.keys()).filter(([, ts]) => ts.includes(id)).map(([k]) => k);
  }

  /** Learn key: the next key pressed starts triggering the piece. */
  learnKey(id: KitTarget): void {
    this.sub?.unsubscribe();
    const key = `${id}:key`;
    if (this.learning() === key) { this.learning.set(null); return; }
    this.learning.set(key);
    this.sub = this.input.keys$.subscribe(code => {
      if (code === 'Escape') { this.learning.set(null); this.sub?.unsubscribe(); return; }
      this.settings.setKey(code, id);
      this.learning.set(null);
      this.sub?.unsubscribe();
    });
  }

  /** Goes back to the previous screen (Settings); without history, goes to the library. */
  back(): void {
    if (history.length > 1) this.location.back();
    else void this.router.navigateByUrl('/');
  }

  targetLabel(id: KitTarget): string {
    const p = PIECES.find(x => x.id === id);
    return p ? pieceLabel(p) : id;
  }

  labelsOf(ts: KitTarget[]): string {
    return ts.length ? ts.map(x => this.targetLabel(x)).join(' + ') : t('kit.unmapped');
  }

  learn(id: KitTarget, zone: number): void {
    this.sub?.unsubscribe();
    const key = `${id}:${zone}`;
    if (this.learning() === key) { this.learning.set(null); return; }
    const old = this.slotNote(id, zone);   // the note that was in this zone no longer counts for the piece
    this.learning.set(key);
    this.sub = this.input.hits$.subscribe(h => {
      if (h.source === 'bot' || h.source === 'keyboard') return;   // the zone learns hits from the drum kit
      if (old !== undefined) this.settings.removeTarget(+old, id);
      this.settings.setKit(h.note, id);
      this.learning.set(null);
      this.sub?.unsubscribe();
    });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
