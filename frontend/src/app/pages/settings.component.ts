import { Location } from '@angular/common';
import { Component, OnDestroy, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { InputService } from '../core/input.service';
import { t } from '../core/i18n';
import { COLOR_PALETTE } from '../core/lane-colors';
import { Lane, laneLabel } from '../core/protocol';
import { SettingsService } from '../core/settings.service';
import { platformKind } from '../platform/platform';
import { MediaClock } from '../game/media-clock';
import { instrumentIconUrl } from '../game/instrument-icon';
import { MidiService } from '../platform/midi.service';

const BPM = 100;
const BEAT = 60_000 / BPM;
const LEAD = 1000;
const COUNT_IN = 4;
const MEASURED = 16;

/**
 * Audio calibration: a metronome plays through the SAME path as the music
 * (<audio> element → headphone/Bluetooth output → drum module → headphones). You play the snare along;
 * the median error is the delay to compensate on this device.
 */
@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink],
  template: `
    <main class="page settings" [class.embedded]="embedded()">
      @if (!embedded()) {
        <header class="window-head page-head">
          <h2>{{ t('settings.title') }}</h2>
          <button class="close-x" (click)="back()" [attr.aria-label]="t('common.close')" [title]="t('common.close')">✕</button>
        </header>
      }

      <div class="sections">
        <!-- in the game: the "This song" card goes here -->
        <ng-content />

        <section class="card">
          <h2>{{ t('settings.audio') }}</h2>
          <div class="nudge">
            <span class="nudge-label">{{ t('settings.audioDelay') }}</span>
            <div class="nudge-ctl">
              <button class="secondary" (click)="nudge('audioOffsetMs', -10)">−10</button>
              <button class="secondary" (click)="nudge('audioOffsetMs', -1)">−1</button>
              <input type="number" [ngModel]="settings.dev.audioOffsetMs" (ngModelChange)="settings.updateDevice({ audioOffsetMs: +$event })" [attr.aria-label]="t('settings.audioDelay')">
              <button class="secondary" (click)="nudge('audioOffsetMs', 1)">+1</button>
              <button class="secondary" (click)="nudge('audioOffsetMs', 10)">+10</button>
              <small>ms</small>
            </div>
          </div>
          <p class="explain">{{ t('settings.audioDelayHelp') }}</p>
          <div class="btn-row">
            <button class="primary" (click)="openTest()">{{ t('settings.testDelay') }}</button>
          </div>
        </section>

        <section class="card">
          <h2>{{ t('settings.gameplay') }}</h2>
          <label class="check">
            <input type="checkbox" [ngModel]="settings.profile().strict" (ngModelChange)="settings.setStrict($event)">
            {{ t('settings.strict') }}
          </label>
          <p class="explain">{{ t('settings.strictHelp') }}</p>
          <label class="check">
            <input type="checkbox" [ngModel]="settings.profile().lyrics !== false" (ngModelChange)="settings.setLyrics($event)">
            {{ t('settings.lyrics') }}
          </label>
          <p class="explain">{{ t('settings.lyricsHelp') }}</p>
          <div class="nudge">
            <span class="nudge-label">{{ t('settings.hitWindow') }}</span>
            <div class="nudge-ctl">
              <button class="secondary" (click)="nudge('hitWindowMs', -5)">−5</button>
              <button class="secondary" (click)="nudge('hitWindowMs', -1)">−1</button>
              <input type="number" min="10" max="400" [ngModel]="settings.dev.hitWindowMs" (ngModelChange)="settings.updateDevice({ hitWindowMs: +$event })" [attr.aria-label]="t('settings.hitWindow')">
              <button class="secondary" (click)="nudge('hitWindowMs', 1)">+1</button>
              <button class="secondary" (click)="nudge('hitWindowMs', 5)">+5</button>
              <small>ms</small>
            </div>
          </div>
          <p class="explain">{{ t('settings.hitWindowHelp') }}</p>
          <div class="nudge">
            <span class="nudge-label">{{ t('settings.chordWindow') }}</span>
            <div class="nudge-ctl">
              <button class="secondary" (click)="nudge('chordWindowMs', -10)">−10</button>
              <button class="secondary" (click)="nudge('chordWindowMs', -1)">−1</button>
              <input type="number" min="0" max="400" [ngModel]="settings.dev.chordWindowMs" (ngModelChange)="settings.updateDevice({ chordWindowMs: +$event })" [attr.aria-label]="t('settings.chordWindow')">
              <button class="secondary" (click)="nudge('chordWindowMs', 1)">+1</button>
              <button class="secondary" (click)="nudge('chordWindowMs', 10)">+10</button>
              <small>ms</small>
            </div>
          </div>
          <p class="explain">{{ t('settings.chordWindowHelp') }}</p>
          <div class="nudge">
            <span class="nudge-label">{{ t('settings.earlyWindow') }}</span>
            <div class="nudge-ctl">
              <button class="secondary" (click)="nudge('earlyWindowMs', -10)">−10</button>
              <button class="secondary" (click)="nudge('earlyWindowMs', -1)">−1</button>
              <input type="number" min="0" max="400" [ngModel]="settings.dev.earlyWindowMs" (ngModelChange)="settings.updateDevice({ earlyWindowMs: +$event })" [attr.aria-label]="t('settings.earlyWindow')">
              <button class="secondary" (click)="nudge('earlyWindowMs', 1)">+1</button>
              <button class="secondary" (click)="nudge('earlyWindowMs', 10)">+10</button>
              <small>ms</small>
            </div>
          </div>
          <p class="explain">{{ t('settings.earlyWindowHelp') }}</p>
        </section>

        <section class="card">
          <h2>{{ t('settings.graphics') }}</h2>
          <label class="field">{{ t('settings.quality') }}
            <select [ngModel]="settings.dev.quality" (ngModelChange)="settings.updateDevice({ quality: $event })">
              <option value="high">{{ t('settings.qualityHigh') }}</option>
              <option value="low">{{ t('settings.qualityLow') }}</option>
            </select>
          </label>
          <label class="field">{{ t('settings.antialias') }}
            <select [ngModel]="settings.dev.antialias" (ngModelChange)="settings.updateDevice({ antialias: $event })">
              <option value="off">{{ t('settings.aaOff') }}</option>
              <option value="msaa">{{ t('settings.aaMsaa') }}</option>
              <option value="max">{{ t('settings.aaMax') }}</option>
            </select>
          </label>
          <p class="explain">{{ t('settings.antialiasHelp') }}</p>
          <label class="check">
            <input type="checkbox" [ngModel]="!!settings.dev.showFps" (ngModelChange)="settings.updateDevice({ showFps: $event })">
            {{ t('settings.showFps') }}
          </label>
          @if (isPc) {
            <!-- Windows' dynamic refresh rate keeps the browser at 60 Hz on high-refresh monitors: uneven frames -->
            <p class="explain">{{ t('settings.dynamicRefreshHelp') }}</p>
          }
        </section>

        <section class="card colors">
          <h2>{{ t('settings.colors') }}</h2>
          <div class="lane-list">
            @for (l of colorLanes; track l) {
              <button class="lane-pick" [class.on]="pickLane() === l" (click)="pickLane.set(l)" [style.--c]="settings.laneColors()[l]">
                <img [src]="iconFor(l)" alt="">
                <span>{{ laneLabel(l) }}</span>
                <i class="dot"></i>
              </button>
            }
          </div>
          <div class="palette" [attr.aria-label]="t('settings.colorsFor', { lane: laneLabel(pickLane()) })">
            @for (c of palette; track c) {
              <button class="swatch" [class.on]="settings.laneColors()[pickLane()] === c" [style.--c]="c"
                      (click)="settings.setLaneColor(pickLane(), c)" [title]="c"></button>
            }
            <label class="swatch custom" [title]="t('settings.customColor')">
              <input type="color" [ngModel]="settings.laneColors()[pickLane()]" (ngModelChange)="settings.setLaneColor(pickLane(), $event)">
              <span>+</span>
            </label>
          </div>
          <p class="explain">{{ t('settings.colorsHelp') }}</p>
          <div class="btn-row">
            <button class="secondary" (click)="settings.resetLaneColors()">{{ t('settings.colorsReset') }}</button>
          </div>
        </section>

        <section class="card">
          <h2>{{ t('settings.device') }}</h2>
          <p class="explain">{{ t('settings.deviceHelp', { device: settings.device === 'mobile' ? t('device.mobile') : t('device.pc') }) }}</p>
          <p class="drum-line"><b>{{ t('settings.drum') }}:</b>
            {{ midi.status().connected ? midi.status().ports.join(', ') : t('settings.drumNotConnected') }}</p>
          @if (settings.device === 'pc') { <p class="explain">{{ t('settings.keyboardHelp') }}</p> }
          <div class="btn-row">
            <a class="btn secondary" routerLink="/kit">{{ t('settings.mapDrum') }}</a>
          </div>
        </section>
      </div>

      @if (testOpen()) {
        <div class="window-back" (click)="closeTest()"></div>
        <section class="window test-window" role="dialog" [attr.aria-label]="t('settings.testDelay')">
          <header class="window-head">
            <h2>{{ t('settings.testDelay') }}</h2>
            <button class="close-x" (click)="closeTest()" [attr.aria-label]="t('common.close')" [title]="t('common.close')">✕</button>
          </header>
          <p class="explain">{{ t('calib.explain', { n: measured }) }}</p>
          <div class="pulse" [class.on]="pulse()" (pointerdown)="tap($event)" [title]="t('calib.tapHere')"></div>
          <div class="btn-row center">
            <button class="primary" (click)="start()" [disabled]="running()">{{ running() ? t('calib.listening') : t('calib.start') }}</button>
            <span class="dim">{{ t('calib.valid', { n: deltas().length, total: measured }) }}</span>
          </div>
          @if (result() !== null) {
            <div class="btn-row center">
              <span>{{ t('calib.result', { ms: result()!, spread: spread() }) }}</span>
              <button class="primary" (click)="apply()">{{ t('calib.use') }}</button>
            </div>
            @if (spread() > 25) { <p class="warn">{{ t('calib.highSpread') }}</p> }
          }
          <p class="dim center-text">{{ t('calib.current', { ms: settings.dev.audioOffsetMs }) }}</p>
        </section>
      }
    </main>
  `,
  styleUrl: './pages.scss',
})
export class SettingsComponent implements OnDestroy {
  /** PC (exe or browser): Windows tips. */
  readonly isPc = platformKind() !== 'android';
  readonly settings = inject(SettingsService);
  readonly midi = inject(MidiService);
  private input = inject(InputService);
  readonly t = t;
  readonly laneLabel = laneLabel;
  readonly palette = COLOR_PALETTE;
  /** Order of the pieces on the Colors screen (cymbals, hi-hat, drums, kick). */
  readonly colorLanes: Lane[] = ['crash', 'crash2', 'ride', 'hihat', 'snare', 'tom1', 'tom2', 'floor', 'kick'];
  readonly pickLane = signal<Lane>('crash');
  /** Window on top of everything with the audio delay test (dot + clicks). */
  readonly testOpen = signal(false);
  private iconCache = new Map<string, string>();
  private location = inject(Location);
  private router = inject(Router);
  /** Inside the game's Settings window (no page header). */
  readonly embedded = input(false);

