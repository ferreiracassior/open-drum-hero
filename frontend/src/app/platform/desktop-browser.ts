import * as store from '../core/library-store';
import { t } from '../core/i18n';
import { base64ToBytes } from './platform';

/**
 * Game opened by the exe in the PC's default browser (Chromium-based: in app mode). The exe injects
 * window.__drumheroDesktop into the page; here the bridge with it is built over /api on the local address,
 * with the same shape as the Electron bridge (window.drumhero) — the rest of the app doesn't change at all.
 * It also keeps the settings and the library in files on the PC (config/ and library/, next to the exe):
 * the browser's storage is just a copy, so changing browsers or clearing its data loses nothing.
 */
interface DesktopInfo { token: string; version: string; }
declare global { interface Window { __drumheroDesktop?: DesktopInfo; } }

interface PollResult {
  messages: string[]; done: boolean; error: string | null;
  result: { url: string; gp?: string; gpName?: string; mid?: string; videoPoints?: unknown } | null;
}

type Api = <T>(path: string, body?: unknown, keepalive?: boolean) => Promise<T>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** App settings saved by the exe: every localStorage key of the app. */
const SETTINGS_PREFIX = 'drumhero.';

export async function setupDesktopBrowser(): Promise<void> {
  const info = window.__drumheroDesktop;
  if (!info) return;

  const api: Api = async <T>(path: string, body?: unknown, keepalive = false): Promise<T> => {
    const r = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-DrumHero-Token': info.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      keepalive,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((data as { error?: string }).error ?? `error ${r.status}`);
    return data as T;
  };

  // in the exe's own window (fallback) the bridge comes from the preload; in the browser it is built here
  if (!window.drumhero) window.drumhero = songsterrBridge(info, api);

  // Quit the exe together with the game:
  //  - when the window closes, the page says "bye" and the exe quits in a few seconds;
  //  - heartbeat every 10 s; with no heartbeat for a while (dead window, browser force-closed), it
  //    quits by itself. The heartbeat comes from a worker: with the window minimized the browser throttles the
  //    page timers (down to once a minute), the worker's aren't.
  addEventListener('pagehide', () => {
    navigator.sendBeacon('/api/bye', new Blob([JSON.stringify({ token: info.token })], { type: 'text/plain' }));
  });
  const workerCode = `const t=${JSON.stringify(info.token)};const a=()=>fetch(${JSON.stringify(location.origin + '/api/alive')},{headers:{'X-DrumHero-Token':t},cache:'no-store'}).catch(()=>{});a();setInterval(a,10000);`;
  try {
    new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' })));
  } catch {
    const alive = () => void api('/api/alive').catch(() => {});
    alive();
    setInterval(alive, 10_000);
  }

  // before the app starts: settings first (the app reads them when it opens), then the library
  try { await syncSettings(api); } catch (e) { console.warn('settings on disk', e); }
  try { await syncLibrary(api); } catch (e) { console.warn('library on disk', e); }
}

function songsterrBridge(info: DesktopInfo, api: Api): NonNullable<Window['drumhero']> {
  const listeners = new Set<(msg: string) => void>();
  return {
    version: info.version,
    songsterr: {
      async fetch(url: string, language?: string) {
        const { id } = await api<{ id: string }>('/api/songsterr/start', { url, lang: language });
        let from = 0;
        for (;;) {
          await sleep(400);
          let r: PollResult;
          try { r = await api<PollResult>(`/api/songsterr/poll?id=${id}&from=${from}`); }
          catch { throw new Error(t('err.exeClosed')); }
          from += r.messages.length;
          for (const m of r.messages) listeners.forEach(l => l(m));
          if (!r.done) continue;
          if (r.error || !r.result) throw new Error(r.error ?? t('err.noFiles'));
          const x = r.result;
          return {
            url: x.url,
            gp: x.gp ? base64ToBytes(x.gp) : undefined,
            gpName: x.gpName,
            mid: x.mid ? base64ToBytes(x.mid) : undefined,
            videoPoints: x.videoPoints,
          };
        }
      },
      async cancel() { await api('/api/songsterr/cancel', {}); },
      onProgress(cb: (msg: string) => void) { listeners.add(cb); return () => listeners.delete(cb); },
    },
  };
}

