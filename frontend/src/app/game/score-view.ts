import * as THREE from 'three';
import { Beat, Lane } from '../core/protocol';
import { PlayNote, SectionRange } from './chart';
import { LANE_COLOR } from '../core/lane-colors';
import { Judgement, lowerBound } from './scoring';
import { Antialias } from '../core/settings.service';
import { pixelRatioFor } from './antialias';

type Status = (id: number) => 'pending' | 'hit' | 'miss';

/**
 * Position on the staff (0 = bottom line, E4; odd = space). Common drum notation:
 * kick F4 · floor tom A4 · snare C5 · tom 2 D5 · tom 1 E5 · ride F5 · hi-hat G5 · crash A5 · crash 2 B5 · pedal D4.
 */
const STAFF_POS: Record<Lane, number> = {
  kick: 1, floor: 3, snare: 5, tom2: 6, tom1: 7, ride: 8, hihat: 9, crash: 10, crash2: 11,
};
const PEDAL_POS = -1;
const X_HEAD = new Set<Lane>(['hihat', 'ride', 'crash', 'crash2']);
const PLAYHEAD = 0.3;          // hit line (fraction of the width)
const AHEAD_MS = 3200;         // how much of the song shows ahead of the line at 1x

const JUDGE_COLOR: Record<Judgement, string> = {
  perfect: '#ffffff', great: '#9ff3ff', good: '#ffd21a', miss: '#ff4d4d', extra: '#ff4d4d',
};

const C = (hex: string) => new THREE.Color(hex);
/** Piece color as a THREE.Color (follows color changes made in Settings → Colors). */
const laneColorCache = new Map<string, THREE.Color>();
const laneC = (lane: Lane): THREE.Color => {
  const hex = LANE_COLOR[lane];
  let c = laneColorCache.get(hex);
  if (!c) { c = C(hex); laneColorCache.set(hex, c); }
  return c;
};
const JUDGE_C = Object.fromEntries(Object.entries(JUDGE_COLOR).map(([k, v]) => [k, C(v)])) as Record<Judgement, THREE.Color>;
const MISS_C = C('#5b6170');
const ACCENT_C = C('#38e1ff');
const STAFF_C = C('#a0d7ff');
const BEAT_C = C('#8cc8ff');
const SECTION_C = C('#ffffff');

/**
 * Score mode in WebGL: horizontal drum staff, with the highway colors.
 * The song runs from right to left; the hit line stays fixed.
 * Each element type (heads, X, glows, marks, lines) is ONE instanced batch drawn
 * by the GPU, and only the instances in use are sent each frame — nothing is recreated per frame.
 * Clicking on the staff gives the chart instant at that point (`timeAt`).
 */