  /** Goes back to the previous screen (the game, if it came from there); without history, goes to the library. */
  back(): void {
    if (history.length > 1) this.location.back();
    else void this.router.navigateByUrl('/');
  }
  readonly measured = MEASURED;
  readonly running = signal(false);
  readonly pulse = signal(false);
  readonly deltas = signal<number[]>([]);
  readonly result = signal<number | null>(null);
  readonly spread = signal(0);
  private clock?: MediaClock;
  private url?: string;
  private sub?: Subscription;
  private raf = 0;

  async start(): Promise<void> {
    this.stop();
    this.deltas.set([]);
    this.result.set(null);
    this.url = URL.createObjectURL(clickTrack());
    const clock = new MediaClock(this.url);
    this.clock = clock;
    await clock.load();
    const clicks = Array.from({ length: MEASURED }, (_, i) => LEAD + (COUNT_IN + i) * BEAT);
    this.sub = this.input.hits$.subscribe(h => {
      if (h.source === 'bot') return;
      const t = clock.mediaAt(h.time);
      const nearest = clicks.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
      const d = t - nearest;
      if (Math.abs(d) < 300) this.deltas.update(x => [...x, d]);
    });
    clock.onEnded = () => this.finish();
    this.running.set(true);
    await clock.play();
    const loop = (perf: number) => {
      this.raf = requestAnimationFrame(loop);
      clock.tick(perf);
      const t = clock.mediaAt(perf - this.settings.dev.audioOffsetMs) - LEAD;
      this.pulse.set(t >= 0 && t % BEAT < 120);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Without the drum kit: tapping the circle counts as a hit. */
  tap(ev: Event): void {
    ev.preventDefault();
    if (this.running()) this.input.emit(38, 100, 'sim');
  }

  /** Piece icon like the highway one, in the chosen color. */
  iconFor(lane: Lane): string {
    const color = this.settings.laneColors()[lane];
    const key = `${lane}${color}`;
    let url = this.iconCache.get(key);
    if (!url) { url = instrumentIconUrl(lane, color); this.iconCache.set(key, url); }
    return url;
  }

  openTest(): void {
    this.result.set(null);
    this.deltas.set([]);
    this.testOpen.set(true);
  }

  closeTest(): void {
    this.stop();
    this.testOpen.set(false);
  }

  /** Fine adjustment: adds `ms` to the given value. */
  nudge(key: 'audioOffsetMs' | 'hitWindowMs' | 'chordWindowMs' | 'earlyWindowMs', ms: number): void {
    this.settings.updateDevice({ [key]: this.settings.dev[key] + ms });
  }

  apply(): void {
    const r = this.result();
    if (r !== null) this.settings.updateDevice({ audioOffsetMs: r });
  }

  ngOnDestroy(): void { this.stop(); }

  private finish(): void {
    const d = [...this.deltas()].sort((a, b) => a - b);
    if (d.length >= 4) {
      const med = d[Math.floor(d.length / 2)];
      this.result.set(Math.round(med));
      const q1 = d[Math.floor(d.length * 0.25)], q3 = d[Math.floor(d.length * 0.75)];
      this.spread.set(Math.round((q3 - q1) / 2));
    }
    this.stop();
  }

  private stop(): void {
    cancelAnimationFrame(this.raf);
    this.sub?.unsubscribe();
    this.clock?.dispose();
    this.clock = undefined;
    if (this.url) URL.revokeObjectURL(this.url);
    this.running.set(false);
    this.pulse.set(false);
  }
}

/** Generates a WAV with clicks (high-pitched count-in + measured clicks). */
function clickTrack(): Blob {
  const sr = 44100;
  const total = LEAD + (COUNT_IN + MEASURED) * BEAT + 1000;
  const n = Math.ceil((total / 1000) * sr);
  const pcm = new Int16Array(n);
  for (let k = 0; k < COUNT_IN + MEASURED; k++) {
    const start = Math.round(((LEAD + k * BEAT) / 1000) * sr);
    const freq = k < COUNT_IN ? 2000 : 1300;
    for (let i = 0; i < sr * 0.04 && start + i < n; i++) {
      pcm[start + i] = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * Math.exp(-i / (sr * 0.008)) * 30000);
    }
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}
