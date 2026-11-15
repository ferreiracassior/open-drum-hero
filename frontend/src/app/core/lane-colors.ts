import type { Lane } from './protocol';

/**
 * Piece colors on both highways (default by intensity: stronger = more saturated and vivid;
 * the hi-hat is the most neutral). The player can change each one in Settings → Colors.
 */
export const DEFAULT_LANE_COLOR: Record<Lane, string> = {
  crash: '#ff2d2d',
  crash2: '#ff3d9a',
  ride: '#ff7a1a',
  snare: '#ffd21a',
  kick: '#f2ecff',
  tom1: '#3ddc84', tom2: '#3aa0ff',
  floor: '#8e5bd6',
  hihat: '#8fe6ff',
};

/**
 * Colors in use (the highways read from here every frame). It is a single object that changes in place when the
 * player picks another color; `laneColorVersion` increases on every change for whoever needs to redraw something fixed.
 */
export const LANE_COLOR: Record<Lane, string> = { ...DEFAULT_LANE_COLOR };
let version = 0;
export const laneColorVersion = () => version;

export function applyLaneColors(custom: Partial<Record<Lane, string>> | undefined): boolean {
  let changed = false;
  for (const lane of Object.keys(DEFAULT_LANE_COLOR) as Lane[]) {
    const c = normalizeHex(custom?.[lane]) ?? DEFAULT_LANE_COLOR[lane];
    if (LANE_COLOR[lane] !== c) { LANE_COLOR[lane] = c; changed = true; }
  }
  if (changed) version++;
  return changed;
}

export function normalizeHex(v: string | undefined | null): string | null {
  if (!v) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** Ready-made palette: the whole color wheel in vivid tones, then light tones and some neutrals. */
export const COLOR_PALETTE: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 24; i++) out.push(hsl(i * 15, 100, 55));          // vivid (24 hues)
  for (let i = 0; i < 12; i++) out.push(hsl(i * 30 + 8, 100, 75));      // light
  for (let i = 0; i < 12; i++) out.push(hsl(i * 30 + 15, 85, 42));      // strong/dark
  out.push('#ffffff', '#dfe4ef', '#a9b3c7');                              // neutrals
  return out;
})();

function hsl(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const x = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${x(f(0))}${x(f(8))}${x(f(4))}`;
}