export class ScoreView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private notes: PlayNote[] = [];
  private beats: Beat[] = [];
  private downbeats: number[] = [];
  private sections: SectionRange[] = [];
  private sectionLabels: string[] = [];
  private status: Status = () => 'pending';
  private w = 0;
  private h = 0;
  private resizeObs: ResizeObserver;
  private now = 0;
  private pxPerMs = 0.2;
  private flashes = new Map<string, number>();
  private bursts: { s: number; color: THREE.Color; at: number }[] = [];
  /** Notes before this instant don't show (countdown when resuming from pause: empty run-up). */
  hideBefore = -Infinity;
  /** Size of notes and marks (1 = default), chosen in the bottom bar. */
  noteScale = 1;
  /** Width (CSS px) of this song's longest section name, so the lyrics don't sit on top of it. */
  onLabelWidth?: (px: number) => void;

  private bg: THREE.Mesh;
  private bgTex: THREE.CanvasTexture;
  private rects: Sprites;      // staff lines, beats, bars, sections, hit line, ledger lines
  private glow: Sprites;       // note glow (additive)
  private ovals: Sprites;      // drums
  private crosses: Sprites;    // cymbals (X)
  private openMark: Sprites;   // open hi-hat "o"
  private halfMark: Sprites;   // half-open hi-hat "ø"
  private accents: Sprites;    // ">"
  private parens: Sprites;     // ghost note "( )"
  private flashGlow: Sprites;  // hit on the hit line (additive)
  private rings: Sprites;      // judgement ring
  private labels: Label[] = [];
  private labelTex = new Map<string, { tex: THREE.CanvasTexture; w: number; h: number }>();
  private labelPx = 0;
  private digits: Sprites;     // bar numbers (digit atlas: nothing is created during the song)
  private digitAtlas: DigitAtlas | null = null;
  private layoutKey = '';
  private readonly tmpColor = new THREE.Color();

  constructor(private canvas: HTMLCanvasElement, private aa: Antialias = 'msaa') {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: aa !== 'off', alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor('#04121a');
    this.bgTex = new THREE.CanvasTexture(document.createElement('canvas'));
    this.bgTex.colorSpace = THREE.SRGBColorSpace;
    this.bg = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: this.bgTex, depthTest: false, depthWrite: false }));
    this.bg.renderOrder = 0;
    this.scene.add(this.bg);

    const add = (s: Sprites) => { this.scene.add(s.mesh); return s; };
    this.rects = add(new Sprites(maskTexture(4, g => g.fillRect(0, 0, 4, 4)), 900, false, 1));
    this.glow = add(new Sprites(glowTexture(), 1024, true, 3));
    this.ovals = add(new Sprites(ovalTexture(), 1024, false, 4));
    this.crosses = add(new Sprites(crossTexture(), 1024, false, 4));
    this.openMark = add(new Sprites(ringTexture(0.18), 256, false, 5));
    this.halfMark = add(new Sprites(halfTexture(), 256, false, 5));
    this.accents = add(new Sprites(accentTexture(), 512, false, 5));
    this.parens = add(new Sprites(parenTexture(), 512, false, 5));
    this.flashGlow = add(new Sprites(glowTexture(), 16, true, 6));
    this.rings = add(new Sprites(ringTexture(0.07), 32, false, 7));
    this.digits = add(new Sprites(maskTexture(4, g => g.fillRect(0, 0, 4, 4)), 256, false, 2));
    for (let i = 0; i < 48; i++) {
      const l = new Label();
      this.labels.push(l);
      this.scene.add(l.mesh);
    }

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
  }

  setChart(notes: PlayNote[], beats: Beat[], sections: SectionRange[], status: Status): void {
    this.notes = [...notes].sort((a, b) => a.t - b.t);
    this.beats = beats;
    this.downbeats = beats.filter(b => b.downbeat).map(b => b.ms);
    this.sections = sections;
    this.sectionLabels = sections.map(s => s.name.toUpperCase());
    this.status = status;
    this.reportLabelWidth();
    this.warmLabels();
  }

  /**
   * Creates and uploads to the GPU, all at once, the textures of every section name and the digit atlas.
   * Creating a texture mid-song (on every new bar) caused a periodic hitch.
   */
  private warmLabels(): void {
    if (!this.labelPx) return;
    for (const t of this.sectionLabels) this.renderer.initTexture(this.sectionTexture(t).tex);
    if (!this.digitAtlas || this.digitAtlas.px !== Math.round(this.labelPx * 0.82)) {
      this.digitAtlas?.tex.dispose();
      this.digitAtlas = digitAtlas(Math.round(this.labelPx * 0.82));
      this.digits.setMap(this.digitAtlas.tex);
      this.renderer.initTexture(this.digitAtlas.tex);
    }
  }

  private sectionTexture(text: string): { tex: THREE.CanvasTexture; w: number; h: number } {
    let t = this.labelTex.get(text);
    if (!t) {
      t = textTexture(text, this.labelPx, '#c4cee2', 700);
      this.labelTex.set(text, t);
    }
    return t;
  }

  private reportLabelWidth(): void {
    if (!this.labelPx || !this.onLabelWidth) return;
    const g = document.createElement('canvas').getContext('2d')!;
    g.font = `700 ${this.labelPx}px system-ui, sans-serif`;
    let w = 0;
    for (const t of this.sectionLabels) w = Math.max(w, g.measureText(t).width);
    this.onLabelWidth(Math.ceil(w) + 2);
  }

  /** The hit lights up the piece on the hit line. */
  flash(lane: Lane, pedal = false): void {
    this.flashes.set(pedal ? 'pedal' : lane, performance.now());
  }

  /** Judgement ring on the hit line. */
  burst(lane: Lane, j: Judgement): void {
    this.bursts.push({ s: STAFF_POS[lane], color: JUDGE_C[j], at: performance.now() });
    if (this.bursts.length > 24) this.bursts.shift();
  }

  /** Chart instant (ms) under screen coordinate `clientX`. */
  timeAt(clientX: number): number {
    const r = this.canvas.getBoundingClientRect();
    return this.now + (clientX - r.left - this.w * PLAYHEAD) / this.pxPerMs;
  }

  render(now: number, scroll: number): void {
    const { w, h } = this;
    if (!w || !h) return;
    this.now = now;
    this.pxPerMs = (w * (1 - PLAYHEAD)) / (AHEAD_MS / Math.max(0.2, scroll));
    const px = w * PLAYHEAD;
    const half = Math.min(18, Math.max(6, h / 34));     // half the distance between lines
    // staff middle line (B4): below the scoreboard, but above the bottom buttons (~92 px)
    const cy = Math.min(h * 0.62, h - 92 - 6 * half);
    // screen coordinates (y down) -> scene (y up)
    const Y = (yDown: number) => h - yDown;
    const y = (s: number) => cy - (s - 4) * half;
    const x = (t: number) => px + (t - now) * this.pxPerMs;
    const tStart = now - px / this.pxPerMs;
    const tEnd = now + (w - px) / this.pxPerMs;
    const perf = performance.now();
    const top = y(12), bottom = y(-2);
    this.updateLayout(w, h, top, bottom, half);

    // ---- lines and markings
    const R = this.rects;
    R.begin();
    // sections
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      if (s.end < tStart || s.start > tEnd) continue;
      const sx = x(s.start);
      const y0 = top - half * 3.2, y1 = bottom + half * 0.2;
      R.add(sx + 0.75, Y((y0 + y1) / 2), 1.5, y1 - y0, SECTION_C, 0.10);
    }
    // beats and bars
    const staffTop = y(8), staffBottom = y(0);
    for (let i = lowerBoundMs(this.beats, tStart); i < this.beats.length && this.beats[i].ms <= tEnd; i++) {
      const b = this.beats[i];
      R.add(x(b.ms), Y((staffTop + staffBottom) / 2), b.downbeat ? 1.5 : 1, staffBottom - staffTop, BEAT_C, b.downbeat ? 0.42 : 0.09);
    }
    // staff lines
    for (let s = 0; s <= 8; s += 2) R.add(w / 2, Y(y(s)), w, 1.2, STAFF_C, 0.28);
    // hit line
    const phTop = y(12), phBottom = y(-3);
    R.add(px, Y((phTop + phBottom) / 2), 20, phBottom - phTop, ACCENT_C, 0.10);
    R.add(px, Y((phTop + phBottom) / 2), 3, phBottom - phTop, ACCENT_C, 1);

    // ---- texts: section names and bar numbers (textures made once and reused)
    let li = 0;
    for (let i = 0; i < this.sections.length && li < this.labels.length; i++) {
      const s = this.sections[i];
      if (s.end < tStart || s.start > tEnd) continue;
      li = this.placeLabel(li, this.sectionLabels[i], Math.max(x(s.start) + 6, 8), top - half * 1.6, 0.85);
    }
    for (let i = li; i < this.labels.length; i++) this.labels[i].mesh.visible = false;
    const D = this.digits, atlas = this.digitAtlas;
    D.begin();
    if (atlas) {
      for (let i = lowerBoundNum(this.downbeats, tStart); i < this.downbeats.length && this.downbeats[i] <= tEnd; i++) {
        let cx = x(this.downbeats[i]) + 3;
        const cy = Y(staffTop - 3 - atlas.h / 2);
        for (const ch of String(i + 1)) {
          const d = ch.charCodeAt(0) - 48;
          D.add(cx + atlas.adv[d] / 2, cy, atlas.cell, atlas.h, BEAT_C, 0.5, d / 10, 0, 0.1, 1);
          cx += atlas.adv[d];
        }
      }
    }

    // ---- notes
    const r = half * 0.92 * this.noteScale;
    this.glow.begin(); this.ovals.begin(); this.crosses.begin();
    this.openMark.begin(); this.halfMark.begin(); this.accents.begin(); this.parens.begin();
    const from = Math.max(tStart - 100, this.hideBefore);
    for (let i = Math.max(0, lowerBound(this.notes, from)); i < this.notes.length && this.notes[i].t <= tEnd + 100; i++) {
      const n = this.notes[i];
      const pedal = n.lane === 'hihat' && n.art === 'pedal';
      const s = pedal ? PEDAL_POS : STAFF_POS[n.lane];
      const nx = x(n.t), ny = y(s);
      const st = this.status(n.id);
      let alpha = 1;
      let col = laneC(n.lane);
      if (st === 'hit') alpha = n.t < now ? 0.3 + 0.7 * Math.max(0, 1 - (now - n.t) / 300) : 1;
      else if (st === 'miss') { col = MISS_C; alpha = 0.8; }
      else if (n.t < now - 150) alpha = 0.45;

      // ledger lines above the staff (crash / crash 2)
      if (s >= 10) for (let ls = 10; ls <= s; ls += 2) R.add(nx, Y(y(ls)), r * 3.6, 1.2, STAFF_C, 0.45 * alpha);

      this.glow.add(nx, Y(ny), r * 3.8, r * 3.8, col, 0.22 * alpha);
      if (X_HEAD.has(n.lane) || pedal) {
        this.crosses.add(nx, Y(ny), r * 2.5, r * 2.5, col, alpha);
        if (n.lane === 'hihat' && n.art === 'open') this.openMark.add(nx, Y(y(12.4)), r * 1.4, r * 1.4, col, alpha);
        else if (n.lane === 'hihat' && n.art === 'half') this.halfMark.add(nx, Y(y(12.4)), r * 1.8, r * 1.8, col, alpha);
      } else {
        this.ovals.add(nx, Y(ny), r * 2.7, r * 2.7, col, alpha);
      }
      if (n.acc) this.accents.add(nx, Y(ny - r * 2.1), r * 1.7, r * 1.2, col, alpha);       // accent (Songsterr)
      if (n.ghost) this.parens.add(nx, Y(ny), r * 3.6, r * 2.8, col, alpha);               // ghost note
    }

    // ---- hits and judgements on the hit line
    this.flashGlow.begin();
    for (const [key, at] of this.flashes) {
      const age = perf - at;
      if (age > 180) { this.flashes.delete(key); continue; }
      const s = key === 'pedal' ? PEDAL_POS : STAFF_POS[key as Lane];
      const c = key === 'pedal' ? laneC('hihat') : laneC(key as Lane);
      this.flashGlow.add(px, Y(y(s)), r * 4.6, r * 4.6, c, 0.6 * (1 - age / 180));
    }
    this.rings.begin();
    let keep = 0;
    for (const b of this.bursts) {
      const k = (perf - b.at) / 380;
      if (k >= 1) continue;
      this.bursts[keep++] = b;
      const size = r * 2 * (1.4 + k * 2.4) * 1.08;
      this.rings.add(px, Y(y(b.s)), size, size, b.color, 1 - k);
    }
    this.bursts.length = keep;

    for (const sp of [R, D, this.glow, this.ovals, this.crosses, this.openMark, this.halfMark, this.accents, this.parens, this.flashGlow, this.rings]) sp.end();
    this.renderer.render(this.scene, this.camera);
  }

  /** Places a section name (bottom-left corner at `left`, `baseline`) with the texture already loaded. */
  private placeLabel(i: number, text: string, left: number, baseline: number, alpha: number): number {
    const t = this.sectionTexture(text);
    const l = this.labels[i];
    l.mat.map = t.tex;
    l.mat.opacity = alpha;
    l.mesh.scale.set(t.w, t.h, 1);
    l.mesh.position.set(left + t.w / 2, this.h - (baseline - t.h / 2), 0);
    l.mesh.visible = true;
    return i + 1;
  }

  /** Staff background and band: redone only when the size changes. */
  private updateLayout(w: number, h: number, top: number, bottom: number, half: number): void {
    const key = `${w}x${h}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const c = this.bgTex.image as HTMLCanvasElement;
    c.width = 4;
    c.height = Math.max(2, Math.round(h));
    const g = c.getContext('2d')!;
    const bg = g.createLinearGradient(0, 0, 0, c.height);
    bg.addColorStop(0, '#05080e'); bg.addColorStop(0.55, '#04121a'); bg.addColorStop(1, '#03070c');
    g.fillStyle = bg;
    g.fillRect(0, 0, 4, c.height);
    const b0 = top - half * 2, b1 = bottom + half * 2;
    const band = g.createLinearGradient(0, b0, 0, b1);
    band.addColorStop(0, 'rgba(56,225,255,0)'); band.addColorStop(0.5, 'rgba(56,225,255,0.05)'); band.addColorStop(1, 'rgba(56,225,255,0)');
    g.fillStyle = band;
    g.fillRect(0, b0, 4, b1 - b0);
    this.bgTex.dispose();          // the size changed: recreate on the GPU
    this.bgTex.needsUpdate = true;
    this.bg.scale.set(w, h, 1);
    this.bg.position.set(w / 2, h / 2, 0);
    // texts: size depends on the staff height
    const px = Math.round(half * 0.9);
    if (px !== this.labelPx) {
      this.labelPx = px;
      for (const t of this.labelTex.values()) t.tex.dispose();
      this.labelTex.clear();
      this.reportLabelWidth();
      this.warmLabels();
    }
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    this.w = Math.round(r.width);
    this.h = Math.round(r.height);
    if (!this.w || !this.h) return;
    this.renderer.setPixelRatio(pixelRatioFor(this.aa, 2));
    this.renderer.setSize(this.w, this.h, false);
    this.camera.left = 0;
    this.camera.right = this.w;
    this.camera.top = this.h;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.resizeObs.disconnect();
    for (const t of this.labelTex.values()) t.tex.dispose();
    this.digitAtlas?.tex.dispose();
    this.scene.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material & { map?: THREE.Texture; uniforms?: { map?: { value: THREE.Texture } } };
      mat?.map?.dispose();
      mat?.uniforms?.map?.value?.dispose();
      mat?.dispose?.();
    });
    this.renderer.dispose();
  }
}

/** A batch of textured quads drawn in a single call, with per-instance color and opacity. */
class Sprites {
  readonly mesh: THREE.InstancedMesh;
  private alpha: THREE.InstancedBufferAttribute;
  private rect: THREE.InstancedBufferAttribute;
  private mat: THREE.ShaderMaterial;
  private n = 0;
  private prev = 0;
  private static tmp = new THREE.Object3D();

  constructor(map: THREE.Texture, private cap: number, additive: boolean, order: number) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aAlpha', this.alpha);
    // texture region (u, v, width, height); the default is the whole texture
    const rects = new Float32Array(cap * 4);
    for (let i = 0; i < cap; i++) { rects[i * 4 + 2] = 1; rects[i * 4 + 3] = 1; }
    this.rect = new THREE.InstancedBufferAttribute(rects, 4);
    this.rect.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aRect', this.rect);
    const mat = this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: `
        attribute float aAlpha;
        attribute vec4 aRect;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        void main() {
          vUv = aRect.xy + uv * aRect.zw; vColor = instanceColor; vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      // red channel = body (gets the piece color); green = white highlight; alpha = coverage
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv; varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 t = texture2D(map, vUv);
          float a = t.a * vAlpha;
          if (a < 0.004) discard;
          gl_FragColor = vec4(vColor * t.r + vec3(t.g) * 0.55, a);
          #include <colorspace_fragment>
        }`,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.count = 0;
  }

  begin(): void { this.n = 0; }

  setMap(map: THREE.Texture): void { this.mat.uniforms['map'].value = map; }

  add(x: number, y: number, sx: number, sy: number, color: THREE.Color, a: number,
      u = 0, v = 0, du = 1, dv = 1): void {
    if (this.n >= this.cap || a <= 0) return;
    if (du !== 1 || u !== 0) this.rect.setXYZW(this.n, u, v, du, dv);
    const t = Sprites.tmp;
    t.position.set(x, y, 0);
    t.scale.set(sx, sy, 1);
    t.updateMatrix();
    this.mesh.setMatrixAt(this.n, t.matrix);
    this.mesh.setColorAt(this.n, color);
    this.alpha.setX(this.n, a);
    this.n++;
  }

  /** Sends only the instances used this frame to the GPU. */
  end(): void {
    const n = this.n;
    this.mesh.count = n;
    if (!n && !this.prev) return;
    this.prev = n;
    for (const attr of [this.mesh.instanceMatrix, this.mesh.instanceColor!, this.alpha, this.rect] as THREE.BufferAttribute[]) {
      attr.clearUpdateRanges();
      if (n) attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }
}

/** Text (section or bar number) on a quad; the texture comes from the cache. */
class Label {
  readonly mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
  readonly mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mat);
  constructor() {
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }
}

// ------------------------------------------------------------------ textures (made once)
const TEX = 128;

function maskTexture(size: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = 'rgb(255,0,0)';
  g.strokeStyle = 'rgb(255,0,0)';
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;   // mask: the channels are data, not color
  return t;
}

function glowTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    const r = g.createRadialGradient(TEX / 2, TEX / 2, 0, TEX / 2, TEX / 2, TEX / 2);
    r.addColorStop(0, 'rgba(255,0,0,1)');
    r.addColorStop(0.5, 'rgba(255,0,0,0.85)');
    r.addColorStop(1, 'rgba(255,0,0,0)');
    g.fillStyle = r;
    g.fillRect(0, 0, TEX, TEX);
  });
}

/** Drum: tilted oval with a white highlight (green channel). */
function ovalTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    const rr = TEX / 2.7;
    g.beginPath();
    g.ellipse(TEX / 2, TEX / 2, rr * 1.18, rr * 0.86, -0.35, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = 'rgb(255,255,0)';
    g.beginPath();
    g.ellipse(TEX / 2 - rr * 0.3, TEX / 2 - rr * 0.25, rr * 0.4, rr * 0.22, -0.35, 0, Math.PI * 2);
    g.fill();
  });
}

/** Cymbal: X. */
function crossTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    const rr = TEX / 2.5;
    g.lineWidth = rr * 0.42;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(TEX / 2 - rr, TEX / 2 - rr); g.lineTo(TEX / 2 + rr, TEX / 2 + rr);
    g.moveTo(TEX / 2 + rr, TEX / 2 - rr); g.lineTo(TEX / 2 - rr, TEX / 2 + rr);
    g.stroke();
  });
}

/** Ring (open hi-hat "o" and judgement ring). */
function ringTexture(thickness: number): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    g.lineWidth = TEX * thickness;
    g.beginPath();
    g.arc(TEX / 2, TEX / 2, TEX / 2 - g.lineWidth, 0, Math.PI * 2);
    g.stroke();
  });
}

/** Half-open hi-hat: crossed "o". */
function halfTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    g.lineWidth = TEX * 0.12;
    const r = TEX * 0.3;
    g.beginPath();
    g.arc(TEX / 2, TEX / 2, r, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(TEX / 2 - r * 1.45, TEX / 2 + r * 1.45); g.lineTo(TEX / 2 + r * 1.45, TEX / 2 - r * 1.45);
    g.stroke();
  });
}

/** Accent ">". */
function accentTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    g.lineWidth = TEX * 0.13;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.beginPath();
    g.moveTo(TEX * 0.15, TEX * 0.2); g.lineTo(TEX * 0.85, TEX * 0.5); g.lineTo(TEX * 0.15, TEX * 0.8);
    g.stroke();
  });
}

/** Ghost note: parentheses around the head. */
function parenTexture(): THREE.CanvasTexture {
  return maskTexture(TEX, g => {
    g.lineWidth = TEX * 0.06;
    g.lineCap = 'round';
    const r = TEX * 0.42;
    g.beginPath();
    g.arc(TEX / 2 + TEX * 0.16, TEX / 2, r, Math.PI * 0.72, Math.PI * 1.28);
    g.stroke();
    g.beginPath();
    g.arc(TEX / 2 - TEX * 0.16, TEX / 2, r, -Math.PI * 0.28, Math.PI * 0.28);
    g.stroke();
  });
}

/** Text in a texture (sections and bar numbers), at screen resolution. */
function textTexture(text: string, px: number, color: string, weight: number): { tex: THREE.CanvasTexture; w: number; h: number } {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const font = `${weight} ${px}px system-ui, sans-serif`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 2;
  const h = Math.ceil(px * 1.3);
  c.width = Math.max(1, Math.round(w * dpr));
  c.height = Math.max(1, Math.round(h * dpr));
  g.scale(dpr, dpr);
  g.font = font;
  g.fillStyle = color;
  g.textBaseline = 'bottom';
  g.fillText(text, 1, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, w, h };
}

interface DigitAtlas { tex: THREE.CanvasTexture; px: number; cell: number; h: number; adv: number[]; }

/** Digits 0–9 in a single texture (one cell per digit), for the bar numbers. */
function digitAtlas(px: number): DigitAtlas {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const c = document.createElement('canvas');
  const g = c.getContext('2d', { willReadFrequently: true })!;
  const font = `600 ${px}px system-ui, sans-serif`;
  g.font = font;
  const adv = Array.from({ length: 10 }, (_, d) => g.measureText(String(d)).width);
  const cell = Math.ceil(Math.max(...adv)) + 2;
  const h = Math.ceil(px * 1.3);
  c.width = Math.round(cell * 10 * dpr);
  c.height = Math.round(h * dpr);
  g.scale(dpr, dpr);
  g.font = font;
  g.fillStyle = 'rgb(255,0,0)';
  g.textBaseline = 'bottom';
  g.textAlign = 'center';
  for (let d = 0; d < 10; d++) g.fillText(String(d), d * cell + cell / 2, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return { tex, px, cell, h, adv };
}

function lowerBoundMs(arr: Beat[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].ms < t) lo = mid + 1; else hi = mid; }
  return lo;
}

function lowerBoundNum(arr: number[], t: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < t) lo = mid + 1; else hi = mid; }
  return lo;
}
