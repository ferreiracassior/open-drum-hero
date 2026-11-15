import type { SongPackage, SongSummary } from './protocol';
import { t } from './i18n';

/**
 * Library stored on the device itself (IndexedDB), the same in the exe and the apk.
 * Each song = the chart package (song.json) + its files (source.gp, source.mid).
 * In the exe, every change is also written to files (library/ folder, next to the exe) through a "mirror"
 * set by platform/desktop-browser.ts, so the library doesn't depend on the browser's storage.
 */

const DB = 'drumhero-library';
const SONGS = 'songs';
const FILES = 'files';

export interface SongRow {
  id: string; pkg: SongPackage; addedAt: number; isNew?: boolean;
  /** When it last changed (ms) and whether the copy on disk (exe) already has that change. */
  updatedAt?: number; synced?: boolean;
}

/** Copy of the library outside the browser (exe: files on disk). */
export interface LibraryMirror {
  /** Saves the song; without `files`, only the library info/chart (the files on disk stay). */
  put(row: SongRow, files?: Record<string, Uint8Array>): Promise<void>;
  remove(id: string): Promise<void>;
}
let mirror: LibraryMirror | null = null;
export function setLibraryMirror(m: LibraryMirror | null): void { mirror = m; }

/** Sends a change to the mirror; when it is written there, marks the song as synced. */
async function toMirror(row: SongRow, files?: Record<string, Uint8Array>): Promise<void> {
  if (!mirror) return;
  try {
    await mirror.put(row, files);
    const d = await db();
    const cur = await done(d.transaction(SONGS).objectStore(SONGS).get(row.id) as IDBRequest<SongRow | undefined>);
    if (!cur || cur.updatedAt !== row.updatedAt) return;   // changed again meanwhile: that change syncs itself
    const tx = d.transaction(SONGS, 'readwrite');
    tx.objectStore(SONGS).put({ ...cur, synced: true });
    await txDone(tx);
  } catch (e) {
    console.warn('could not save the song to disk (it will be retried on the next start)', e);
  }
}
interface FileRow { key: string; id: string; name: string; data: Blob; }

/**
 * Format of a song's export file (to move it from the PC to the phone and vice versa).
 * Carries the whole package: notes, files (GP/MIDI for the synthetic sound) and, for Songsterr songs,
 * the YouTube videos with per-bar sync (pkg.audio.youtube) — nothing is lost on the way back.
 */
export const EXPORT_FORMAT = 'drumhero-song-v1';
export interface ExportedSong { format: typeof EXPORT_FORMAT; pkg: SongPackage; files: Record<string, string>; }

let dbPromise: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore(SONGS, { keyPath: 'id' });
      d.createObjectStore(FILES, { keyPath: 'key' }).createIndex('byId', 'id');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = undefined; reject(req.error); };
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function summarize(pkg: SongPackage): SongSummary {
  return {
    id: pkg.id, title: pkg.title, artist: pkg.artist, durationMs: pkg.durationMs, sections: pkg.sections.length,
    audio: [pkg.audio.synth ? 'synth' : '', pkg.audio.youtube?.length ? 'youtube' : ''].filter(Boolean),
  };
}

export async function listSongs(): Promise<SongSummary[]> {
  const rows = await done((await db()).transaction(SONGS).objectStore(SONGS).getAll() as IDBRequest<SongRow[]>);
  return rows.map(r => ({ ...summarize(r.pkg), isNew: !!r.isNew })).sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
}

export async function getSong(id: string): Promise<SongPackage | undefined> {
  const row = await done((await db()).transaction(SONGS).objectStore(SONGS).get(id) as IDBRequest<SongRow | undefined>);
  return row?.pkg;
}

export async function readFile(id: string, name: string): Promise<Uint8Array | undefined> {
  const row = await done((await db()).transaction(FILES).objectStore(FILES).get(`${id}/${name}`) as IDBRequest<FileRow | undefined>);
  return row ? new Uint8Array(await row.data.arrayBuffer()) : undefined;
}

/** Updates only the chart package of an already stored song (keeps files, date and "new"). */
export async function updatePkg(pkg: SongPackage): Promise<void> {
  const d = await db();
  const row = await done(d.transaction(SONGS).objectStore(SONGS).get(pkg.id) as IDBRequest<SongRow | undefined>);
  if (!row) return;
  const next: SongRow = { ...row, pkg, updatedAt: Date.now(), synced: false };
  const tx = d.transaction(SONGS, 'readwrite');
  tx.objectStore(SONGS).put(next);
  await txDone(tx);
  await toMirror(next);
}

/** Saves (or replaces) a song with its files. */
export async function saveSong(pkg: SongPackage, files: Record<string, Uint8Array>): Promise<void> {
  const d = await db();
  const old = await done(d.transaction(FILES).objectStore(FILES).index('byId').getAllKeys(pkg.id));
  const now = Date.now();
  const row: SongRow = { id: pkg.id, pkg, addedAt: now, isNew: true, updatedAt: now, synced: false };
  await putLocal(row, files, old);
  await toMirror(row, files);
}

/** Writes a song (row + files) only in this browser, replacing the files it had. */
async function putLocal(row: SongRow, files: Record<string, Uint8Array>, oldKeys?: IDBValidKey[]): Promise<void> {
  const d = await db();
  const old = oldKeys ?? await done(d.transaction(FILES).objectStore(FILES).index('byId').getAllKeys(row.id));
  const tx = d.transaction([SONGS, FILES], 'readwrite');
  tx.objectStore(SONGS).put(row);
  const fs = tx.objectStore(FILES);
  for (const k of old) fs.delete(k);
  for (const [name, data] of Object.entries(files)) {
    fs.put({ key: `${row.id}/${name}`, id: row.id, name, data: new Blob([data.slice().buffer]) } satisfies FileRow);
  }
  await txDone(tx);
}

