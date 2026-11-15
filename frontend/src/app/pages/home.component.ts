import { Component, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { GP_EXTENSIONS, GpFile, readGpFile } from '../core/gp-import';
import { enterFullscreen, exitFullscreen, isBrowserF11, isFullscreen } from '../core/fullscreen';
import { LANGS, Lang, lang, setLang, t } from '../core/i18n';
import { exportSong, importExported } from '../core/library-store';
import { SongSummary } from '../core/protocol';
import { SettingsService } from '../core/settings.service';
import { SongService, extractSongsterrUrl } from '../core/song.service';
import { MidiService } from '../platform/midi.service';
import { platformKind, saveFile } from '../platform/platform';
import { songsterrAvailable } from '../platform/songsterr';

@Component({
  selector: 'app-home',
  imports: [FormsModule, RouterLink],
  template: `
    <main class="page">
      <header class="brand">
        <h1><small>Open</small>Drum<span>Hero</span></h1>
        <div class="brand-tools">
          @if (isDesktop) {
            <!-- fullscreen: same button (logic and text) as the pause bar -->
            <button class="secondary lang-btn fs-btn" (click)="toggleFullscreen()">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="isFullscreen() ? fsIcons.exit : fsIcons.enter"/></svg>
              {{ isFullscreen() ? t('game.exitFullscreen') : t('home.fullscreen') }}
              <small>{{ isFullscreen() ? (isBrowserF11() ? 'F11' : 'Esc') : 'F11' }}</small>
            </button>
          }
          <div class="lang-pick">
            <button class="secondary lang-btn" (click)="langOpen.set(!langOpen())" [attr.aria-label]="t('home.language')" [title]="t('home.language')">
              <svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.6 9h16.8M3.6 15h16.8M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"/></svg>
              {{ langLabel() }} ▾
            </button>
            @if (langOpen()) {
              <div class="lang-menu">
                @for (l of langs; track l.id) {
                  <button [class.on]="lang() === l.id" (click)="pickLang(l.id)">{{ l.label }}</button>
                }
              </div>
            }
          </div>
          <a class="btn secondary gear-btn" routerLink="/settings" [attr.aria-label]="t('settings.title')" [title]="t('settings.title')">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" [attr.d]="gear"/></svg>
          </a>
        </div>
      </header>

      <section class="status">
        <div class="chip" [class.ok]="midi.status().connected" [class.bad]="!midi.status().connected">
          <i></i>{{ t('home.drum') }} {{ midi.status().connected ? midi.status().ports.join(', ') : t('home.drumNotFound') }}
          @if (!midi.status().connected) { <small>· {{ settings.device === 'mobile' ? t('home.noDrumHintMobile') : t('home.noDrumHintPc') }}</small> }
        </div>
        <div class="chip"><i></i>{{ settings.device === 'mobile' ? t('device.mobile') : t('device.pc') }}
          <small>{{ t('home.audioOffset', { ms: settings.dev.audioOffsetMs }) }}</small></div>
      </section>

      <section>
        <div class="lib-head">
          <h2>{{ t('common.library') }}</h2>
          <button class="primary import-btn" (click)="openImport()">＋ {{ t('import.title') }}</button>
        </div>
        @if (songs.jobs()[0]; as j) {
          <div class="job {{ j.state }}">
            <div class="bar"><i [style.width.%]="j.pct"></i></div>
            <span>{{ j.message }}</span>
          </div>
        }
        @if (error()) { <p class="err">{{ t('home.loadError', { msg: error()! }) }}</p> }
        @if (!library().length && !error()) {
          <p class="dim">{{ t('home.empty') }}</p>
        }
        <div class="grid">
          @for (s of library(); track s.id) {
            <div class="song-card">
              @if (s.isNew) { <em class="new">{{ t('home.new') }}</em> }
              <a class="song" [routerLink]="['/play', s.id]">
                <strong>{{ s.title }}</strong>
                <span>{{ s.artist }}</span>
                <small>
                  {{ fmt(s.durationMs) }} · {{ t('home.sections', { n: s.sections }) }}
                  @if (s.audio.includes('youtube')) { · {{ t('home.original') }} }
                  @if (best(s.id); as b) { · {{ t('home.best', { pct: b }) }} }
                </small>
              </a>
              <div class="card-tools">
                <button class="exp" [title]="t('home.exportTitle')" (click)="exportOne(s)">⇩</button>
                <button class="del" [title]="t('home.deleteTitle')" (click)="remove(s)">✕</button>
              </div>
            </div>
          }
        </div>
      </section>

      @if (importOpen()) {
        <div class="window-back" (click)="importOpen.set(false)"></div>
        <div class="window modal" role="dialog" [attr.aria-label]="t('import.title')">
          <header class="window-head">
            <h2>{{ t('import.title') }}</h2>
            <button class="close-x" (click)="importOpen.set(false)" [attr.aria-label]="t('common.close')" [title]="t('common.close')">✕</button>
          </header>
          <div class="tabs">
            <button class="secondary" [class.on]="importTab() === 'songsterr'" (click)="importTab.set('songsterr')">Songsterr</button>
            <button class="secondary" [class.on]="importTab() === 'gp'" (click)="importTab.set('gp')">{{ t('import.tabGp') }}</button>
            <button class="secondary" [class.on]="importTab() === 'file'" (click)="importTab.set('file')">{{ t('import.tabFile') }}</button>
          </div>

          @if (importTab() === 'songsterr') {
            @if (songsterrOk) {
              <p class="dim">{{ t('import.pasteLink') }}</p>
              <form (submit)="submit($event)">
                <input [(ngModel)]="link" name="link" placeholder="https://www.songsterr.com/a/wsa/...-s12345" autocomplete="off">
                <button class="primary" type="submit" [disabled]="!validLink()">{{ t('import.import') }}</button>
              </form>
            } @else {
              <p class="err">{{ t('import.songsterrAppOnly') }}</p>
            }
            <p class="note"><b>{{ t('import.plusRequired') }}</b> {{ t('import.plusExplain') }}</p>
            <div class="includes">
              <b>{{ t('import.comesWith') }}</b>
              <ul>
                <li>{{ t('import.incNotes') }}</li>
                <li>{{ t('import.incSynth') }}</li>
                <li>{{ t('import.incReal') }}<sup>*</sup></li>
                <li>{{ t('import.incRealNoDrums') }}<sup>*</sup></li>
                <li>{{ t('import.incLyrics') }}<sup>**</sup></li>
              </ul>
              <small><sup>*</sup> {{ t('import.noteVideo') }}<br>
                <sup>**</sup> {{ t('import.noteLyricsSongsterr') }}</small>
            </div>
          } @else if (importTab() === 'gp') {
            <label class="file">
              <input type="file" [accept]="gpExt" (change)="pickGp($event)">
              <span>{{ gpFile()?.fileName ?? t('import.chooseFile') }}</span>
            </label>
            @if (gpReading()) { <p class="dim">{{ t('import.reading') }}</p> }
            @if (gpFile(); as f) {
              @if (f.hasDrums) {
                <p class="ok-line">{{ t('import.drumsFound', { tracks: f.drumTracks.join(', ') }) }}</p>
              } @else {
                <p class="err">{{ t('import.noDrums') }}</p>
              }
              <form (submit)="importGp($event)" class="gp-form">
                <label class="field">{{ t('import.songName') }} *
                  <input [(ngModel)]="gpTitle" name="title" required autocomplete="off">
                </label>
                <label class="field">{{ t('import.artist') }} *
                  <input [(ngModel)]="gpArtist" name="artist" required autocomplete="off">
                </label>
                <button class="primary" type="submit" [disabled]="!f.hasDrums || !gpTitle.trim() || !gpArtist.trim() || busy()">
                  {{ busy() ? t('import.importing') : t('import.import') }}</button>
              </form>
            }
            <p class="dim">{{ t('import.gpExplain') }}</p>
            <div class="includes">
              <b>{{ t('import.comesWith') }}</b>
              <ul>
                <li>{{ t('import.incNotes') }}</li>
                <li>{{ t('import.incSynth') }}</li>
                <li>{{ t('import.incLyrics') }}<sup>*</sup></li>
              </ul>
              <small><sup>*</sup> {{ t('import.noteLyricsFile') }}<br>
                {{ t('import.noteRealAudio') }}</small>
            </div>
          } @else {
            <p class="dim">{{ t('import.fileExplain') }}</p>
            <label class="file">
              <input type="file" accept=".json,application/json" multiple (change)="pickExported($event)">
              <span>{{ t('import.chooseFiles') }}</span>
            </label>
          }
          @if (importError()) { <p class="err">{{ importError() }}</p> }
        </div>
      }
    </main>
  `,
  styleUrl: './pages.scss',
})
export class HomeComponent {
  readonly midi = inject(MidiService);
  readonly songs = inject(SongService);
  readonly settings = inject(SettingsService);
  readonly t = t;
  readonly lang = lang;
  readonly langs = LANGS;
  readonly langOpen = signal(false);
  readonly gear = GEAR;
  readonly library = signal<SongSummary[]>([]);
  readonly error = signal<string | null>(null);
  readonly songsterrOk = songsterrAvailable();
  readonly isDesktop = platformKind() !== 'android';
  readonly isFullscreen = isFullscreen;
  readonly isBrowserF11 = isBrowserF11;
  readonly fsIcons = { enter: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5', exit: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5' };
  toggleFullscreen(): void { if (isFullscreen()) exitFullscreen(); else enterFullscreen(); }
  link = '';
  readonly validLink = () => !!extractSongsterrUrl(this.link);
  readonly importOpen = signal(false);
  readonly importTab = signal<'songsterr' | 'gp' | 'file'>('songsterr');
  readonly gpExt = GP_EXTENSIONS;
  readonly gpFile = signal<GpFile | null>(null);
  readonly gpReading = signal(false);
  readonly busy = signal(false);
  readonly importError = signal<string | null>(null);
  gpTitle = '';
  gpArtist = '';

  constructor() {
    effect(() => {
      this.songs.libraryVersion();
      this.reload();
    });
  }

  reload(): void {
    this.songs.list().subscribe({
      next: l => { this.library.set(l); this.error.set(null); },
      error: e => this.error.set(e.message),
    });
  }

  langLabel(): string { return LANGS.find(l => l.id === lang())?.label ?? 'English'; }

  pickLang(l: Lang): void {
    setLang(l);
    this.langOpen.set(false);
  }

  openImport(): void {
    this.importError.set(null);
    this.importOpen.set(true);
  }

  submit(ev: Event): void {
    ev.preventDefault();
    const url = extractSongsterrUrl(this.link);
    if (url) {
      this.songs.ingest(url);
      this.link = '';
      this.importOpen.set(false);   // the progress shows in the library
    }
  }

  async pickGp(ev: Event): Promise<void> {
    const file = (ev.target as HTMLInputElement).files?.[0];
    this.gpFile.set(null);
    this.importError.set(null);
    if (!file) return;
    this.gpReading.set(true);
    try {
      const f = await readGpFile(file);
      this.gpFile.set(f);
      this.gpTitle = f.title;
      this.gpArtist = f.artist;
    } catch (e) {
      this.importError.set((e as Error).message);
    } finally {
      this.gpReading.set(false);
    }
  }

  async importGp(ev: Event): Promise<void> {
    ev.preventDefault();
    const f = this.gpFile();
    const title = this.gpTitle.trim(), artist = this.gpArtist.trim();
    if (!f || !f.hasDrums || !title || !artist) return;
    this.busy.set(true);
    this.importError.set(null);
    try {
      const id = await this.songs.importGp(f.gp, title, artist, f.fileName);
      this.gpFile.set(null);
      this.importOpen.set(false);
      this.songs.notify(t('import.importedOne', { title }), 'done', id);
    } catch (e) {
      this.importError.set(t('import.failed', { msg: (e as Error).message }));
    } finally {
      this.busy.set(false);
    }
  }

  async pickExported(ev: Event): Promise<void> {
    const files = Array.from((ev.target as HTMLInputElement).files ?? []);
    this.importError.set(null);
    let last = '';
    try {
      for (const f of files) last = await importExported(await f.text());
      this.songs.refreshLibrary();
      this.importOpen.set(false);
      if (last) this.songs.notify(t('import.importedMany', { n: files.length }), 'done', last);
    } catch (e) {
      this.importError.set((e as Error).message);
    }
  }

  async exportOne(s: SongSummary): Promise<void> {
    try {
      const where = await saveFile(`${s.id}.drumhero.json`, await exportSong(s.id));
      this.songs.notify(t('home.exported', { title: s.title, where }));
    } catch (e) {
      alert(t('home.exportFailed', { msg: (e as Error).message }));
    }
  }

  remove(s: SongSummary): void {
    if (!confirm(t('home.deleteConfirm', { title: s.title }))) return;
    this.songs.delete(s.id).subscribe({
      next: () => this.reload(),
      error: e => alert(t('home.deleteFailed', { msg: e.message })),
    });
  }

  best(id: string): number | null {
    const v = Number(localStorage.getItem(`drumhero.best.${id}`));
    return v ? Math.round(v * 100) : null;
  }

  fmt(ms: number): string {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
}

const GEAR = 'M19.14 12.94a7.07 7.07 0 0 0 .06-.94 7.07 7.07 0 0 0-.06-.94l2.03-1.58a.48.48 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.71 8.87a.48.48 0 0 0 .12.61l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.48.48 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z';
