import { Injectable, computed, effect, signal } from '@angular/core';
import { DEFAULT_LANE_COLOR, applyLaneColors, normalizeHex } from './lane-colors';
import { Lane } from './protocol';

export type DeviceKind = 'mobile' | 'pc';
export type GraphicsQuality = 'high' | 'low';

/** Per-device settings (each audio output has its own delay). */
export interface DeviceSettings {
  audioOffsetMs: number;   // delay between the audio leaving and you hearing it (calibrated)
  hitWindowMs: number;     // hit window (± real ms): perfect = 1/3, great = 2/3
  chordWindowMs: number;   // tolerance between notes that come out together (real ms)
  earlyWindowMs: number;   // an early note gets priority if it is at most this far away (real ms)
  scrollSpeed: number;     // highway track speed (1 = default)
  scoreScrollSpeed?: number;   // score speed (no value: same as the highway)
  noteScale?: number;      // note size on the highway (1 = default)
  scoreNoteScale?: number; // note size on the score (1 = default)
  quality: GraphicsQuality;
  antialias: Antialias;    // anti-aliasing on the highways (WebGL)
  showFps?: boolean;       // frames-per-second meter in the game
}

/** Highway anti-aliasing: off, MSAA 4x or MSAA 4x + supersampling (renders at a higher resolution). */
export type Antialias = 'off' | 'msaa' | 'max';

export type KitTarget = Lane | 'hihat_open' | 'hihat_half' | 'hihat_pedal' | 'ignore';

export interface Profile {
  kit: Record<string, KitTarget[]>;      // drum kit MIDI note -> commands (one note can trigger several pieces)
  devices: Partial<Record<DeviceKind, DeviceSettings>>;
  devicesUpdatedAt?: Partial<Record<DeviceKind, number>>;   // when each device changed (the newest version wins)
  strict: boolean;                        // an extra hit costs points
  keys?: Record<string, KitTarget[]>;    // PC key (KeyboardEvent.code) -> commands, like the drum notes
  lyrics?: boolean;                       // show the lyrics (karaoke) when the song has them; default: yes
  kitVersion?: number;
  laneColors?: Partial<Record<Lane, string>>;   // colors chosen for the pieces (Settings → Colors)
}

/** Initial map = General MIDI (adjusted in Learn mode). */
const GM_MAP: Record<string, KitTarget> = {
  '35': 'kick', '36': 'kick',
  '37': 'snare', '38': 'snare', '40': 'snare',
  '42': 'hihat', '46': 'hihat_open', '22': 'hihat', '26': 'hihat', '44': 'hihat_pedal',
  '48': 'tom1', '50': 'tom1', '45': 'tom2', '47': 'tom2',
  '41': 'floor', '43': 'floor', '58': 'floor',
  '49': 'crash', '52': 'crash', '55': 'crash', '57': 'crash2',
  '51': 'ride', '53': 'ride', '59': 'ride',
};

/** Default PC keys (physical key code, the same on any layout). */
export const DEFAULT_KEYS: Record<string, KitTarget[]> = {
  Space: ['kick'], KeyF: ['snare'], KeyJ: ['hihat'], KeyK: ['hihat_open'], KeyG: ['tom1'], KeyH: ['tom2'],
  KeyL: ['floor'], KeyD: ['crash'], KeyS: ['crash2'], Semicolon: ['ride'],
};

/** One command per note (the default). You can add other commands to the same note. */
export const DEFAULT_KIT: Record<string, KitTarget[]> = Object.fromEntries(
  Object.entries(GM_MAP).map(([n, t]) => [n, [t]]),
);

const DEFAULT_DEVICE = (kind: DeviceKind): DeviceSettings => ({
  audioOffsetMs: kind === 'mobile' ? 110 : 60,
  hitWindowMs: 117,
  chordWindowMs: 50,
  earlyWindowMs: 50,
  scrollSpeed: 1,
  quality: kind === 'mobile' ? 'low' : 'high',
  antialias: kind === 'mobile' ? 'off' : 'msaa',
});

const KEY = 'drumhero.profile.v1';
const KIT_VERSION = 3;

/**
 * Old profiles stored one command per note (and note 57 went to crash 1, 46 to the hi-hat).
 * Now each note has a list of commands; old profiles are converted here.
 */
function migrate(p: Profile): Profile {
  // old (Portuguese) names of the stored values: celular → mobile, alta/baixa → high/low
  const devices = { ...(p.devices ?? {}) } as Record<string, DeviceSettings & { quality: string; videoOffsetMs?: number }>;
  if (devices['celular'] && !devices['mobile']) devices['mobile'] = devices['celular'];
  delete devices['celular'];
  for (const d of Object.values(devices) as { quality: string; videoOffsetMs?: number }[]) {
    if (d.quality === 'alta') d.quality = 'high';
    if (d.quality === 'baixa') d.quality = 'low';
    delete d.videoOffsetMs;
  }
  const stamps = { ...(p.devicesUpdatedAt ?? {}) } as Record<string, number>;
  if (stamps['celular'] && !stamps['mobile']) stamps['mobile'] = stamps['celular'];
  delete stamps['celular'];
  p = { ...p, devices: devices as Profile['devices'], devicesUpdatedAt: stamps as Profile['devicesUpdatedAt'] };
  const kit: Record<string, KitTarget[]> = {};
  for (const [n, v] of Object.entries(p.kit as Record<string, KitTarget | KitTarget[]>)) kit[n] = Array.isArray(v) ? [...v] : [v];
  const ver = p.kitVersion ?? 1;
  if (ver < 2 && kit['57']?.includes('crash')) kit['57'] = kit['57'].map(t => (t === 'crash' ? 'crash2' : t));
  if (ver < 3 && kit['46']?.includes('hihat')) kit['46'] = kit['46'].map(t => (t === 'hihat' ? 'hihat_open' : t));
  return { ...p, kit, kitVersion: KIT_VERSION };
}

