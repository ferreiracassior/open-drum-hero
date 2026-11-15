/**
 * Where the app is running. The interface and logic are the same everywhere; only the system
 * parts change: reading the drum kit (MIDI), Songsterr login/download and saving files.
 *
 * - 'electron': the Windows exe (desktop/ folder). Exposes `window.drumhero` through the preload.
 * - 'android':  the apk (Capacitor, frontend/android folder). Native DrumHero plugin (USB drum kit, save file, Songsterr).
 * - 'web':      regular browser (development with `ng serve`). Drum kit via Web MIDI.
 */
export type PlatformKind = 'electron' | 'android' | 'web';

/** API exposed by the Electron preload (desktop/preload.cjs). */
export interface DesktopBridge {
  version: string;
  songsterr: {
    /** Opens Songsterr in an app window (login if needed) and returns the downloaded files. */
    fetch(url: string, lang?: string): Promise<SongsterrFiles>;
    cancel(): Promise<void>;
    onProgress(cb: (msg: string) => void): () => void;
  };
}

/** Native apk plugin (android/app/src/main/java/com/drumhero/app/DrumHeroPlugin.java). */
export interface DrumHeroNative {
  startMidi(): Promise<{ ports: string[] }>;
  saveFile(o: { name: string; data: string; mime: string }): Promise<{ path: string }>;
  fetchSongsterr(o: { url: string; lang?: string }): Promise<{ gp?: string; gpName?: string; mid?: string; videoPoints?: string; url: string }>;
  addListener(ev: 'midi', cb: (e: { status: number; data1: number; data2: number; ageMs: number }) => void): Promise<{ remove(): void }>;
  addListener(ev: 'midiStatus', cb: (e: { ports: string[] }) => void): Promise<{ remove(): void }>;
  addListener(ev: 'songsterrProgress', cb: (e: { message: string }) => void): Promise<{ remove(): void }>;
}

export interface NativePlugins { DrumHero?: DrumHeroNative; }

export interface SongsterrFiles {
  url: string;
  gp?: Uint8Array;
  gpName?: string;
  mid?: Uint8Array;
  /** Songsterr's /api/video-points JSON (synced YouTube videos), if it came. */
  videoPoints?: unknown;
}

declare global {
  interface Window {
    drumhero?: DesktopBridge;
    Capacitor?: { isNativePlatform(): boolean; getPlatform(): string; Plugins: NativePlugins };
  }
}

export function platformKind(): PlatformKind {
  if (window.drumhero) return 'electron';
  if (window.Capacitor?.isNativePlatform?.() && window.Capacitor.getPlatform() === 'android') return 'android';
  return 'web';
}

export function nativePlugins(): NativePlugins {
  return window.Capacitor?.Plugins ?? {};
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Saves a file for the user: on the PC/browser it goes to the Downloads folder; on the apk it goes to
 * Download/OpenDrumHero (Android's WebView doesn't download files by itself). Returns where it ended up.
 */
export async function saveFile(name: string, data: Blob): Promise<string> {
  const plugin = nativePlugins().DrumHero;
  if (platformKind() === 'android' && plugin) {
    const r = await plugin.saveFile({ name, mime: data.type || 'application/octet-stream',
      data: bytesToBase64(new Uint8Array(await data.arrayBuffer())) });
    return r.path;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return `Downloads/${name}`;
}