// ------------------------------------------------------------------ settings (config/settings.json)

function appSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(SETTINGS_PREFIX)) out[k] = localStorage.getItem(k) ?? '';
  }
  return out;
}

/**
 * The file on disk wins when it exists (it is the reference); the 1st time, it is created from what this
 * browser has. From then on, every change the app makes to its settings is written to the file too.
 */
async function syncSettings(api: Api): Promise<void> {
  const disk = await api<{ exists: boolean; values: Record<string, string> }>('/api/settings');
  if (disk.exists) {
    for (const [k, v] of Object.entries(disk.values)) if (k.startsWith(SETTINGS_PREFIX)) localStorage.setItem(k, v);
  } else {
    await api('/api/settings', { values: appSettings() });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => { timer = undefined; void api('/api/settings', { values: appSettings() }, true).catch(() => {}); };
  const changed = (key: unknown) => {
    if (typeof key !== 'string' || !key.startsWith(SETTINGS_PREFIX)) return;
    clearTimeout(timer);
    timer = setTimeout(save, 300);
  };
  const proto = Storage.prototype;
  const setItem = proto.setItem, removeItem = proto.removeItem;
  proto.setItem = function (this: Storage, key: string, value: string) {
    setItem.call(this, key, value);
    if (this === localStorage) changed(key);
  };
  proto.removeItem = function (this: Storage, key: string) {
    removeItem.call(this, key);
    if (this === localStorage) changed(key);
  };
  addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); save(); } });
}

// ------------------------------------------------------------------ library (library/ folder)

interface DiskSong { row: store.SongRow; files: Record<string, string>; }

/**
 * Compares the songs on disk with the ones in this browser:
 *  - only on disk (or newer there): comes to the browser (e.g. another browser, or library copied from another PC);
 *  - only here and not synced yet: goes to disk (e.g. the 1st start with the library that was only in the browser);
 *  - only here but already synced: it was deleted from disk, so it is deleted here too — unless the library
 *    folder is empty (exe moved to another folder, new PC…): then everything here goes to the new folder.
 * Then every change in the library is also written to disk (library-store mirror).
 */
async function syncLibrary(api: Api): Promise<void> {
  const { songs } = await api<{ songs: { id: string; updatedAt: number }[] }>('/api/library');
  const onDisk = new Map(songs.map(s => [s.id, s.updatedAt]));
  const local = new Map((await store.allRows()).map(r => [r.id, r]));

  for (const [id, updatedAt] of onDisk) {
    const row = local.get(id);
    if (row && (!row.synced || (row.updatedAt ?? 0) >= updatedAt)) continue;
    try {
      const song = await api<DiskSong>(`/api/library/${encodeURIComponent(id)}`);
      const files: Record<string, Uint8Array> = {};
      for (const [name, b64] of Object.entries(song.files)) files[name] = store.fromB64(b64);
      await store.putFromMirror(song.row, files);
    } catch (e) { console.warn('could not read the song from disk', id, e); }
  }

  store.setLibraryMirror({
    async put(row, files) {
      const body: { row: store.SongRow; files?: Record<string, string> } = { row };
      if (files) body.files = Object.fromEntries(Object.entries(files).map(([n, d]) => [n, store.toB64(d)]));
      await api(`/api/library/${encodeURIComponent(row.id)}`, body);
    },
    async remove(id) { await api(`/api/library/${encodeURIComponent(id)}?delete=1`, {}); },
  });

  const emptyFolder = onDisk.size === 0;
  for (const row of local.values()) {
    if (!row.synced || emptyFolder) await store.pushToMirror(row);
    else if (!onDisk.has(row.id)) await store.deleteFromMirror(row.id);
  }
}
