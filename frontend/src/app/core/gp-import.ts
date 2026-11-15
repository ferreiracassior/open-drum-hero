import { t } from './i18n';

/**
 * Manual import of a Guitar Pro file (.gp, .gp5, .gpx…): here the file is only read to show
 * name, artist and whether it has drums before importing. The chart is built by SongService (chart-builder).
 */
export interface GpFile {
  fileName: string;
  title: string;
  artist: string;
  hasDrums: boolean;
  drumTracks: string[];
  gp: Uint8Array;
}

export const GP_EXTENSIONS = '.gp,.gp3,.gp4,.gp5,.gpx,.gp7,.gp8';

export async function readGpFile(file: File): Promise<GpFile> {
  const gp = new Uint8Array(await file.arrayBuffer());
  const at = await import('@coderline/alphatab');
  const settings = new at.Settings();
  let score;
  try {
    score = at.importer.ScoreLoader.loadScoreFromBytes(gp, settings);
  } catch {
    throw new Error(t('err.notGuitarPro'));
  }
  const drums = score.tracks.filter(t => t.staves.some(s => s.isPercussion));
  return {
    fileName: file.name,
    title: (score.title || '').trim() || file.name.replace(/\.[^.]+$/, ''),
    artist: (score.artist || '').trim(),
    hasDrums: drums.length > 0,
    drumTracks: drums.map(t => t.name || 'Bateria'),
    gp,
  };
}
