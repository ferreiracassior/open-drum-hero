import type { Measure, YoutubeSource } from '../core/protocol';
import { lang, t } from '../core/i18n';
import { SongsterrFiles, base64ToBytes, nativePlugins, platformKind } from './platform';

/**
 * Songsterr import inside the app (exe and apk), without a window: the song page opens hidden with
 * YOUR account, the app checks the login and downloads the Guitar Pro by itself (public/songsterr-auto.js). The login
 * window only appears if you haven't signed in yet. Requires Songsterr Plus (the download is their paid feature).
 */
export function songsterrAvailable(): boolean {
  const k = platformKind();
  return (k === 'electron' && !!window.drumhero?.songsterr) || (k === 'android' && !!nativePlugins().DrumHero);
}

export async function fetchFromSongsterr(url: string, onProgress: (msg: string) => void): Promise<SongsterrFiles> {
  const kind = platformKind();
  if (kind === 'electron' && window.drumhero) {
    const off = window.drumhero.songsterr.onProgress(onProgress);
    try {
      return await window.drumhero.songsterr.fetch(url, lang());
    } catch (e) {
      // strips Electron's technical prefix ("Error invoking remote method ...: Error: ")
      throw new Error(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      off();
    }
  }
  const plugin = nativePlugins().DrumHero;
  if (kind === 'android' && plugin) {
    const listener = await plugin.addListener('songsterrProgress', e => onProgress(e.message));
    try {
      const r = await plugin.fetchSongsterr({ url, lang: lang() });
      return {
        url: r.url,
        gp: r.gp ? base64ToBytes(r.gp) : undefined,
        gpName: r.gpName,
        mid: r.mid ? base64ToBytes(r.mid) : undefined,
        videoPoints: parseVideoPoints(r.videoPoints),
      };
    } finally {
      listener.remove();
    }
  }
  throw new Error(t('err.songsterrAppOnly'));
}

interface VideoPoints { status?: string; videoId?: string; points?: number[]; feature?: string | null; trackHashes?: string[]; }

/**
 * YouTube videos Songsterr itself syncs (video seconds at the start of each bar):
 * 'full' = original recording, 'nodrums' = original without drums (there may be more than one of each).
 */
export function youtubeSources(points: unknown, measures: Measure[]): YoutubeSource[] {
  const out: YoutubeSource[] = [];
  if (!Array.isArray(points)) return out;
  const sync = (p: number[]) => p.slice(0, measures.length).map((s, i) => ({ chartMs: measures[i].ms, videoMs: Math.round(s * 10000) / 10 }));
  for (const v of points as VideoPoints[]) {
    if (v.status !== 'done' || !v.videoId || !v.points?.length) continue;
    const hashes = (v.trackHashes ?? []).join(' ').toLowerCase();
    // keep all the synced videos (the first of each type is the main one): if YouTube blocks
    // one of them outside their site, the game tries the next one before falling back to synthetic audio
    const kind = v.feature == null ? 'full' : v.feature === 'backing' && hashes.includes('drums') ? 'nodrums' : null;
    if (kind && !out.some(o => o.videoId === v.videoId && o.kind === kind)) out.push({ videoId: v.videoId, kind, syncPoints: sync(v.points) });
  }
  return out;
}

export function songsterrIdFromUrl(url: string): number | null {
  const m = url.match(/songsterr\.com\/\S+?-s(\d+)(?:t\d+)?\b/i);
  return m ? Number(m[1]) : null;
}

/** Video points coming from the apk: if it isn't a valid list, the song just ends up without YouTube. */
function parseVideoPoints(text: string | undefined): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
