import { Component, ElementRef, Injector, OnDestroy, OnInit, afterEveryRender, afterNextRender, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { Subscription, firstValueFrom } from 'rxjs';
import { InputService } from '../core/input.service';
import { LANES, Lane, YoutubeSource, laneLabel } from '../core/protocol';
import { StringKey, t } from '../core/i18n';
import { SettingsService } from '../core/settings.service';
import { SongService } from '../core/song.service';
import { MidiService } from '../platform/midi.service';
import { VirtualDrummer } from '../game/bot';
import { Chart, MAX_LEVEL, PlayNote, buildChart, notesForLevels } from '../game/chart';
import { AudioLevels, Highway } from '../game/highway';
import { AudioAnalysis } from '../game/audio-analysis';
import { LyricLine, buildLyricLines, lyricLineAt } from '../game/lyrics';
import { MediaClock } from '../game/media-clock';
import { SynthAudio, renderSynth } from '../game/synth-render';
import { platformKind, saveFile } from '../platform/platform';
import { enterFullscreen, exitFullscreen, isBrowserF11, isFullscreen } from '../core/fullscreen';
import { GameClock, YouTubeClock } from '../game/youtube-clock';
import { Cand, HhArt, Judgement, ScoreEngine, Stats, accuracy, meanStd, multiplier } from '../game/scoring';
import { DebugRecorder, LiveResult } from '../game/debug-recorder';
import { ScoreView } from '../game/score-view';
import { BarRect, layoutBar } from '../game/bar-layout';
import { SettingsComponent } from './settings.component';

export type ViewMode = 'highway' | 'score';
const VIEW_KEY = 'drumhero.view';

/** Where the hit came from, for the debug log. */
interface DebugSrc { source: string; note: number | null; velocity: number | null; midiTs: number | null; at: number; }

type LevelMode = 'auto' | number;
export type AudioSource = 'synth' | 'full' | 'nodrums';

interface Popup { id: number; text: Judgement; lane: Lane; delta?: number; pedal?: boolean; }
interface PassResult { acc: number; rate: number; }


@Component({
  selector: 'app-game',
  imports: [FormsModule, RouterLink, SettingsComponent],
  templateUrl: './game.component.html',
  styleUrl: './game.component.scss',
})
export class GameComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private songs = inject(SongService);
  private input = inject(InputService);
  readonly settings = inject(SettingsService);
  readonly midi = inject(MidiService);
  private injector = inject(Injector);

  readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly scoreCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('score');
  /**
   * WebGL anti-aliasing is chosen when the context is created and doesn't change afterwards:
   * changing the setting recreates both canvases (and the highways) with the new configuration.
   */
  readonly gfxKeys = signal([0]);
  /** Performance meter (Settings → Show FPS meter). */
  readonly fpsText = signal('');
  private fpsWin = { start: 0, frames: 0, worst: 0, js: 0, jsWorst: 0, last: 0 };
  /** On the score, the section name sits in the left corner: the lyrics/scoreboard start after the longest name. */
  private readonly sectionLabelW = signal(0);
  readonly leftPos = computed(() => {
    const w = this.sectionLabelW();
    return this.view() === 'score' && w ? `max(calc(3% + 44px), ${Math.min(w + 36, 380)}px)` : null;
  });
  private gfxSig = '';
  private readonly gfxSettings = effect(() => {
    const d = this.settings.dev;
    const sig = `${d.quality}/${d.antialias}`;
    untracked(() => {
      if (!this.highway || sig === this.gfxSig) return;
      this.rebuildViews();
    });
  });
  /** 3D highway or horizontal score (switches instantly, without pausing). */
  readonly view = signal<ViewMode>(readView());
  readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');
  readonly ytHost = viewChild.required<ElementRef<HTMLElement>>('ytHost');

  // screen state
  readonly loading = signal(true);
  readonly loadingMsg = signal(t('game.loading'));
  /** Synthetic audio generated from the MIDI (alphaTab), in memory while the song is open. */
  private synthAudio?: SynthAudio;
  readonly error = signal<string | null>(null);
  readonly chart = signal<Chart | null>(null);
  readonly playing = signal(false);
  readonly rate = signal(1);
  readonly levelMode = signal<LevelMode>(5);
  readonly levels = signal<Record<string, number>>({});
  readonly loopOn = signal(false);
  readonly loopFrom = signal(0);
  readonly loopTo = signal(0);
  readonly autoSpeed = signal(true);
  readonly botOn = signal(false);
  readonly menuOpen = signal(false);   // Settings window
  readonly riffOpen = signal(false);   // Riff Repeater window
  readonly levelMenu = signal(false);
  /** Settings changed in the Settings window apply right away (tolerances and strict mode). */
  private readonly liveSettings = effect(() => {
    const d = this.settings.dev;
    this.engine.configure(d.hitWindowMs, d.chordWindowMs, d.earlyWindowMs);
    this.engine.strict = this.settings.profile().strict;
  });
  readonly hud = signal<Stats | null>(null);
  readonly passHud = signal<Stats | null>(null);
  readonly progress = signal(0);
  readonly currentSection = signal(0);
  readonly popups = signal<Popup[]>([]);
  readonly passes = signal<PassResult[]>([]);
  readonly results = signal<Stats | null>(null);
  readonly best = signal<number | null>(null);
  /** The run that just ended beat the high score: the previous one (null = first score of the song). */
  readonly newRecord = signal<{ previous: number | null } | null>(null);
  readonly trackIndex = signal(0);
  readonly audioSource = signal<AudioSource>('synth');
  readonly sourceLoading = signal(false);
  readonly sourceError = signal<string | null>(null);
  /** YouTube videos that failed during this opening of the song (not retried). */
  private failedVideos = new Set<string>();
  readonly showVideo = signal(true);
  readonly srcMenu = signal(false);
  readonly rateMenu = signal(false);
  readonly sizeMenu = signal(false);
  readonly trackMenu = signal(false);
  /** Track speed and note size: one value for the highway and another for the score. */
  readonly trackScroll = computed(() => {
    const d = this.settings.dev;
    return this.view() === 'score' ? d.scoreScrollSpeed ?? d.scrollSpeed : d.scrollSpeed;
  });
  readonly noteScale = computed(() => {
    const d = this.settings.dev;
    return (this.view() === 'score' ? d.scoreNoteScale : d.noteScale) ?? 1;
  });
  readonly scaleOptions = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];
  readonly trackSpeedOptions = [0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.5];
  readonly icons = ICONS;
  /** PC: fullscreen button in the pause bar (Windows makes the game less smooth outside fullscreen) */
  readonly isDesktop = platformKind() !== 'android';
  readonly isFullscreen = isFullscreen;
  readonly isBrowserF11 = isBrowserF11;
  toggleFullscreen(): void { if (isFullscreen()) exitFullscreen(); else enterFullscreen(); }
  /** Picked a point in the song (timeline/score) with the game paused: the next play is immediate. */
  private seekedWhilePaused = false;
  readonly lyricLines = signal<LyricLine[]>([]);
  /** Karaoke: on/off in Settings → Gameplay (on by default); without lyrics, nothing changes. */
  readonly showLyrics = computed(() => this.settings.profile().lyrics !== false && this.lyricLines().length > 0);
  /** YouTube video being built: the player has to exist visible and at real size (YouTube refuses a hidden player). */
  readonly ytLoading = signal(false);
  readonly lyricIndex = signal(-1);
  readonly lyricNow = signal(0);

  readonly accuracyPct = computed(() => Math.round(accuracy(this.hud() ?? { weight: 0, judged: 0 }) * 100));
  readonly mult = computed(() => multiplier(this.hud()?.streak ?? 0));
  readonly sections = computed(() => this.chart()?.sections ?? []);
  /** On-screen pads: phone without the drum kit connected, during the game. */
  /** Paused (neither playing nor counting down): only then does the bottom bar show all the buttons. */
  readonly paused = computed(() => !this.playing() && this.countdown() === null);
  readonly t = t;
  readonly laneLabel = laneLabel;
  readonly laneColor = computed(() => this.settings.laneColors());
  /** Piece colors changed in Settings: the highways redo what is drawn only once. */
  private readonly colorRefresh = effect(() => {
    this.settings.colorsVersion();
    untracked(() => this.highway?.refreshColors());
  });
  readonly lanes = LANES;
  /** Score legend: pieces by intensity; cymbals are X, drums are dots. */
  readonly legendLanes: Lane[] = ['crash', 'crash2', 'ride', 'hihat', 'snare', 'tom1', 'tom2', 'floor', 'kick'];
  readonly cymbalLanes = new Set<Lane>(['crash', 'crash2', 'ride', 'hihat']);
  readonly maxLevel = MAX_LEVEL;
  readonly levelOptions = [1, 2, 3, 4, 5];
  readonly speeds = Array.from({ length: 16 }, (_, i) => (25 + i * 5) / 100);
  /** Speeds the current source accepts (null = all of them: the synthesized audio plays at any speed). */
  private readonly clockRates = signal<number[] | null>(null);
  /** Speed menu: on YouTube only the speeds it supports for the video are shown. */
  readonly rateOptions = computed(() => {
    const ok = this.clockRates();
    if (!ok) return this.speeds;
    const list = this.speeds.filter(s => ok.some(r => Math.abs(r - s) < 0.001));
    return list.length ? list : [1];
  });
  readonly sourceKinds: AudioSource[] = ['synth', 'full', 'nodrums'];

  private engine = new ScoreEngine();
  private audioLevels: AudioLevels = { bass: 0, mid: 0, high: 0, spectrum: new Float32Array(48) };
  private clock?: GameClock;
  private analysis?: AudioAnalysis;
  private highway?: Highway;
  private score?: ScoreView;
  private active: PlayNote[] = [];
  private bot = new VirtualDrummer((note, t) => this.judge([{ lane: note.lane, hh: note.lane === 'hihat' ? hhArtOfNote(note.art) : undefined }], t, true));
  private raf = 0;

  // ---- bottom bar layout (rows that grow upwards when the screen is narrow; see game/bar-layout.ts)
  readonly barRowsEl = viewChild<ElementRef<HTMLElement>>('barRowsEl');
  readonly fsBtn = viewChild<ElementRef<HTMLElement>>('fsBtn');
  private readonly hasRestart = computed(() => !this.results() && this.progress() > 0);
  readonly barRows = signal<string[][]>(this.baseBarRows());
  /** Fullscreen button position (from the right / bottom of the stage). */
  readonly barFs = signal<{ right: number; bottom: number } | null>(null);
  private readonly barWidths: Record<string, number> = {};
  private barRaf = 0;
  private readonly barObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.scheduleBar()) : null;
  /** The bar is laid out again when something that changes its space changes (sizes: the observer). */
  private readonly barEffect = effect(() => {
    this.view(); this.audioSource(); this.showVideo(); this.ytLoading(); this.paused(); this.hasRestart(); isFullscreen();
    this.scheduleBar();
  });
  private readonly barRender = afterEveryRender(() => this.observeBar());
  readonly debugOn = signal(false);
  readonly debugMsg = signal<string | null>(null);
  /** Countdown before playing (4, 3, 2, 1). */
  readonly countdown = signal<number | null>(null);
  private countdownTimer?: ReturnType<typeof setTimeout>;
  /** Countdown: the track already moves up to `from`, where the audio starts at `startPerf` (performance.now()). */
  /**
   * `clockStarts`: the source starts itself at `startPerf` (YouTube's muted run-up, startAt) instead of play();
   * `follow`: the run-up is moving and the track already follows the source's clock.
   */
  private preroll: { from: number; startPerf: number; clockStarts: boolean; follow: boolean } | null = null;
  /** Difference between the countdown and the audio when it actually starts; fades away gradually (no jump). */
  private slew = { ms: 0, at: 0 };
  private lastSlewPerf = 0;
  /** Right after the sound starts: sum of the start error to learn the audio's real latency. */
  private startWatch: { until: number; err: number } | null = null;
  /** How long the audio takes between play and actually playing (learned on every countdown, per source). */
  private startLag = readStartLag();
  private playTimer?: ReturnType<typeof setTimeout>;
  /** Between telling the audio to play and the game marking "playing" (the audio may start before the await returns). */
  private starting = false;
  private lastRaw = 0;
  private lastRawPerf = 0;   // to notice abrupt corrections of the audio clock and absorb them
  private recorder = new DebugRecorder();
  private subs: Subscription[] = [];
  private popupId = 0;
  private sectionSnapshot = { weight: 0, judged: 0 };
  private lastHudUpdate = 0;
  private ended = false;
  private wakeLock?: WakeLockSentinel;

  async ngOnInit(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id')!;
    try {
      const song = await firstValueFrom(this.songs.get(id));
      if (!song.audio.synth && !song.audio.youtube?.length) throw new Error(t('game.noAudio'));
      const chart = buildChart(song, 0);
      this.songs.markPlayed(id);
      this.chart.set(chart);
      this.lyricLines.set(buildLyricLines(song.lyrics));
      this.loopTo.set(chart.sections.length - 1);
      this.best.set(Number(localStorage.getItem(`drumhero.best.${id}`)) || null);
      this.createViews();
      this.applyLevels();
      if (song.audio.synth) {
        const file = song.audio.synth.file;
        if (/\.midi?$/i.test(file)) {
          // generates the MIDI sound in the app itself (1st time: a few seconds; afterwards it comes from the cache)
          try {
            this.synthAudio = await renderSynth(id, await this.songs.readFile(id, file),
              p => this.loadingMsg.set(t('game.renderingSynth', { pct: Math.round(p * 100) })));
            this.analysis = this.synthAudio.analysis;
          } catch (e) {
            if (!song.audio.youtube?.length) throw e;
            this.sourceError.set(t('game.synthFailed', { msg: (e as Error).message }));
          }
        }
      }
      // the last chosen audio (if this song has it); otherwise the synthetic one
      const pref = readSourcePref();
      await this.setSource(pref && this.hasSource(pref) ? pref : this.hasSource('synth') ? 'synth' : 'full');
      this.loading.set(false);
      this.subs.push(this.input.laneHits$.subscribe(h => {
        if (!this.clock) return;
        this.judge(h.cands, this.timeAt(h.time - this.settings.dev.audioOffsetMs), false,
        { source: h.source, note: h.note, velocity: h.velocity, midiTs: h.midiTs, at: h.time });
      }));
      this.raf = requestAnimationFrame(this.frame);
      // app minimized/in the background (phone or PC): pause, so nothing keeps playing hidden
      document.addEventListener('visibilitychange', this.onHidden);
      // picked the song: start right away (4-3-2-1 countdown), without waiting for play
      void this.togglePlay();
    } catch (e) {
      this.error.set((e as Error).message);
      this.loading.set(false);
    }
  }

  private createViews(): void {
    const d = this.settings.dev;
    this.gfxSig = `${d.quality}/${d.antialias}`;
    this.highway = new Highway(this.canvas().nativeElement, d.quality, d.antialias);
    this.score = new ScoreView(this.scoreCanvas().nativeElement, d.antialias);
    this.score.onLabelWidth = w => this.sectionLabelW.set(w);
  }

  /** Recreates highway and score on new canvases (quality/anti-aliasing changed), without touching the score. */
  private rebuildViews(): void {
    this.highway?.dispose();
    this.score?.dispose();
    this.highway = undefined;
    this.score = undefined;
    this.gfxKeys.update(([k]) => [k + 1]);
    afterNextRender(() => {
      if (this.highway) return;
      this.createViews();
      const chart = this.chart();
      if (!chart) return;
      this.highway!.setChart(this.active, chart.beats, chart.sections, id => this.engine.statusOf(id));
      this.score!.setChart(this.active, chart.beats, chart.sections, id => this.engine.statusOf(id));
    }, { injector: this.injector });
  }

  private onHidden = (): void => {
    if (document.hidden && !this.paused()) void this.togglePlay();
  };

  ngOnDestroy(): void {
    this.barObserver?.disconnect();
    this.barRender.destroy();
    cancelAnimationFrame(this.barRaf);
    document.removeEventListener('visibilitychange', this.onHidden);
    cancelAnimationFrame(this.raf);
    this.subs.forEach(s => s.unsubscribe());
    clearTimeout(this.countdownTimer);
    clearTimeout(this.playTimer);
    this.clock?.dispose();
    this.highway?.dispose();
    this.score?.dispose();
    if (this.synthAudio) URL.revokeObjectURL(this.synthAudio.url);
    this.wakeLock?.release().catch(() => {});
  }

  // ------------------------------------------------------------- controls
  async togglePlay(): Promise<void> {
    if (!this.clock) return;
    if (this.countdown() !== null) { this.cancelCountdown(); return; }
    // "playing" is about the game, not just the player: a video that won't start must still be pausable
    if (this.clock.paused && !this.playing()) {
      if (this.results()) this.restart(false);
      this.menuOpen.set(false);
      this.riffOpen.set(false);
      this.closeMenus();
      await this.enterGameMode();
      if (this.seekedWhilePaused) {
        this.seekedWhilePaused = false;
        void this.beginPlay();
      } else {
        this.startCountdown();
      }
    } else {
      this.clock.pause();
      this.playing.set(false);
      this.preroll = null;
      clearTimeout(this.playTimer);
    }
  }

  /** 4, 3, 2, 1 on the track (the song only starts afterwards). */
  private startCountdown(): void {
    if (!this.clock) return;
    const startPerf = performance.now() + 4000;
    // the track already knows where the song starts: during the countdown it moves up to there
    const from = this.clock.mediaAt(performance.now());
    this.slew.ms = 0;
    this.startWatch = null;
    const lead = this.startLag[this.lagKind()];
    // YouTube: plays the second before the start point muted and turns the sound on when it gets there, so nothing
    // has to start at the end of the countdown (the track follows the video from the moment it moves)
    const clockStarts = this.clock.startAt?.(from, startPerf, lead) ?? false;
    this.preroll = { from, startPerf, clockStarts, follow: false };
    if (!clockStarts) {
      // others: play is sent early by the audio latency already measured, so the sound starts when the countdown ends
      this.clock.prime?.(from);
      this.playTimer = setTimeout(() => {
        this.playTimer = undefined;
        void this.beginPlay();
      }, Math.max(0, startPerf - lead - performance.now()));
    }
    const step = (): void => {
      const left = startPerf - performance.now();
      if (left <= 2) {
        this.countdownTimer = undefined;
        this.countdown.set(null);
        if (clockStarts) this.playing.set(true);   // the source turns its sound on by itself
        return;
      }
      this.countdown.set(Math.ceil(left / 1000 - 0.001));
      const toNext = left % 1000;
      this.countdownTimer = setTimeout(step, toNext < 2 ? 1000 : toNext);
    };
    step();
  }

  private cancelCountdown(): void {
    clearTimeout(this.countdownTimer);
    clearTimeout(this.playTimer);
    this.countdownTimer = undefined;
    this.playTimer = undefined;
    this.preroll = null;
    // the audio may already have been sent early, or the video may be loading muted: stop both
    if (this.clock) {
      this.clock.pause();
      this.playing.set(false);
    }
    this.countdown.set(null);
  }

  private lagKind(): 'synth' | 'youtube' {
    return this.audioSource() === 'synth' ? 'synth' : 'youtube';
  }

  private async beginPlay(): Promise<void> {
    if (!this.clock) return;
    this.starting = true;
    try {
      await this.clock.play();
      this.playing.set(true);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Goes back to the start (or to the start of the Riff Repeater section). `exactLoop`: starts exactly at the beginning
   * of the section — the countdown becomes an empty run-up before it, without eating into the section time.
   */
  restart(play = true, exactLoop = false): void {
    if (!this.clock) return;
    this.seekedWhilePaused = false;   // restart always has a countdown
    this.results.set(null);
    this.ended = false;
    this.engine.resetAll();
    this.passes.set([]);
    const start = !this.loopOn() ? 0 : exactLoop ? this.loopStartMs() : this.loopStartMs() - this.preRoll(this.loopStartMs());
    this.clock.seek(Math.max(0, start));
    const secs = this.sections();
    let idx = 0;
    while (idx + 1 < secs.length && secs[idx + 1].start <= start) idx++;
    this.currentSection.set(idx);
    if (this.debugOn()) this.beginDebug(Math.max(0, start));
    this.bot.reset(this.active, start);
    this.sectionSnapshot = { weight: 0, judged: 0 };
    this.hud.set(null);
    if (play && this.clock.paused) void this.togglePlay();
  }

  setRate(r: number): void {
    if (this.clock) {
      this.clock.rate = r;
      r = this.clock.rate;   // YouTube may round the speed
    }
    this.rate.set(r);
    this.engine.rate = r;
  }

  /** Audio source: synthesized (generated from the MIDI by alphaTab), original recording or original without drums (Songsterr videos). */
  sourceFor(kind: AudioSource): YoutubeSource | undefined {
    const yt = this.chart()?.song.audio.youtube ?? [];
    return kind === 'synth' ? undefined
      : yt.find(v => v.kind === kind && v.syncPoints?.length && !this.failedVideos.has(v.videoId));
  }

  hasSource(kind: AudioSource): boolean {
    if (kind !== 'synth') return !!this.sourceFor(kind);
    const synth = this.chart()?.song.audio.synth;
    return !!synth && !!this.synthAudio;
  }

  async setSource(kind: AudioSource, at?: number): Promise<void> {
    const song = this.chart()?.song;
    if (!song || this.sourceLoading() || !this.hasSource(kind)) return;
    const pos = at ?? (this.clock ? this.clock.mediaAt(performance.now()) : 0);
    const wasPlaying = !!this.clock && !this.clock.paused;
    this.clock?.pause();
    this.clock?.dispose();
    this.clock = undefined;
    this.playing.set(false);
    this.sourceLoading.set(true);
    this.sourceError.set(null);
    const video = this.sourceFor(kind);
    this.ytLoading.set(kind !== 'synth');
    try {
      const clock: GameClock = kind === 'synth'
        ? new MediaClock(this.synthAudio!.url, song.audio.synth!.offsetMs)
        : new YouTubeClock(this.ytHost().nativeElement, video!);
      clock.onEnded = () => this.finish();
      clock.onFailure = msg => void this.sourceFailed(clock, kind, video?.videoId, msg);
      // YouTube measures how long this device takes from play to the video moving: the next start goes out that early
      clock.onStartLatency = ms => this.learnStartLag('youtube', ms);
      await clock.load().finally(() => this.ytLoading.set(false));
      this.clock = clock;
      this.audioSource.set(kind);
      this.clockRates.set(clock.availableRates?.() ?? null);
      this.setRate(this.rate());
      clock.seek(pos);
      if (wasPlaying) await this.beginPlay();
    } catch (e) {
      this.sourceLoading.set(false);
      this.ytLoading.set(false);
      if (video) this.failedVideos.add(video.videoId);
      this.sourceError.set(this.fallbackMessage((e as Error).message, kind));
      await this.fallbackSource(kind, pos);
      return;
    }
    this.sourceLoading.set(false);
  }

  /**
   * The video stopped for good (blocked on YouTube, won't start playing…): instead of getting stuck at second 0,
   * the game goes to pause — with Library, Riff Repeater and Settings at hand — and switches to another
   * video of the same type, if any, or to the synthetic audio. The player just presses play again.
   */
  private async sourceFailed(clock: GameClock, kind: AudioSource, videoId: string | undefined, msg: string): Promise<void> {
    if (this.clock !== clock) return;   // failure from a player that was already replaced
    if (videoId) this.failedVideos.add(videoId);
    if (this.countdown() !== null) this.cancelCountdown();
    clearTimeout(this.playTimer);
    this.playTimer = undefined;
    this.preroll = null;
    clock.pause();
    this.playing.set(false);
    const pos = clock.mediaAt(performance.now());
    this.sourceError.set(this.fallbackMessage(msg, kind));
    await this.fallbackSource(kind, pos);
  }

  private fallbackMessage(msg: string, kind: AudioSource): string {
    const next = kind !== 'synth' && this.hasSource(kind) ? t('game.tryingOtherVideo')
      : this.hasSource('synth') ? t('game.switchedToSynth') : '';
    return `${sentence(msg)} ${next}`.trim();
  }

  /** Switches to the next source that may work, paused at the same point. */
  private async fallbackSource(kind: AudioSource, pos: number): Promise<void> {
    const msg = this.sourceError();
    const next: AudioSource | null = kind !== 'synth' && this.hasSource(kind) ? kind : this.hasSource('synth') ? 'synth' : null;
    if (!next) {
      this.clock?.dispose();
      this.clock = undefined;
      return;
    }
    this.clock?.dispose();
    this.clock = undefined;
    await this.setSource(next, pos);
    if (!this.sourceError()) this.sourceError.set(msg);   // the notice stays visible after the switch
  }

  /** Changed the audio through the menu (with the game paused): switch and start right away, with the 4-3-2-1 countdown. */
  async chooseSource(kind: AudioSource): Promise<void> {
    this.srcMenu.set(false);
    saveSourcePref(kind);
    await this.setSource(kind);
    if (this.audioSource() === kind && this.clock && this.paused() && !this.results()) void this.togglePlay();
  }

  /** Click on the sections bar: jumps to that point (like a player's timeline). */
  /** Opens (or closes, if already open) the Settings window or the Riff Repeater one. */
  openPanel(kind: 'config' | 'riff'): void {
    const open = kind === 'config' ? !this.menuOpen() : !this.riffOpen();
    if (kind === 'riff' && !open) { this.closeRiff(); return; }
    this.menuOpen.set(kind === 'config' && open);
    this.riffOpen.set(kind === 'riff' && open);
    this.closeMenus();
  }

  /**
   * Closing the Riff Repeater starts right away: with the section on, from the section start with the countdown before it;
   * off, it continues from where it was (like unpausing).
   */
  closeRiff(): void {
    this.riffOpen.set(false);
    this.closeMenus();
    if (!this.clock || !this.clock.paused || this.countdown() !== null || this.results()) return;
    if (this.loopOn()) this.restart(false, true);
    void this.togglePlay();
  }

  levelLabel(v: LevelMode): string {
    return v === 'auto' ? t('game.levelDynamic') : v === this.maxLevel ? t('game.levelFull') : t('game.level', { n: v });
  }

  judgeLabel(j: Judgement): string { return t(`judge.${j}` as StringKey); }

  sourceLabel(k: AudioSource): string { return t(`source.${k}` as StringKey); }

  /** Riff Repeater: turns on the chosen section and starts right away, with the countdown before the section start. */
  startRiff(): void {
    if (this.loopTo() < this.loopFrom()) this.loopTo.set(this.loopFrom());
    this.loopOn.set(true);
    this.passes.set([]);
    this.riffOpen.set(false);
    this.closeMenus();
    if (!this.clock || this.results()) return;
    this.restart(false, true);
    void this.togglePlay();
  }

  /** Turns off the Riff Repeater and continues from where it was. */
  stopRiff(): void {
    this.loopOn.set(false);
    this.passes.set([]);
    this.closeRiff();
  }

  setLoopFrom(v: number): void {
    this.loopFrom.set(v);
    if (this.loopTo() < v) this.loopTo.set(v);
  }

  /** Switches between highway and score instantly, playing or paused. */
  toggleView(): void {
    const v: ViewMode = this.view() === 'highway' ? 'score' : 'highway';
    this.view.set(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* no storage */ }
  }

  /** Clicking on the score takes the song to that point. */
  onScoreClick(ev: MouseEvent): void {
    const chart = this.chart();
    if (!chart || !this.clock || !this.score || this.view() !== 'score') return;
    this.seekTo(Math.min(chart.durationMs, Math.max(0, this.score.timeAt(ev.clientX))));
  }

  onTimeline(ev: MouseEvent): void {
    const chart = this.chart();
    if (!chart || !this.clock) return;
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
    this.seekTo(f * chart.durationMs);
  }

  seekTo(t: number): void {
    if (!this.clock) return;
    if (this.loopOn() && (t < this.loopStartMs() - this.preRoll(this.loopStartMs()) || t >= this.loopEndMs())) this.loopOn.set(false);
    this.results.set(null);
    this.ended = false;
    if (this.countdown() !== null) this.cancelCountdown();
    this.preroll = null;
    this.slew.ms = 0;
    this.startWatch = null;
    this.lastRawPerf = 0;
    if (this.clock.paused) this.seekedWhilePaused = true;
    this.clock.seek(t);
    this.engine.seek(t);
    if (this.debugOn()) this.recorder.push({ k: 'seek', at: performance.now(), t });
    this.bot.reset(this.active, t);
    const secs = this.sections();
    let idx = 0;
    while (idx + 1 < secs.length && secs[idx + 1].start <= t) idx++;
    this.currentSection.set(idx);
    const s = this.engine.stats.sections[idx];
    this.sectionSnapshot = { weight: s?.weight ?? 0, judged: s?.judged ?? 0 };
  }

  /** Moves the speed by `delta`, landing on the next speed the source accepts in that direction. */
  nudgeRate(delta: number): void {
    const target = Math.round((this.rate() + delta) * 100) / 100;
    const opts = this.rateOptions();
    const next = delta > 0 ? opts.find(s => s >= target - 0.001) : [...opts].reverse().find(s => s <= target + 0.001);
    if (next !== undefined) this.setRate(next);
  }

  setLevelMode(v: string): void {
    this.levelMode.set(v === 'auto' ? 'auto' : Number(v));
    if (v === 'auto') {
      const init: Record<string, number> = {};
      for (const s of this.sections()) init[s.name] = 3;
      this.levels.set(init);
    }
    this.applyLevels(this.clock ? this.heard(performance.now()) : -Infinity);
  }

  setTrack(i: string): void {
    const c = this.chart();
    if (!c) return;
    this.chart.set(buildChart(c.song, Number(i)));
    this.trackIndex.set(Number(i));
    this.engine = new ScoreEngine(this.rate());
    this.engine.strict = this.settings.profile().strict;
    this.applyLevels();
    this.restart(false);
  }

  setLoop(on: boolean): void {
    this.loopOn.set(on);
    if (on && this.loopTo() < this.loopFrom()) this.loopTo.set(this.loopFrom());
    this.restart(false);
  }

  toggleBot(): void {
    this.botOn.set(!this.botOn());
    this.bot.enabled = this.botOn();
    if (this.clock) this.bot.reset(this.active, this.heard(performance.now()));
  }

  /** No drum kit: tapping/clicking the piece icons on the highway counts as a hit on that piece. */
  onHighwayTap(ev: PointerEvent): void {
    if (this.view() !== 'highway' || !this.highway) return;
    const lane = this.highway.laneAt(ev.clientX, ev.clientY);
    if (lane) this.tapPad(lane, ev);
  }

  tapPad(lane: Lane, ev: Event): void {
    ev.preventDefault();
    this.input.emitTargets([lane]);
  }


  formatTime(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  sectionAcc(stats: Stats, i: number): number {
    const s = stats.sections[i];
    return s ? Math.round(accuracy(s) * 100) : -1;
  }

  timing(stats: Stats): { mean: number; std: number } {
    return meanStd(stats.deltas);
  }

  pct(x: number): number { return Math.round(x * 100); }

  setTrackScroll(v: number): void {
    const d = this.settings.dev;
    // the score gets its own value on the 1st change (before that it followed the highway's)
    this.settings.updateDevice(this.view() === 'score' ? { scoreScrollSpeed: v } : { scrollSpeed: v, scoreScrollSpeed: d.scoreScrollSpeed ?? d.scrollSpeed });
  }

  setNoteScale(v: number): void {
    this.settings.updateDevice(this.view() === 'score' ? { scoreNoteScale: v } : { noteScale: v });
  }

  /** Bottom bar rows before any move: row 0 starts with play, row 1 with the highway/score switch. */
  private baseBarRows(): string[][] {
    const row0 = ['rate', 'src', 'level', 'riff', ...(this.hasRestart() ? ['restart'] : []), 'library', 'gear'];
    return [row0, ['view', 'size', 'track', 'delay']];
  }

  /** Watches the sizes that matter for the bar (new buttons appear when it is redrawn). */
  private observeBar(): void {
    const ro = this.barObserver;
    if (!ro) return;
    ro.observe(this.stage().nativeElement);
    ro.observe(this.ytHost().nativeElement);
    const fs = this.fsBtn()?.nativeElement;
    if (fs) ro.observe(fs);
    this.barRowsEl()?.nativeElement.querySelectorAll('.slot').forEach(el => ro.observe(el));
  }

  private scheduleBar(): void {
    if (this.barRaf) return;
    this.barRaf = requestAnimationFrame(() => { this.barRaf = 0; untracked(() => this.relayoutBar()); });
  }

  /** Measures the buttons, the video and the fullscreen button and decides which row each button goes in. */
  private relayoutBar(): void {
    const host = this.barRowsEl()?.nativeElement;
    const stage = this.stage().nativeElement;
    if (!host) return;
    const sr = stage.getBoundingClientRect();
    let rowHeight = 0;
    host.querySelectorAll<HTMLElement>('.slot[data-k]').forEach(el => {
      const r = el.getBoundingClientRect();
      this.barWidths[el.dataset['k']!] = r.width;
      rowHeight = Math.max(rowHeight, r.height);
    });
    const play = host.querySelector<HTMLElement>('.play')?.getBoundingClientRect();
    const rel = (r: DOMRect): BarRect => ({ left: r.left - sr.left, right: r.right - sr.left, bottom: sr.bottom - r.bottom, top: sr.bottom - r.top });
    const yt = this.ytHost().nativeElement;
    const ytRect = yt.getBoundingClientRect();
    const video = !yt.classList.contains('hidden') && ytRect.width > 4 ? rel(ytRect) : null;
    const fsEl = this.fsBtn()?.nativeElement.getBoundingClientRect();
    const out = layoutBar({
      stageWidth: stage.clientWidth,
      rows: this.baseBarRows(),
      widths: this.barWidths,
      anchors: new Set(['view']),
      playWidth: play?.width || 52,
      row0Height: play?.height || 52,
      rowHeight: rowHeight || 40,
      video,
      fs: fsEl ? { width: fsEl.width, height: fsEl.height } : null,
    });
    if (JSON.stringify(out.rows) !== JSON.stringify(this.barRows())) this.barRows.set(out.rows);
    if (JSON.stringify(out.fs) !== JSON.stringify(this.barFs())) this.barFs.set(out.fs);
  }

  /** Opens a bottom bar menu (or closes it, if already open) and closes the others. */
  toggleMenu(which: 'rate' | 'src' | 'level' | 'size' | 'track'): void {
    const menus = { rate: this.rateMenu, src: this.srcMenu, level: this.levelMenu, size: this.sizeMenu, track: this.trackMenu };
    const open = !menus[which]();
    for (const [k, m] of Object.entries(menus)) m.set(k === which && open);
  }

  closeMenus(): void {
    for (const m of [this.rateMenu, this.srcMenu, this.levelMenu, this.sizeMenu, this.trackMenu]) m.set(false);
  }

  fmtX(v: number): string { return `${+v.toFixed(2)}x`; }

  // ------------------------------------------------------------- main loop
  private frame = (perf: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const t0 = performance.now();
    this.frameBody(perf);
    if (this.settings.dev.showFps) this.measureFps(perf, performance.now() - t0);
    else if (this.fpsText()) this.fpsText.set('');
  };

  /** Frames in the last 1 s, worst frame interval, JS time per frame and drawing resolution. */
  private measureFps(perf: number, jsMs: number): void {
    const w = this.fpsWin;
    if (w.last) w.worst = Math.max(w.worst, perf - w.last);
    w.last = perf;
    w.frames++;
    w.js += jsMs;
    w.jsWorst = Math.max(w.jsWorst, jsMs);
    if (!w.start) w.start = perf;
    if (perf - w.start < 1000) return;
    const secs = (perf - w.start) / 1000;
    const c = this.view() === 'score' ? this.scoreCanvas().nativeElement : this.canvas().nativeElement;
    this.fpsText.set(t('game.fps', { fps: Math.round(w.frames / secs), worst: w.worst.toFixed(1), js: (w.js / w.frames).toFixed(2),
      jsMax: w.jsWorst.toFixed(1), w: c.width, h: c.height, dpr: devicePixelRatio.toFixed(2) }));
    Object.assign(w, { start: perf, frames: 0, worst: 0, js: 0, jsWorst: 0 });
  }

  private frameBody(perf: number): void {
    const clock = this.clock, chart = this.chart();
    if (!clock || !this.highway || !chart) return;
    clock.tick(perf);
    // the game is in charge: audio playing with the game paused (e.g. a click inside the YouTube video) pauses again,
    // so the highway never moves with the pause screen open
    if (clock.playing && this.paused() && !this.preroll && !this.starting) clock.pause();
    if (Math.abs(clock.rate - this.rate()) > 0.001) { this.rate.set(clock.rate); this.engine.rate = clock.rate; }
    const dev = this.settings.dev;
    const now = this.heard(perf);
    const rate = this.rate();
    this.holdPreroll(clock, perf);
    this.absorbClockJumps(clock, perf, rate);
    this.settleSlew(clock, perf, rate);
    // countdown when resuming from pause: empty run-up to the start point (notes already played don't come back)
    const hide = this.preroll ? this.preroll.from - 0.5 : -Infinity;
    this.highway.hideBefore = hide;
    if (this.score) this.score.hideBefore = hide;

    if (clock.playing) {
      this.bot.update(this.active, now, rate);
      if (this.debugOn()) this.recorder.push({ k: 'tick', at: perf, now });
      for (const ev of this.engine.advance(now)) {
        this.popup(ev.judgement, ev.lane);
        if (ev.note && this.debugOn()) this.recorder.push({ k: 'miss', at: perf, noteId: ev.note.id, t: ev.note.t, lane: ev.lane });
      }
      this.trackSection(now);
      if (this.loopOn() && now >= this.loopEndMs()) this.endPass();
    }

    const shownNow = this.timeAt(perf - dev.audioOffsetMs);
    const scroll = this.trackScroll(), scale = this.noteScale();
    if (this.view() === 'score') {
      if (this.score) { this.score.noteScale = scale; this.score.render(shownNow, scroll); }
    } else {
      this.highway.noteScale = scale;
      this.highway.render(shownNow, rate, scroll,
        clock.playing && this.analysis ? this.analysis.at(shownNow, this.audioLevels) : clock.levels(this.audioLevels));
    }

    if (perf - this.lastHudUpdate > 50) {
      this.lastHudUpdate = perf;
      if (this.lyricLines().length) {
        const shown = this.timeAt(perf - dev.audioOffsetMs);
        this.lyricNow.set(shown);
        this.lyricIndex.set(lyricLineAt(this.lyricLines(), shown));
      }
      this.hud.set({ ...this.engine.stats });
      this.passHud.set({ ...this.engine.pass });
      this.progress.set(Math.min(1, Math.max(0, now / chart.durationMs)));
    }
  }

  /**
   * The audio clock sometimes corrects itself all at once (e.g. right after the sound starts). Instead of the
   * track jumping, the difference goes into the smooth adjustment (`slew`), which the track undoes very slowly.
   */
  private absorbClockJumps(clock: GameClock, perf: number, rate: number): void {
    if (!clock.playing || this.preroll) { this.lastRawPerf = 0; return; }
    const raw = clock.mediaAt(perf);
    if (this.lastRawPerf) {
      const d = raw - (this.lastRaw + (perf - this.lastRawPerf) * rate);
      if (Math.abs(d) > 3 && Math.abs(d) < 600) {
        this.slew.ms -= d;
        if (this.startWatch) this.startWatch.err -= d;   // part of the audio start
      }
    }
    this.lastRaw = raw;
    this.lastRawPerf = perf;
  }

  /**
   * Undoes the difference between the track and the audio without it being noticed: the speed changes by at most 3%.
   * 1.5 s after the sound starts, the total start error becomes the newly learned audio latency
   * (on the next countdown play is sent earlier and the difference stays close to zero).
   */
  private settleSlew(clock: GameClock, perf: number, rate: number): void {
    const dt = this.lastSlewPerf ? Math.min(100, perf - this.lastSlewPerf) : 0;
    this.lastSlewPerf = perf;
    if (this.startWatch && perf >= this.startWatch.until) {
      const kind = this.lagKind();
      // start error in real ms (it was measured in song ms, which run `rate` times slower or faster)
      const err = this.startWatch.err / rate;
      // early (play sent too soon): corrected at once — otherwise every start would come out early again.
      // Late: learned gradually, ignoring abnormal starts (e.g. the page's 1st time), which would spoil the next one.
      const step = err < 0 ? err : err < 400 ? Math.min(60, err * 0.6) : 0;
      if (step) {
        this.startLag[kind] = Math.min(START_LAG_MAX[kind], Math.max(0, this.startLag[kind] + step));
        saveStartLag(this.startLag);
      }
      this.startWatch = null;
    }
    if (!this.slew.ms || !(clock.playing || clock.following)) return;
    // small difference: 3% (unnoticeable); large: corrects in ~2 s instead of staying out of sync for a long time
    const speed = Math.abs(this.slew.ms) > SLEW_FAST_ABOVE_MS ? FAST_SLEW_SPEED : MAX_SLEW_SPEED;
    const step = dt * speed * rate;
    this.slew.ms = Math.abs(this.slew.ms) <= step ? 0 : this.slew.ms - Math.sign(this.slew.ms) * step;
  }

  /** Start delay measured by the source itself: weighs the new value more (devices differ, the last start tells most). */
  private learnStartLag(kind: 'synth' | 'youtube', ms: number): void {
    this.startLag[kind] = Math.round(Math.min(START_LAG_MAX[kind], Math.max(0, this.startLag[kind] * 0.3 + ms * 0.7)));
    saveStartLag(this.startLag);
  }

  private heard(perf: number): number {
    return this.timeAt(perf - this.settings.dev.audioOffsetMs);
  }

  /**
   * Song position (chart ms) at a performance.now() instant, continuous between the countdown and the audio:
   * during the countdown the track already moves to the start point; when the sound starts, the small start
   * difference (the browser takes a few ms to release the audio) is undone gradually (up to 3% speed).
   */
  private timeAt(q: number): number {
    const c = this.clock;
    if (!c) return 0;
    const rate = this.rate();
    const p = this.preroll;
    if (p) {
      if (!c.playing && !c.following) return this.prerollAt(q, rate);
      const now = performance.now();
      if (!p.follow) {
        // the source started: from here the track follows its clock; the difference to the countdown goes into the
        // smooth adjustment and is undone gradually — the track never jumps nor stops
        p.follow = true;
        const diff = this.prerollAt(now, rate) - c.mediaAt(now);
        this.slew.ms = Math.abs(diff) < 1000 ? diff : 0;
        // play() sources: the start error is learned even when too big to smooth (e.g. the sound came out a second
        // early). startAt sources measure their own start delay (onStartLatency).
        if (!p.clockStarts) this.startWatch = { until: now + 1500, err: Math.max(-START_LAG_MAX[this.lagKind()], Math.min(1000, diff)) };
      }
      if (c.playing) {
        this.preroll = null;
        if (p.clockStarts) this.playing.set(true);
      }
    }
    return c.mediaAt(q) + this.slew.ms;
  }

  /**
   * Track position during the countdown. If the sound is later than expected (page's 1st time, new song without cache),
   * the track waits a little after the start point instead of moving on without audio — so the start
   * difference never exceeds ~PREROLL_HOLD_MS and the sync with the configured delay holds from the 1st note.
   */
  private prerollAt(q: number, rate: number): number {
    return this.preroll!.from + (q - this.preroll!.startPerf) * rate;
  }

  /**
   * Called every frame: if the sound passed the point where it should start and hasn't come out yet, push the start
   * forward (the track waits still; the audio/video delay keeps applying the same way).
   */
  private holdPreroll(clock: GameClock, perf: number): void {
    const p = this.preroll;
    if (!p || clock.playing || clock.following) return;
    const late = perf - (p.startPerf + PREROLL_HOLD_MS);
    if (late > 0) p.startPerf += late;
  }

  private judge(cands: Cand[], t: number, fromBot: boolean, src?: DebugSrc): void {
    // the hit flashes every piece it triggers; the lane shown is the first command's
    for (const c of cands) {
      this.highway?.flash(c.lane, c.hh === 'pedal');
      this.score?.flash(c.lane, c.hh === 'pedal');
    }
    if (!this.clock?.playing && !fromBot) return;
    const lane = cands[0].lane;
    const pedal = cands.some(c => c.hh === 'pedal');
    // with a single crash cymbal, it counts for crash 1 and crash 2 notes
    const pool: Cand[] = cands;
    // a hit can hit one note per piece it triggers
    const rec = this.debugOn();
    const near = rec ? this.nearNotes(pool, t) : [];
    const live: LiveResult[] = [];
    for (const ev of this.engine.hitAll(pool, t)) {
      live.push({ j: ev.judgement, noteId: ev.note?.id ?? null, deltaMs: ev.deltaMs });
      const shown = ev.judgement === 'extra' ? lane : ev.lane;
      this.highway?.burst(shown, ev.judgement);
      this.score?.burst(shown, ev.judgement);
      if (ev.judgement !== 'extra' || this.settings.profile().strict) this.popup(ev.judgement, shown, ev.deltaMs, pedal);
    }
    if (rec) {
      if (!live.length) live.push({ j: 'blocked', noteId: null });
      const at = src?.at ?? performance.now();
      this.recorder.hit({
        at, source: src?.source ?? 'bot', midiTs: src?.midiTs ?? null, note: src?.note ?? null,
        velocity: src?.velocity ?? null, cands: pool, chartT: t, nowChart: this.heard(at), near, live,
        playing: this.clock?.playing ?? false, audioOffsetMs: this.settings.dev.audioOffsetMs,
      });
    }
  }

  /** Notes of the hit's pieces that are up to 300 ms away, with their state before judging. */
  private nearNotes(pool: Cand[], t: number) {
    const lanes = new Set(pool.map(c => c.lane));
    return this.active
      .filter(n => lanes.has(n.lane) && Math.abs(n.t - t) <= 300)
      .map(n => ({ id: n.id, t: n.t, lane: n.lane, art: n.art, status: this.engine.statusOf(n.id) }));
  }

  /** Turns debug mode on/off. Turning it on restarts the song recording everything; turning it off discards what was recorded. */
  toggleDebug(): void {
    if (!this.clock) return;
    if (this.debugOn()) {
      this.debugOn.set(false);
      this.recorder.clear();
      this.debugMsg.set(t('game.debugOff'));
      return;
    }
    this.debugOn.set(true);
    this.debugMsg.set(t('game.debugOnMsg'));
    this.restart(true);
  }

  private beginDebug(from: number): void {
    const chart = this.chart();
    if (!chart) return;
    const prof = this.settings.profile();
    this.recorder.start({
      song: chart.song.id, startedAt: new Date().toISOString(), durationMs: chart.durationMs, startMs: from,
      rate: this.rate(), audioSource: this.audioSource(), levelMode: this.levelMode(), device: this.settings.device,
      dev: this.settings.dev, strict: prof.strict, twoCrashes: true, kit: prof.kit,
      userAgent: navigator.userAgent, origin: location.origin,
      engine: { hitWindowMs: this.settings.dev.hitWindowMs, chordWindowMs: this.settings.dev.chordWindowMs, earlyWindowMs: this.settings.dev.earlyWindowMs },
      windowsUsed: { perfect: this.engine.win.perfect, great: this.engine.win.great, good: this.engine.win.good, chordTol: this.engine.chordTol, earlyMs: this.engine.earlyMs },
    });
    const at = performance.now();
    this.recorder.push({ k: 'notes', at, from: null, notes: this.active });
    this.recorder.push({ k: 'reset', at });
  }

  async saveDebug(): Promise<void> {
    const dump = this.recorder.dump(performance.now());
    this.debugMsg.set(t('game.debugSaving'));
    try {
      // saves as a file (Downloads folder on the PC; on the phone, wherever the system stores downloads)
      const song = (this.chart()?.song.id ?? 'song').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const name = `drumhero-debug-${stamp}-${song}.json`;
      const where = await saveFile(name, new Blob([JSON.stringify(dump)], { type: 'application/json' }));
      this.debugMsg.set(t('game.debugSaved', { where, n: dump.events.length }));
    } catch (e) {
      this.debugMsg.set(t('game.debugSaveFailed', { msg: (e as Error).message }));
    }
  }

  private popup(text: Judgement, lane: Lane, delta?: number, pedal?: boolean): void {
    const id = ++this.popupId;
    this.popups.update(p => [...p.slice(-3), { id, text, lane, delta, pedal }]);
    setTimeout(() => this.popups.update(p => p.filter(x => x.id !== id)), 650);
  }

  private applyLevels(from = -Infinity): void {
    const chart = this.chart();
    if (!chart) return;
    const mode = this.levelMode();
    const bySection = chart.sections.map(s => (mode === 'auto' ? this.levels()[s.name] ?? 3 : mode));
    this.active = notesForLevels(chart, bySection);
    this.engine.strict = this.settings.profile().strict;
    this.engine.configure(this.settings.dev.hitWindowMs, this.settings.dev.chordWindowMs, this.settings.dev.earlyWindowMs);
    this.engine.setNotes(this.active, from);
    if (this.debugOn()) this.recorder.push({ k: 'notes', at: performance.now(), from: from === -Infinity ? null : from, notes: this.active });
    this.highway?.setChart(this.active, chart.beats, chart.sections, id => this.engine.statusOf(id));
    this.score?.setChart(this.active, chart.beats, chart.sections, id => this.engine.statusOf(id));
    if (this.clock) this.bot.reset(this.active, from === -Infinity ? 0 : from);
  }

  /** Dynamic difficulty: at the end of each section, raises/lowers the level of that part. */
  private trackSection(now: number): void {
    const secs = this.sections();
    let idx = this.currentSection();
    if (idx < secs.length && now >= secs[idx].end) {
      const sec = this.engine.stats.sections[idx] ?? { weight: 0, judged: 0 };
      const delta = { weight: sec.weight - this.sectionSnapshot.weight, judged: sec.judged - this.sectionSnapshot.judged };
      if (this.levelMode() === 'auto' && delta.judged >= 4) {
        const acc = accuracy(delta);
        const name = secs[idx].name;
        const cur = this.levels()[name] ?? 3;
        const next = acc >= 0.9 ? Math.min(MAX_LEVEL, cur + 1) : acc < 0.6 ? Math.max(1, cur - 1) : cur;
        if (next !== cur) {
          this.levels.update(l => ({ ...l, [name]: next }));
          this.applyLevels(now);
        }
      }
    }
    while (idx + 1 < secs.length && now >= secs[idx + 1].start) idx++;
    while (idx > 0 && now < secs[idx].start) idx--;
    if (idx !== this.currentSection()) {
      this.currentSection.set(idx);
      const s = this.engine.stats.sections[idx];
      this.sectionSnapshot = { weight: s?.weight ?? 0, judged: s?.judged ?? 0 };
    }
  }

  // ------------------------------------------------------------- Riff Repeater
  private loopStartMs(): number { return this.sections()[this.loopFrom()]?.start ?? 0; }
  private loopEndMs(): number { return this.sections()[this.loopTo()]?.end ?? this.chart()!.durationMs; }

  /** One bar of countdown before the section. */
  private preRoll(t: number): number {
    const m = this.chart()?.song.measures ?? [];
    let i = 0;
    while (i + 1 < m.length && m[i + 1].ms <= t) i++;
    const next = m[i + 1]?.ms ?? m[i]?.ms + 2000;
    return Math.max(1000, next - (m[i]?.ms ?? 0));
  }

  private endPass(): void {
    const acc = accuracy(this.engine.pass);
    this.passes.update(p => [...p.slice(-9), { acc, rate: this.rate() }]);
    if (this.autoSpeed() && acc >= 0.9 && this.rate() < 1) this.nudgeRate(0.05);
    const start = this.loopStartMs();
    this.engine.resetRange(start, this.loopEndMs());
    if (this.debugOn()) this.recorder.push({ k: 'range', at: performance.now(), start, end: this.loopEndMs() });
    const from = Math.max(0, start - this.preRoll(start));
    this.clock!.seek(from);
    this.bot.reset(this.active, from);
  }

  private finish(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.debugOn()) this.recorder.push({ k: 'tick', at: performance.now(), now: 1e12 });
    for (const ev of this.engine.advance(Infinity)) {
      if (ev.note && this.debugOn()) this.recorder.push({ k: 'miss', at: performance.now(), noteId: ev.note.id, t: ev.note.t, lane: ev.lane });
    }
    const stats = { ...this.engine.stats };
    if (this.debugOn()) void this.saveDebug();
    this.results.set(stats);
    this.playing.set(false);
    this.menuOpen.set(true);
    const id = this.chart()!.song.id;
    const acc = accuracy(stats);
    const record = !this.botOn() && this.levelMode() === 5 && acc > (this.best() ?? 0);
    this.newRecord.set(record ? { previous: this.best() } : null);
    if (record) {
      localStorage.setItem(`drumhero.best.${id}`, String(acc));
      this.best.set(acc);
    }
    // stays fullscreen: the results screen already has the buttons to play again and go to the library
  }

  private async enterGameMode(): Promise<void> {
    try {
      if (this.settings.device === 'mobile' && !document.fullscreenElement) {
        await this.stage().nativeElement.requestFullscreen();
        await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
      }
    } catch { /* not every browser allows it */ }
    try { this.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  }
}

/** Hi-hat type of a chart note (so the virtual drummer hits it right). */
function hhArtOfNote(art: string): HhArt {
  return art === 'open' || art === 'half' || art === 'pedal' ? art : 'closed';
}

const SOURCE_KEY = 'drumhero.audioSource';
function readSourcePref(): AudioSource | null {
  try { const v = localStorage.getItem(SOURCE_KEY); return v === 'synth' || v === 'full' || v === 'nodrums' ? v : null; } catch { return null; }
}
function saveSourcePref(v: AudioSource): void {
  try { localStorage.setItem(SOURCE_KEY, v); } catch { /* no storage */ }
}

function readView(): ViewMode {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'score' || v === 'partitura' ? 'score' : 'highway';   // 'partitura': old name
  } catch { return 'highway'; }
}

/** Bottom bar icons (stroke drawing, 24×24 box). */
const ICONS = {
  rate: 'M9 3h6l4.5 18h-15zM12 16l5-9M6.5 15h11',                                   // metronome
  source: 'M4 9h4l5-4v14l-5-4H4zM16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11',        // speaker
  level: 'M4 20v-4M9 20v-8M14 20v-12M19 20V4',                                      // bars
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM15.6 5.3l3.6-1 3.6 14.6-3.6 1z',              // books
  riff: 'M17 2l3 3-3 3M4 11V9a4 4 0 0 1 4-4h12M7 22l-3-3 3-3M20 13v2a4 4 0 0 1-4 4H4', // repeat
  restart: 'M3 12a9 9 0 1 0 2.6-6.4M3 3v6h6',                                        // restart
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',                               // fullscreen
  exitFullscreen: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5',                           // exit fullscreen
  size: 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7',                                   // size
  track: 'M4 6l7 6-7 6zM13 6l7 6-7 6z',                                             // forward (track speed)
  gear: 'M19.14 12.94a7.07 7.07 0 0 0 .06-.94 7.07 7.07 0 0 0-.06-.94l2.03-1.58a.48.48 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.48.48 0 0 0-.48-.41h-3.84a.48.48 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.48.48 0 0 0-.59.22L2.71 8.87a.48.48 0 0 0 .12.61l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.48.48 0 0 0-.12.61l1.92 3.32c.12.22.37.3.59.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.05.24.25.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.48.48 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z',
};

/** v3: for YouTube it is now the time from play to the video moving, measured by the clock on every start. */
const START_LAG_KEY = 'drumhero.audioStartLag3';
/** Maximum speed of the track vs audio correction (3%: unnoticeable). */
const MAX_SLEW_SPEED = 0.03;
/** Above this difference (ms) the correction is fast (25%): better a short visible adjustment than seconds out of sync. */
const SLEW_FAST_ABOVE_MS = 50;
const FAST_SLEW_SPEED = 0.25;
/** During the countdown, how far the track moves past the start point waiting for the sound to start. */
const PREROLL_HOLD_MS = 120;
/** Limit of the learned latency for the audio to start (ms). */
const START_LAG_MAX = { synth: 250, youtube: 2000 };

function readStartLag(): Record<'synth' | 'youtube', number> {
  const def = { synth: 60, youtube: 600 };
  try {
    const v = JSON.parse(localStorage.getItem(START_LAG_KEY) ?? 'null');
    const clamp = (x: unknown, d: number, max: number) => { const n = Number(x ?? d); return Number.isFinite(n) ? Math.min(max, Math.max(0, n)) : d; };
    return { synth: clamp(v?.synth, def.synth, START_LAG_MAX.synth), youtube: clamp(v?.youtube, def.youtube, START_LAG_MAX.youtube) };
  } catch {
    return def;
  }
}

function saveStartLag(v: Record<'synth' | 'youtube', number>): void {
  try { localStorage.setItem(START_LAG_KEY, JSON.stringify(v)); } catch { /* no storage */ }
}

/** "o vídeo ..." → "O vídeo ...." (complete sentence for the notice). */
function sentence(text: string): string {
  const t = text.trim();
  return !t ? t : t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}