/**
 * Merges two copies of the device settings: the newest wins (no date or a tie: the second one).
 * Used when importing saved settings.
 */
export function mergeDevices(local: Pick<Profile, 'devices' | 'devicesUpdatedAt'>,
                             remote: Partial<Pick<Profile, 'devices' | 'devicesUpdatedAt'>>) {
  const devices: Profile['devices'] = { ...local.devices };
  const devicesUpdatedAt: NonNullable<Profile['devicesUpdatedAt']> = { ...(local.devicesUpdatedAt ?? {}) };
  for (const k of Object.keys(remote.devices ?? {}) as DeviceKind[]) {
    const lt = local.devicesUpdatedAt?.[k] ?? 0;
    const rt = remote.devicesUpdatedAt?.[k] ?? 0;
    if (!local.devices[k] || rt >= lt) {
      devices[k] = remote.devices![k];
      devicesUpdatedAt[k] = rt;
    }
  }
  return { devices, devicesUpdatedAt };
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  readonly device: DeviceKind =
    /android|iphone|ipad/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches ? 'mobile' : 'pc';

  readonly profile = signal<Profile>(this.loadLocal());

  /** Piece colors in use (default + chosen). The highways are notified through `colorsVersion`. */
  readonly laneColors = computed(() => ({ ...DEFAULT_LANE_COLOR, ...(this.profile().laneColors ?? {}) }));
  readonly colorsVersion = signal(0);

  constructor() {
    // settings live on the device itself (the exe and the apk each have their own)
    effect(() => {
      const p = this.profile();
      try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* no storage */ }
    });
    applyLaneColors(this.profile().laneColors);
    effect(() => {
      if (applyLaneColors(this.profile().laneColors)) this.colorsVersion.update(v => v + 1);
    });
  }

  setLaneColor(lane: Lane, color: string): void {
    const c = normalizeHex(color);
    if (!c) return;
    this.profile.update(p => ({ ...p, laneColors: { ...(p.laneColors ?? {}), [lane]: c } }));
  }

  resetLaneColors(): void {
    this.profile.update(p => ({ ...p, laneColors: {} }));
  }

  get dev(): DeviceSettings {
    return { ...DEFAULT_DEVICE(this.device), ...(this.profile().devices[this.device] ?? {}) };
  }

  updateDevice(patch: Partial<DeviceSettings>): void {
    this.profile.update(p => ({
      ...p,
      devices: { ...p.devices, [this.device]: { ...this.dev, ...patch } },
      devicesUpdatedAt: { ...(p.devicesUpdatedAt ?? {}), [this.device]: Date.now() },
    }));
  }

  /** Adds a command to the note (the same note can trigger several pieces). */
  setKit(note: number, target: KitTarget): void {
    this.profile.update(p => {
      const k = String(note), cur = p.kit[k] ?? [];
      if (cur.includes(target)) return p;
      return { ...p, kit: { ...p.kit, [k]: [...cur, target] } };
    });
  }

  /** Removes a command from the note; the note becomes unmapped if none is left. */
  removeTarget(note: number, target: KitTarget): void {
    this.profile.update(p => {
      const k = String(note);
      const next = (p.kit[k] ?? []).filter(t => t !== target);
      const kit = { ...p.kit };
      if (next.length) kit[k] = next; else delete kit[k];
      return { ...p, kit };
    });
  }

  resetKit(): void {
    this.profile.update(p => ({ ...p, kit: { ...DEFAULT_KIT }, keys: { ...DEFAULT_KEYS } }));
  }

  setLyrics(lyrics: boolean): void {
    this.profile.update(p => ({ ...p, lyrics }));
  }

  setStrict(strict: boolean): void {
    this.profile.update(p => ({ ...p, strict }));
  }

  /** PC keys (PC only): same idea as the drum notes. */
  keys(): Record<string, KitTarget[]> {
    return this.profile().keys ?? DEFAULT_KEYS;
  }

  setKey(code: string, target: KitTarget): void {
    this.profile.update(p => {
      const keys = { ...(p.keys ?? DEFAULT_KEYS) };
      const cur = keys[code] ?? [];
      if (!cur.includes(target)) keys[code] = [...cur, target];
      return { ...p, keys };
    });
  }

  removeKeyTarget(code: string, target: KitTarget): void {
    this.profile.update(p => {
      const keys = { ...(p.keys ?? DEFAULT_KEYS) };
      const next = (keys[code] ?? []).filter(t => t !== target);
      if (next.length) keys[code] = next; else delete keys[code];
      return { ...p, keys };
    });
  }

  private loadLocal(): Profile {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw) as Profile;
        return migrate({ ...p, kit: { ...DEFAULT_KIT, ...p.kit }, devices: p.devices ?? {}, strict: !!p.strict });
      }
    } catch { /* ignore */ }
    return { kit: { ...DEFAULT_KIT }, devices: {}, strict: false };
  }
}
