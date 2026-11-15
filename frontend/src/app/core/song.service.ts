import { Injectable, signal } from '@angular/core';
import { t } from './i18n';
import { Observable, from } from 'rxjs';
import { LYRICS_VERSION, buildSongFromGp } from './chart-builder';
import * as store from './library-store';
import { SongPackage, SongSummary } from './protocol';
import { fetchFromSongsterr, youtubeSources } from '../platform/songsterr';

export interface IngestJob {
  jobId: string;
  url: string;
  step: string;
  message: string;
  pct: number;
  state: 'running' | 'done' | 'error';
  songId?: string;
}

/**
 * Song library, stored on the device itself (exe and apk; see library-store.ts).
 * Imports from a Guitar Pro file (on the device, with alphaTab) or from Songsterr (app window).
 */
@Injectable({ providedIn: 'root' })
export class SongService {
  readonly jobs = signal<IngestJob[]>([]);
  readonly libraryVersion = signal(0);

  list(): Observable<SongSummary[]> {
    return from(store.listSongs());
  }

  get(id: string): Observable<SongPackage> {
    return from(store.getSong(id).then(p => {
      if (!p) throw new Error(t('err.songNotFound'));
      return this.fixLyrics(p);
    }));
  }

  /**
   * Songs imported before the karaoke fix: rebuild only the lyrics from the stored Guitar Pro
   * (the lyrics moved one note early on every tied note). Once per song; if it fails, keep it as is.
   */
  private async fixLyrics(p: SongPackage): Promise<SongPackage> {
    if (!p.lyrics?.length || (p.lyricsV ?? 1) >= LYRICS_VERSION) return p;
    try {
      const gp = await store.readFile(p.id, 'source.gp');
      if (!gp) return p;
      const { pkg } = await buildSongFromGp(gp, { id: p.id, title: p.title, artist: p.artist });
      const fixed = { ...p, lyrics: pkg.lyrics, lyricsV: LYRICS_VERSION };
      await store.updatePkg(fixed);
      return fixed;
    } catch (e) {
      console.warn('could not rebuild the lyrics', e);
      return p;
    }
  }

  delete(id: string): Observable<unknown> {
    return from(store.deleteSong(id).then(() => this.refreshLibrary()));
  }

  /** Bytes of a song file (e.g. source.mid for the synthetic sound). */
  async readFile(id: string, file: string): Promise<Uint8Array> {
    const data = await store.readFile(id, file);
    if (!data) throw new Error(t('err.fileNotFound', { file }));
    return data;
  }

  refreshLibrary(): void {
    this.libraryVersion.update(v => v + 1);
  }

  /** Guitar Pro file chosen on the device: builds the chart right here and stores it. */
  async importGp(gp: Uint8Array, title: string, artist: string, fileName: string): Promise<string> {
    await store.assertNew({ title, artist });   // same song (name + band): doesn't replace
    const { pkg, mid } = await buildSongFromGp(gp, { title, artist });
    (pkg as SongPackage & { source?: unknown }).source = { kind: 'gp', fileName };
    await store.saveSong(pkg, { 'source.gp': gp, 'source.mid': mid });
    this.refreshLibrary();
    return pkg.id;
  }

  /** Songsterr import (requires Plus): downloads the Guitar Pro through the app window and builds the chart. */
  ingest(url: string): void {
    const jobId = 'j' + Date.now();
    this.jobs.set([{ jobId, url, step: 'start', message: t('job.openingSongsterr'), pct: 5, state: 'running' }]);
    void (async () => {
      try {
        const files = await fetchFromSongsterr(url, message => this.patch(jobId, { message, pct: 30 }));
        if (!files.gp) throw new Error(t('err.noGpFromSongsterr'));
        this.patch(jobId, { message: t('job.buildingChart'), pct: 85 });
        const { pkg, mid } = await buildSongFromGp(files.gp);
        await store.assertNew(pkg);
        pkg.audio.youtube = youtubeSources(files.videoPoints, pkg.measures);
        (pkg as SongPackage & { songsterr?: unknown }).songsterr = { url };
        await store.saveSong(pkg, { 'source.gp': files.gp, 'source.mid': mid });
        this.patch(jobId, { state: 'done', songId: pkg.id, pct: 100, message: t('import.importedOne', { title: pkg.title }) });
        this.refreshLibrary();
      } catch (e) {
        this.patch(jobId, { state: 'error', message: (e as Error).message });
      }
    })();
  }

  /** Single notice in the import area (replaces the previous one). */
  notify(message: string, state: IngestJob['state'] = 'done', songId?: string): void {
    this.jobs.set([{ jobId: 'n' + Date.now(), url: '', step: state, state, pct: state === 'error' ? 0 : 100, message, songId }]);
  }

  /** Opened the song to play: it is no longer "new". */
  markPlayed(id: string): void {
    void store.markPlayed(id).catch(() => {});
  }

  private patch(jobId: string, p: Partial<IngestJob>): void {
    this.jobs.update(list => list.map(j => (j.jobId === jobId ? { ...j, ...p } : j)));
  }
}

/** Finds the Songsterr link inside a shared text. */
export function extractSongsterrUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const m = t?.match(/https?:\/\/(?:www\.)?songsterr\.com\/\S+/i);
    if (m) return m[0].replace(/[).,]+$/, '');
  }
  return null;
}
