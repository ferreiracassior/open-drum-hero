import type { Lane } from '../core/protocol';

/** Piece icons (neon stroke in the piece color), the same as the highway; without three.js so the screens can use them too. */

/** The same highway icon as an image (for the Colors screen in Settings). */
export function instrumentIconUrl(lane: Lane, color: string, size = 96): string {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.scale(size / 128, size / 128);
  drawInstrumentIcon(g, lane, color);
  return c.toDataURL('image/png');
}

export function drawInstrumentIcon(g: CanvasRenderingContext2D, lane: Lane, color: string): void {
  {
    g.lineWidth = 5;
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = color;
    g.fillStyle = color + '40';
    g.shadowColor = color;
    g.shadowBlur = 10;
    const ell = (cx: number, cy: number, rx: number, ry: number, fill = true) => {
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (fill) g.fill();
      g.stroke();
    };
    const line = (x1: number, y1: number, x2: number, y2: number) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
    const drum = (top: number, h: number, rx: number) => {
      g.beginPath();
      g.moveTo(64 - rx, top); g.lineTo(64 - rx, top + h);
      g.ellipse(64, top + h, rx, rx * 0.3, 0, Math.PI, 0, true);
      g.lineTo(64 + rx, top);
      g.fill(); g.stroke();
      ell(64, top, rx, rx * 0.3, false);
      for (let i = -2; i <= 2; i++) line(64 + i * rx * 0.42, top + rx * 0.28, 64 + i * rx * 0.42, top + h + rx * 0.2);
    };
    switch (lane) {
      case 'crash':
      case 'crash2':
        ell(64, 44, 44, 11); ell(64, 41, 9, 4); line(64, 52, 64, 112); line(64, 112, 44, 122); line(64, 112, 84, 122);
        g.shadowBlur = 0;
        g.fillStyle = color;
        g.font = '900 30px system-ui, sans-serif';
        g.textAlign = 'center';
        g.fillText(lane === 'crash' ? '1' : '2', 98, 100);
        break;
      case 'ride':
        ell(64, 46, 50, 13); ell(64, 42, 12, 5); g.fillStyle = color; ell(64, 42, 5, 2); line(64, 56, 64, 112);
        line(64, 112, 44, 122); line(64, 112, 84, 122);
        break;
      case 'hihat':
        ell(64, 36, 40, 9); ell(64, 50, 40, 9); line(64, 12, 64, 36); line(64, 59, 64, 112); line(64, 112, 44, 122); line(64, 112, 84, 122);
        break;
      case 'snare':
        drum(48, 30, 42);
        break;
      case 'tom1':
        drum(34, 42, 34); line(64, 20, 64, 34);
        break;
      case 'tom2':
        drum(34, 46, 38); line(64, 20, 64, 34);
        break;
      case 'floor':
        drum(28, 64, 40); line(28, 92, 22, 122); line(100, 92, 106, 122);
        break;
      case 'kick':
        ell(64, 60, 46, 46); ell(64, 60, 30, 30, false); g.fillStyle = color; ell(64, 60, 6, 6);
        line(64, 106, 64, 122); line(40, 122, 88, 122);
        break;
    }
  }
}
