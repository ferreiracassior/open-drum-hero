import { Antialias } from '../core/settings.service';

/** MSAA samples (three limits it to the maximum the GPU accepts). */
export const MSAA_SAMPLES = 4;

/**
 * Internal resolution of the highways. At "max" it draws up to 2x the screen resolution
 * (supersampling, limited to 3x the CSS pixels); otherwise it uses the screen's, up to `cap`.
 */
export function pixelRatioFor(aa: Antialias, cap: number): number {
  const dpr = window.devicePixelRatio || 1;
  return aa === 'max' ? Math.min(dpr * 2, 3) : Math.min(dpr, cap);
}