export async function deleteSong(id: string): Promise<void> {
  await deleteLocal(id);
  try { await mirror?.remove(id); } catch (e) { console.warn('could not delete the song from disk', e); }
}

async function deleteLocal(id: string): Promise<void> {
  const d = await db();
  const keys = await done(d.transaction(FILES).objectStore(FILES).index('byId').getAllKeys(id));
  const tx = d.transaction([SONGS, FILES], 'readwrite');
  tx.objectStore(SONGS).delete(id);
  for (const k of keys) tx.objectStore(FILES).delete(k);
  await txDone(tx);
}

export async function songExists(id: string): Promise<boolean> {
  return !!(await getSong(id));
}

/** Removes the "new" tag from the card: the song was opened to play. */
export async function markPlayed(id: string): Promise<void> {
  const d = await db();
  const row = await done(d.transaction(SONGS).objectStore(SONGS).get(id) as IDBRequest<SongRow | undefined>);
  if (!row?.isNew) return;
  const next: SongRow = { ...row, isNew: false, updatedAt: Date.now(), synced: false };
  const tx = d.transaction(SONGS, 'readwrite');
  tx.objectStore(SONGS).put(next);
  await txDone(tx);
  await toMirror(next);
}

// ------------------------------------------------------------------ sync with the copy on disk (exe)

/** Every song row in this browser. */
export async function allRows(): Promise<SongRow[]> {
  return done((await db()).transaction(SONGS).objectStore(SONGS).getAll() as IDBRequest<SongRow[]>);
}

/** All files of a song. */
export async function readAllFiles(id: string): Promise<Record<string, Uint8Array>> {
  const rows = await done((await db()).transaction(FILES).objectStore(FILES).index('byId').getAll(id) as IDBRequest<FileRow[]>);
  const out: Record<string, Uint8Array> = {};
  for (const r of rows) out[r.name] = new Uint8Array(await r.data.arrayBuffer());
  return out;
}

/** Brings a song from disk into this browser (already synced). */
export async function putFromMirror(row: SongRow, files: Record<string, Uint8Array>): Promise<void> {
  await putLocal({ ...row, synced: true }, files);
}

/** The song was deleted on disk: delete it here too (without touching the disk). */
export async function deleteFromMirror(id: string): Promise<void> {
  await deleteLocal(id);
}

/** Sends a song from this browser to disk (song that wasn't synced yet). */
export async function pushToMirror(row: SongRow): Promise<void> {
  const r = row.updatedAt ? row : { ...row, updatedAt: row.addedAt || Date.now() };
  if (r !== row) {
    const tx = (await db()).transaction(SONGS, 'readwrite');
    tx.objectStore(SONGS).put(r);
    await txDone(tx);
  }
  await toMirror(r, await readAllFiles(r.id));
}

const norm = (s: string) => (s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** A song already in the library with the same name and band (ignores accents, case and punctuation). */
export async function findDuplicate(title: string, artist: string): Promise<SongPackage | undefined> {
  const t = norm(title), a = norm(artist);
  const rows = await done((await db()).transaction(SONGS).objectStore(SONGS).getAll() as IDBRequest<SongRow[]>);
  return rows.find(r => norm(r.pkg.title) === t && norm(r.pkg.artist) === a)?.pkg;
}

export class DuplicateSongError extends Error {
  constructor(pkg: Pick<SongPackage, 'title' | 'artist'>) {
    super(t('err.duplicate', { song: `"${pkg.title}"${pkg.artist ? ` (${pkg.artist})` : ''}` }));
  }
}

/** Error if a song with the same name + band already exists (importing doesn't replace). */
export async function assertNew(pkg: Pick<SongPackage, 'title' | 'artist'>): Promise<void> {
  if (await findDuplicate(pkg.title, pkg.artist)) throw new DuplicateSongError(pkg);
}

// ------------------------------------------------------------------ export / import

export async function exportSong(id: string): Promise<Blob> {
  const pkg = await getSong(id);
  if (!pkg) throw new Error(t('err.songNotFound'));
  const d = await db();
  const rows = await done(d.transaction(FILES).objectStore(FILES).index('byId').getAll(id) as IDBRequest<FileRow[]>);
  const files: Record<string, string> = {};
  for (const r of rows) files[r.name] = toB64(new Uint8Array(await r.data.arrayBuffer()));
  const out: ExportedSong = { format: EXPORT_FORMAT, pkg, files };
  return new Blob([JSON.stringify(out)], { type: 'application/json' });
}

/** Imports a .drumhero.json file (exported on another device). Returns the song id. */
export async function importExported(text: string): Promise<string> {
  let data: ExportedSong;
  try { data = JSON.parse(text) as ExportedSong; } catch { throw new Error(t('err.invalidSongFile')); }
  if (data?.format !== EXPORT_FORMAT || !data.pkg?.id) throw new Error(t('err.notDrumHeroFile'));
  const files: Record<string, Uint8Array> = {};
  for (const [name, b64] of Object.entries(data.files ?? {})) files[name] = fromB64(b64);
  // YouTube videos (Songsterr songs): keep only the ones with a valid video and sync
  const youtube = (data.pkg.audio?.youtube ?? []).filter(v => v?.videoId && Array.isArray(v.syncPoints) && v.syncPoints.length);
  data.pkg.audio = { ...(data.pkg.audio ?? {}), youtube };
  if (files['source.mid']) data.pkg.audio.synth = { file: 'source.mid', offsetMs: 0 };
  await assertNew(data.pkg);
  await saveSong(data.pkg, files);
  return data.pkg.id;
}

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
