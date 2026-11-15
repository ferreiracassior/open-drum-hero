import * as THREE from 'three';
import { LANE_COLOR } from '../core/lane-colors';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Beat, Lane } from '../core/protocol';
import { PlayNote, SectionRange } from './chart';
import { Judgement, lowerBound } from './scoring';
import { Antialias, GraphicsQuality } from '../core/settings.service';
import { MSAA_SAMPLES, pixelRatioFor } from './antialias';
import { drawInstrumentIcon } from './instrument-icon';

/** Lane order on the track (seen by a right-handed drummer). The kick is the bar that crosses everything. */
export const PAD_LANES: Lane[] = ['hihat', 'crash', 'snare', 'tom1', 'tom2', 'floor', 'crash2', 'ride'];

// piece colors: default and the ones chosen by the player (Settings → Colors); read every frame
export { LANE_COLOR } from '../core/lane-colors';

/** Levels of the playing audio (0–1), so the scenery reacts to the music. */
export interface AudioLevels { bass: number; mid: number; high: number; spectrum: Float32Array; }

const CYMBALS = new Set<Lane>(['crash', 'hihat', 'crash2', 'ride']);
const WHITE = new THREE.Color(1, 1, 1);
const LANE_W = 1.0;
const HALF = (PAD_LANES.length * LANE_W) / 2;
const LENGTH = 70;          // visible track length (units)
const BASE_SPEED = 20;      // units per real second with scrollSpeed = 1
const BEHIND_S = 0.3;       // how long the note stays visible after the line
const BANDS = 48;           // spectrum bands in the side waves

export const laneX = (lane: Lane) => (PAD_LANES.indexOf(lane) - (PAD_LANES.length - 1) / 2) * LANE_W;

interface Particle { sprite: THREE.Sprite; life: number; vx: number; vy: number; vz: number; }
/** Overall brightness of notes and icons (1 = original). */
const NOTE_GLOW = 0.8;
/** Brightness of the unlit neon marks (open/half-open hi-hat ring, pedal X, chord band): 1/3 of the original. */
const HAT_GLOW = 1 / 3;

interface GemSet { body: THREE.InstancedMesh; frame: THREE.InstancedMesh; half: number; }
interface Speaker { cone: THREE.Object3D; ring: THREE.MeshBasicMaterial; group: THREE.Object3D; pos: THREE.Vector3; }
interface SoundWave { mesh: THREE.Mesh; life: number; speaker: Speaker; strength: number; }
interface Wave { curtain: THREE.Mesh; line: THREE.Line; side: number; values: Float32Array; tint: THREE.Color; lag: number; }

export class Highway {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
  private composer?: EffectComposer;
  private gems = new Map<Lane, GemSet>();
  private shadows: THREE.InstancedMesh;        // mark on the floor where the note will land
  private rings: THREE.InstancedMesh;          // open hi-hat rim
  private halfRings: THREE.InstancedMesh;      // half rim for the half-open hi-hat
  private pedals: THREE.InstancedMesh;         // hi-hat pedal X
  private pedalGlow = 0;                       // hi-hat pad turns white when the pedal is played
  private beatLines: THREE.InstancedMesh;
  private pads = new Map<Lane, THREE.Mesh>();
  private padGlow = new Map<Lane, number>();
  private hitLine: THREE.Mesh;
  private sectionSprites: { sprite: THREE.Sprite; t: number }[] = [];
  private particles: Particle[] = [];
  private notes: PlayNote[] = [];
  private beats: Beat[] = [];
  private beatT: { t: number }[] = [];
  private status: (id: number) => 'pending' | 'hit' | 'miss' = () => 'pending';
  private tmp = new THREE.Object3D();
  private color = new THREE.Color();
  private lastFrame = performance.now();
  private resizeObs: ResizeObserver;
  // scenery
  private sky!: THREE.ShaderMaterial;
  private stageLights: { sprite: THREE.Sprite; base: number; band: 'mid' | 'high' }[] = [];
  private beams: THREE.MeshBasicMaterial[] = [];
  private speakers: Speaker[] = [];
  private soundWaves: SoundWave[] = [];
  private ampLights: THREE.PointLight[] = [];
  private pump = 0;
  private lastNow = NaN;
  private icons = new Map<Lane, THREE.Mesh>();
  private stripes: { lane: Lane; mesh: THREE.Mesh; dim: number }[] = [];
  private chordMesh!: THREE.Mesh;
  private chordPts: { t: number; x: number; y: number; z: number; lane: Lane }[] = [];
  /** Notes before this instant don't show (countdown when resuming from pause: empty run-up to the start point). */
  hideBefore = -Infinity;
  /** Note size (1 = default), chosen in the bottom bar. */
  noteScale = 1;
  private waves: Wave[] = [];
  private level = { bass: 0, mid: 0, high: 0 };
  private bands = new Float32Array(BANDS);

  constructor(private canvas: HTMLCanvasElement, private quality: GraphicsQuality, aa: Antialias = 'msaa') {
    // the canvas MSAA only applies without bloom; with bloom it is done in the render target (below)
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: aa !== 'off', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(pixelRatioFor(aa, quality === 'high' ? 2 : 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene.fog = new THREE.Fog(new THREE.Color('#04121a'), LENGTH * 0.6, LENGTH * 1.2);

    this.scene.add(new THREE.HemisphereLight(0x9fe3ff, 0x0a0d14, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-2, 9, 7);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fd2ff, 1.1);
    rim.position.set(3, 4, -12);
    this.scene.add(rim);

    this.buildEnvironment();
    this.buildTrack();
    for (const lane of [...PAD_LANES, 'kick'] as Lane[]) this.gems.set(lane, this.makeGems(lane));

    this.shadows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.86, 0.1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }), 2048);
    this.shadows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(2048 * 3), 3);
    this.shadows.frustumCulled = false;
    this.scene.add(this.shadows);

    const ring = new THREE.ExtrudeGeometry(ringShape(0.2, 0.14), { depth: 0.02, bevelEnabled: false });
    ring.rotateX(-Math.PI / 2).translate(0, 0.2, 0);
    this.rings = new THREE.InstancedMesh(ring, new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 2.6, 2.8).multiplyScalar(HAT_GLOW), toneMapped: false }), 512);
    this.rings.frustumCulled = false;
    this.scene.add(this.rings);
    const half = new THREE.RingGeometry(0.14, 0.2, 24, 1, 0, Math.PI);
    half.rotateX(-Math.PI / 2).translate(0, 0.2, 0);
    this.halfRings = new THREE.InstancedMesh(half, new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 1.7, 0.4).multiplyScalar(HAT_GLOW), side: THREE.DoubleSide, toneMapped: false }), 512);
    this.halfRings.frustumCulled = false;
    this.scene.add(this.halfRings);
    const cross = new THREE.ShapeGeometry(crossShape(0.2, 0.035));
    cross.rotateX(-Math.PI / 2).translate(0, 0.2, 0);
    this.pedals = new THREE.InstancedMesh(cross, new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.2, 2.4, 2.6).multiplyScalar(HAT_GLOW), side: THREE.DoubleSide, toneMapped: false }), 1024);
    this.pedals.frustumCulled = false;
    this.scene.add(this.pedals);

    this.chordMesh = this.makeChordMesh();

    this.beatLines = new THREE.InstancedMesh(
      new THREE.BoxGeometry(HALF * 2, 0.01, 0.035), new THREE.MeshBasicMaterial({ color: '#ffffff' }), 256);
    this.beatLines.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(256 * 3), 3);
    this.beatLines.frustumCulled = false;
    this.scene.add(this.beatLines);

    // golden hit line, like Rocksmith's fret bar
    this.hitLine = new THREE.Mesh(new THREE.BoxGeometry(HALF * 2 + 0.4, 0.05, 0.07),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.15, 0.5) }));
    this.hitLine.position.set(0, 0.03, 0);
    this.scene.add(this.hitLine);

    if (quality === 'high') {
      // the scene goes to an MSAA target (without it, bloom turns anti-aliasing off)
      this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType, samples: aa !== 'off' ? MSAA_SAMPLES : 0,
      }));
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.3, 0.88));
      this.composer.addPass(new OutputPass());
    }
    this.makeParticles();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas);
    this.resize();
  }

  setChart(notes: PlayNote[], beats: Beat[], sections: SectionRange[], status: Highway['status']): void {
    this.notes = notes;
    this.beats = beats;
    this.beatT = beats.map(b => ({ t: b.ms }));
    this.status = status;
    for (const s of this.sectionSprites) this.scene.remove(s.sprite);
    this.sectionSprites = sections.map(s => {
      const sprite = textSprite(s.name.toUpperCase());
      this.scene.add(sprite);
      return { sprite, t: s.start };
    });
  }

  /** Pad lights up on the hit line (every hit, even without a note). */
  flash(lane: Lane, pedal = false): void {
    this.padGlow.set(lane, 1);
    if (pedal) this.pedalGlow = 1;
  }

  burst(lane: Lane, j: Judgement): void {
    if (j === 'miss' || j === 'extra') return;
    const n = j === 'perfect' ? 16 : j === 'great' ? 10 : 6;
    const c = new THREE.Color(LANE_COLOR[lane]).multiplyScalar(j === 'perfect' ? 1.6 : 1);
    const x = lane === 'kick' ? 0 : laneX(lane);
    for (let i = 0; i < n; i++) {
      const p = this.particles.find(q => q.life <= 0);
      if (!p) break;
      p.life = 1;
      p.sprite.visible = true;
      (p.sprite.material as THREE.SpriteMaterial).color.copy(c);
      p.sprite.position.set(x + (lane === 'kick' ? (Math.random() - 0.5) * HALF * 2 : 0), 0.2, 0);
      p.vx = (Math.random() - 0.5) * 3;
      p.vy = 1.5 + Math.random() * 3.5;
      p.vz = (Math.random() - 0.3) * 2;
    }
  }

  /**
   * Draws the frame. `now` = chart time you are hearing (already calibrated),
   * `rate` = song speed, `scroll` = visual track speed, `audio` = sound levels.
   */
  render(now: number, rate: number, scroll: number, audio?: AudioLevels): void {
    const perf = performance.now();
    const dt = Math.min(0.1, (perf - this.lastFrame) / 1000);
    this.lastFrame = perf;
    const speed = BASE_SPEED * scroll;                       // units per real second
    const zOf = (t: number) => -((t - now) / rate / 1000) * speed;
    const tFrom = now - BEHIND_S * 1000 * rate;
    const tTo = now + (LENGTH / speed) * 1000 * rate;

    this.detectBeats(now);
    this.updateAudio(audio, dt);
    this.updateSpeakers(dt);
    this.drawNotes(now, rate, tFrom, tTo, zOf);

    // beat lines
    let b = 0;
    for (let i = lowerBound(this.beatT, tFrom); i < this.beats.length && this.beats[i].ms <= tTo && b < 256; i++) {
      const beat = this.beats[i];
      this.tmp.position.set(0, 0.005, zOf(beat.ms));
      this.tmp.rotation.set(0, 0, 0);
      this.tmp.scale.set(1, 1, beat.downbeat ? 2 : 1);
      this.tmp.updateMatrix();
      this.beatLines.setMatrixAt(b, this.tmp.matrix);
      if (beat.downbeat) this.color.setRGB(0.25, 0.55, 0.9);
      else this.color.setRGB(0.07, 0.16, 0.26);
      this.beatLines.setColorAt(b++, this.color);
    }
    this.beatLines.count = b;
    this.beatLines.instanceMatrix.needsUpdate = true;
    this.beatLines.instanceColor!.needsUpdate = true;

    // section names
    for (const s of this.sectionSprites) {
      const z = zOf(s.t);
      s.sprite.visible = z < 1 && z > -LENGTH;
      s.sprite.position.set(-HALF - 0.9, 0.9, z);
    }

    // pads, hit line and particles
    this.pedalGlow = Math.max(0, this.pedalGlow - dt * 4);
    for (const [lane, pad] of this.pads) {
      const g = Math.max(0, (this.padGlow.get(lane) ?? 0) - dt * 5);
      this.padGlow.set(lane, g);
      const col = (pad.material as THREE.MeshBasicMaterial).color.set(LANE_COLOR[lane]);
      if (lane === 'hihat') col.lerp(WHITE, this.pedalGlow * 0.75);   // pedal: hi-hat flashes white
      col.multiplyScalar(0.55 + g * 2);
      pad.scale.setScalar(1 + g * 0.18);
      this.icons.get(lane)?.scale.setScalar(1 + g * 0.25);
    }
    const kg = Math.max(0, (this.padGlow.get('kick') ?? 0) - dt * 5);
    this.padGlow.set('kick', kg);
    this.icons.get('kick')?.scale.setScalar(1 + kg * 0.25);
    (this.hitLine.material as THREE.MeshBasicMaterial).color.setRGB(1.5 + kg * 0.7, 1.05 + kg * 0.6, 0.45 + kg * 0.45);
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt * 1.8;
      p.vy -= 9 * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y = Math.max(0.05, p.sprite.position.y + p.vy * dt);
      p.sprite.position.z += p.vz * dt;
      p.sprite.scale.setScalar(0.28 * Math.max(0, p.life) + 0.05);
      (p.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, p.life);
      if (p.life <= 0) p.sprite.visible = false;
    }

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // In portrait the track needs more distance to fit.
    const portrait = aspect < 1;
    this.camera.fov = portrait ? 62 : 50;
    this.camera.position.set(0, portrait ? 8 : 4.6, portrait ? 9.5 : 7.6);
    this.camera.lookAt(0, 0.4, portrait ? -7 : -8);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.scene.traverse(o => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose());
      else mat?.dispose();
    });
  }

  // ------------------------------------------------------------- notes
  private drawNotes(now: number, rate: number, tFrom: number, tTo: number, zOf: (t: number) => number): void {
    const counts = new Map<Lane, number>();
    let ringCount = 0, halfCount = 0, shadowCount = 0, pedalCount = 0;
    this.chordPts.length = 0;
    for (let i = lowerBound(this.notes, Math.max(tFrom, this.hideBefore)); i < this.notes.length && this.notes[i].t <= tTo; i++) {
      const n = this.notes[i];
      const st = this.status(n.id);
      if (st === 'hit') continue;
      const set = this.gems.get(n.lane)!;
      const k = counts.get(n.lane) ?? 0;
      if (k >= set.body.instanceMatrix.count) continue;
      const z = zOf(n.t);
      // already lying down (final position) from the start of the track, without rotating as it approaches
      const stand = 0;
      const angle = 0;
      const hhOpen = n.lane === 'hihat' && n.art === 'open';
      const hhHalf = n.lane === 'hihat' && n.art === 'half';
      const hhPedal = n.lane === 'hihat' && n.art === 'pedal';
      const hhClosed = n.lane === 'hihat' && !hhOpen && !hhHalf && !hhPedal;
      const sc = this.noteScale;
      const s = (n.ghost ? 0.72 : n.acc ? 1.12 : 1) * (hhOpen ? 1.15 : hhClosed ? 0.72 : 1) * sc;
      const isKick = n.lane === 'kick';
      const lift = CYMBALS.has(n.lane) ? 0.1 : 0;
      this.tmp.position.set(isKick ? 0 : laneX(n.lane), 0.06 + lift + Math.sin(angle) * set.half * (isKick ? sc : s), z);
      this.tmp.rotation.set(angle, 0, 0);
      this.tmp.scale.set(isKick ? 1 : s, isKick ? sc : s, isKick ? sc : s);   // the kick keeps the track's width
      this.tmp.updateMatrix();
      set.body.setMatrixAt(k, this.tmp.matrix);
      set.frame.setMatrixAt(k, this.tmp.matrix);

      const fade = 1 - smoothstep(LENGTH * 0.7, LENGTH, -z) * 0.7;
      if (st === 'miss') {
        set.frame.setColorAt(k, this.color.set('#ff2a4a').multiplyScalar(0.45));
        set.body.setColorAt(k, this.color.set('#4a0c18'));
      } else {
        // kick fills the whole track: much lower brightness so it doesn't blow out the bloom (still neon on the frame)
        const dimFrame = isKick ? 0.5 : NOTE_GLOW, dimBody = isKick ? 0.3 : NOTE_GLOW;
        const glow = (n.ghost ? 0.6 : n.acc ? 2.4 : 1.7) * fade * (hhOpen ? 1.5 : hhHalf ? 1.1 : hhClosed ? 0.4 : hhPedal ? 0.7 : 1) * dimFrame;
        set.frame.setColorAt(k, this.color.set(LANE_COLOR[n.lane]).multiplyScalar(glow));
        set.body.setColorAt(k, this.color.set(LANE_COLOR[n.lane]).multiplyScalar((n.ghost ? 0.35 : 0.85) * fade * (hhClosed ? 0.45 : 1) * dimBody));
      }
      counts.set(n.lane, k + 1);

      if (hhOpen && ringCount < 512) {   // big "O" ring on top of the open hi-hat
        this.tmp.scale.multiplyScalar(2);
        this.tmp.updateMatrix();
        this.rings.setMatrixAt(ringCount++, this.tmp.matrix);
      }
      if (hhPedal && st !== 'miss' && pedalCount < 1024) {   // X: hi-hat pedal
        this.tmp.scale.multiplyScalar(1.3);
        this.tmp.updateMatrix();
        this.pedals.setMatrixAt(pedalCount++, this.tmp.matrix);
      }
      if (hhHalf && halfCount < 512) {   // amber half ring: half-open hi-hat
        this.tmp.scale.multiplyScalar(2);
        this.tmp.updateMatrix();
        this.halfRings.setMatrixAt(halfCount++, this.tmp.matrix);
      }
      if (!isKick && st !== 'miss') this.chordPts.push({ t: n.t, x: this.tmp.position.x, y: this.tmp.position.y + 0.02, z, lane: n.lane });

      // floor mark: helps read the distance while the note is upright
      if (!isKick && st !== 'miss' && stand > 0.05 && shadowCount < 2048) {
        this.tmp.position.set(laneX(n.lane), 0.012, z);
        this.tmp.rotation.set(0, 0, 0);
        this.tmp.scale.set(sc, 1, sc);
        this.tmp.updateMatrix();
        this.shadows.setMatrixAt(shadowCount, this.tmp.matrix);
        this.shadows.setColorAt(shadowCount++, this.color.set(LANE_COLOR[n.lane]).multiplyScalar(0.55 * stand * fade));
      }
    }
    for (const [lane, set] of this.gems) {
      const c = counts.get(lane) ?? 0;
      setUsed(set.body, c);
      setUsed(set.frame, c);
    }
    setUsed(this.rings, ringCount);
    setUsed(this.halfRings, halfCount);
    setUsed(this.pedals, pedalCount);
    setUsed(this.shadows, shadowCount);
    this.updateChords();
  }

  /** Band for each pair of notes played together, in a gradient from one lane's color to the other's. */
  private makeChordMesh(): THREE.Mesh {
    const max = 256;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(max * 4 * 3), 3));
    const idx: number[] = [];
    for (let i = 0; i < max; i++) idx.push(i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2);
    g.setIndex(idx);
    g.setDrawRange(0, 0);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, toneMapped: false }));
    m.frustumCulled = false;
    m.userData['max'] = max;
    this.scene.add(m);
    return m;
  }

  private updateChords(): void {
    const g = this.chordMesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    const max = this.chordMesh.userData['max'] as number;
    const pts = this.chordPts.sort((a, b) => a.t - b.t || a.x - b.x);
    const a = new THREE.Color(), b = new THREE.Color();
    let seg = 0;
    for (let i = 0; i < pts.length && seg < max;) {
      let j = i + 1;
      while (j < pts.length && Math.abs(pts[j].t - pts[i].t) < 2) j++;
      for (let k = i; k + 1 < j && seg < max; k++) {
        const p = pts[k], q = pts[k + 1];
        const th = 0.05;                       // half the band thickness
        const fade = Math.max(0.25, 1 - Math.max(0, -p.z) / 70);
        a.set(LANE_COLOR[p.lane]).multiplyScalar(1.5 * HAT_GLOW * fade);
        b.set(LANE_COLOR[q.lane]).multiplyScalar(1.5 * HAT_GLOW * fade);
        const v = seg * 4;
        pos.setXYZ(v, p.x, p.y - th, p.z); pos.setXYZ(v + 1, p.x, p.y + th, p.z);
        pos.setXYZ(v + 2, q.x, q.y - th, q.z); pos.setXYZ(v + 3, q.x, q.y + th, q.z);
        col.setXYZ(v, a.r, a.g, a.b); col.setXYZ(v + 1, a.r, a.g, a.b);
        col.setXYZ(v + 2, b.r, b.g, b.b); col.setXYZ(v + 3, b.r, b.g, b.b);
        seg++;
      }
      i = j;
    }
    g.setDrawRange(0, seg * 6);
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /** 3D rectangular blocks (Rocksmith style): lit body + neon frame on the top face. */
  private makeGems(lane: Lane): GemSet {
    const kick = lane === 'kick', cym = CYMBALS.has(lane);
    const w = kick ? HALF * 2 - 0.15 : 0.84;
    const d = kick ? 0.26 : cym ? 0.36 : 0.44;     // depth (along the track)
    const h = kick ? 0.16 : cym ? 0.24 : 0.32;     // block height (taller to see well on the phone)
    const body = new RoundedBoxGeometry(w, h, d, 3, Math.min(0.06, h / 2.2));
    body.translate(0, h / 2, 0);
    const frame = flat(new THREE.ExtrudeGeometry(roundRectRing(w + 0.04, d + 0.04, 0.08, 0.055), { depth: 0.02, bevelEnabled: false }));
    frame.translate(0, h - 0.004, 0);
    const half = d / 2;
    const cap = 2048;
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const m = new THREE.InstancedMesh(geo, mat, cap);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.frustumCulled = false;
      m.count = 0;
      this.scene.add(m);
      return m;
    };
    // matte: no light reflections (the white glare passing over the blocks looked like light hitting a mirror)
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.45 });
    // the block's own glow uses the lane color (instanceColor), not white
    mat.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n  totalEmissiveRadiance *= diffuseColor.rgb;');
    };
    return { body: mk(body, mat), frame: mk(frame, new THREE.MeshBasicMaterial()), half };
  }

  // ------------------------------------------------------------- audio → scenery
  private updateAudio(audio: AudioLevels | undefined, dt: number): void {
    const follow = (cur: number, target: number) =>
      target > cur ? cur + (target - cur) * Math.min(1, dt * 25) : cur + (target - cur) * Math.min(1, dt * 4);
    this.level.bass = follow(this.level.bass, audio?.bass ?? 0);
    this.level.mid = follow(this.level.mid, audio?.mid ?? 0);
    this.level.high = follow(this.level.high, audio?.high ?? 0);
    for (let i = 0; i < BANDS; i++) this.bands[i] = follow(this.bands[i], audio?.spectrum[i] ?? 0);

    const { bass, mid, high } = this.level;
    this.sky.uniforms['uTime'].value = performance.now() / 1000;
    this.sky.uniforms['uPulse'].value = mid;
    for (const l of this.stageLights) {
      const v = l.band === 'mid' ? mid : high;
      l.sprite.scale.setScalar(l.base * (0.75 + v * 0.9));
      (l.sprite.material as THREE.SpriteMaterial).opacity = 0.55 + v * 0.45;
    }
    for (const b of this.beams) b.opacity = 0.012 + mid * 0.035;
    this.pump = Math.max(this.pump, bass * 0.6);

    const t = performance.now() / 1000;
    for (const w of this.waves) {
      const pos = (w.curtain.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
      const col = (w.curtain.geometry as THREE.BufferGeometry).getAttribute('color') as THREE.BufferAttribute;
      const linePos = (w.line.geometry as THREE.BufferGeometry).getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i <= BANDS; i++) {
        const band = this.bands[Math.min(BANDS - 1, Math.max(0, i - w.lag))];
        const crackle = (Math.sin(i * 1.7 + t * 23 * (1 + w.side * 0.1)) * 0.5 + 0.5) * high * 0.45;
        const target = 0.06 + band * (1.7 - i / BANDS * 0.7) + crackle * 0.6;
        w.values[i] += (target - w.values[i]) * Math.min(1, dt * 18);
        const h = w.values[i];
        pos.setY(i * 2 + 1, h);
        linePos.setY(i, h);
        const bright = 0.06 + band * 0.45;
        col.setXYZ(i * 2 + 1, w.tint.r * bright, w.tint.g * bright, w.tint.b * bright);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
      linePos.needsUpdate = true;
      ((w.line.material as THREE.LineBasicMaterial).color).copy(w.tint).multiplyScalar(1.2 + bass * 1.4);
    }
  }

  // ------------------------------------------------------------- scenery
  private buildEnvironment(): void {
    // sky/stage background: teal gradient with smoke
    this.sky = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uTime: { value: 0 }, uPulse: { value: 0 } },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform float uPulse; varying vec3 vDir;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
        float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a*n2(p); p *= 2.03; a *= 0.5; } return v; }
        void main(){
          float h = vDir.y;
          vec3 top = vec3(0.004, 0.012, 0.03);
          vec3 hor = vec3(0.012, 0.085, 0.12);
          vec3 col = mix(hor, top, smoothstep(0.02, 0.55, h));
          vec2 uv = vec2(atan(vDir.x, -vDir.z) * 1.6, h * 3.0);
          float smoke = fbm(uv * 2.2 + vec2(uTime * 0.03, -uTime * 0.02));
          float band = 1.0 - smoothstep(0.0, 0.45, abs(h - 0.12));
          col += vec3(0.03, 0.2, 0.28) * smoke * smoke * band * (0.6 + uPulse * 1.0);
          col *= mix(0.12, 1.0, smoothstep(-0.12, 0.06, h));
          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    this.scene.add(new THREE.Mesh(new THREE.SphereGeometry(300, 48, 24), this.sky));

    // stage lights in the background + beams
    const glow = radialTexture();
    const lights: [number, number, number, 'mid' | 'high', string][] = [
      [-38, 26, -150, 'mid', '#46d6ff'], [-20, 30, -160, 'high', '#7fe6ff'], [-6, 27, -165, 'mid', '#46d6ff'],
      [6, 27, -165, 'mid', '#46d6ff'], [20, 30, -160, 'high', '#7fe6ff'], [38, 26, -150, 'mid', '#46d6ff'],
      [-55, 14, -120, 'high', '#3aa8ff'], [55, 14, -120, 'high', '#3aa8ff'],
    ];
    for (const [x, y, z, band, c] of lights) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glow, color: new THREE.Color(c).multiplyScalar(1.6), transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      sprite.position.set(x, y, z);
      const base = band === 'mid' ? 16 : 11;
      sprite.scale.setScalar(base);
      this.scene.add(sprite);
      this.stageLights.push({ sprite, base, band });
      if (this.quality === 'high' && y > 20) {
        const mat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(c), transparent: true, opacity: 0.04, blending: THREE.AdditiveBlending,
          depthWrite: false, side: THREE.DoubleSide, fog: false,
        });
        const beam = new THREE.Mesh(new THREE.ConeGeometry(14, 60, 24, 1, true), mat);
        beam.position.set(x * 0.9, y - 28, z + 18);
        beam.rotation.set(-0.35, 0, x * -0.004);
        this.scene.add(beam);
        this.beams.push(mat);
      }
    }

    // 3D speakers in the (back) corners, pulsing and sending waves on every hit
    for (const side of [-1, 1]) this.buildAmp(side);

    // energy waves along the track (music spectrum): golden in front, blue behind
    for (const side of [-1, 1]) {
      this.waves.push(this.makeWave(side, side * (HALF + 0.55), new THREE.Color(1.0, 0.72, 0.28), 0));
      if (this.quality === 'high') this.waves.push(this.makeWave(side, side * (HALF + 1.6), new THREE.Color(0.25, 0.7, 1.0), 3));
    }
  }

  private buildAmp(side: number): void {
    const amp = new THREE.Group();
    const tolex = new THREE.MeshStandardMaterial({ map: tolexTexture(), roughness: 0.85, metalness: 0.05, color: 0x8a7a6a });
    const grille = new THREE.MeshStandardMaterial({ map: grilleTexture(), roughness: 1, color: 0x8c8070 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xb8b8c0, roughness: 0.25, metalness: 0.9 });
    const W = 3.6, H = 3.6, D = 1.7;

    const cab = new THREE.Mesh(new RoundedBoxGeometry(W, H, D, 4, 0.12), tolex);
    cab.position.y = H / 2;
    amp.add(cab);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.36, H - 0.36), grille);
    front.position.set(0, H / 2, D / 2 + 0.005);
    amp.add(front);
    for (const [cx, cy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {   // metal corner brackets
      const c = new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.34, 0.34, 2, 0.06), metal);
      c.position.set(cx * (W / 2 - 0.1), H / 2 + cy * (H / 2 - 0.1), D / 2 - 0.08);
      amp.add(c);
    }
    // head unit on top
    const head = new THREE.Mesh(new RoundedBoxGeometry(W, 1.1, D - 0.2, 4, 0.1), tolex);
    head.position.set(0, H + 0.6, -0.08);
    amp.add(head);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.3, 0.8),
      new THREE.MeshStandardMaterial({ map: ampHeadTexture(), roughness: 0.5, emissive: 0xffffff, emissiveMap: ampHeadTexture(), emissiveIntensity: 0.25 }));
    panel.position.set(0, H + 0.6, (D - 0.2) / 2 - 0.07);
    amp.add(panel);

    // 4 speakers: concave cone that "pumps" + light ring
    const coneGeo = new THREE.LatheGeometry([
      new THREE.Vector2(0.12, -0.2), new THREE.Vector2(0.25, -0.17), new THREE.Vector2(0.5, -0.07),
      new THREE.Vector2(0.66, 0), new THREE.Vector2(0.72, 0.03),
    ], 40).rotateX(Math.PI / 2);
    const coneMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7, side: THREE.DoubleSide });
    const capMat = new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.4, metalness: 0.3 });
    for (const [x, y] of [[-0.86, 2.66], [0.86, 2.66], [-0.86, 0.94], [0.86, 0.94]]) {
      const holder = new THREE.Group();
      holder.position.set(x, y, D / 2 + 0.01);
      const cone = new THREE.Group();
      cone.add(new THREE.Mesh(coneGeo, coneMat));
      const dust = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), capMat);
      dust.position.z = -0.17;
      cone.add(dust);
      holder.add(cone);
      const ringMat = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.8, 48), ringMat);
      ring.position.z = 0.04;
      holder.add(ring);
      amp.add(holder);
      this.speakers.push({ cone, ring: ringMat, group: holder, pos: new THREE.Vector3() });
    }
    const light = new THREE.PointLight(0xff8a2a, 0, 9, 1.6);
    light.position.set(0, H / 2, D / 2 + 1.2);
    amp.add(light);
    this.ampLights.push(light);

    amp.scale.setScalar(1.05);
    amp.position.set(side * (HALF + 5.3), -2.25, -2.6);
    amp.rotation.y = -side * 0.36;
    this.scene.add(amp);
    amp.updateMatrixWorld(true);
    for (const sp of this.speakers.slice(-4)) sp.group.getWorldPosition(sp.pos);

    // sound waves (rings coming out of the speakers)
    const waveGeo = new THREE.RingGeometry(0.74, 0.82, 48);
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial({
        color: new THREE.Color(1.4, 0.7, 0.25), transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      m.visible = false;
      amp.add(m);
      this.soundWaves.push({ mesh: m, life: 0, speaker: this.speakers[this.speakers.length - 4], strength: 0 });
    }
  }

  /** Triggers the speaker pulse when the chart's kick/snare pass the line. */
  private detectBeats(now: number): void {
    const prev = this.lastNow;
    this.lastNow = now;
    if (!(now > prev) || now - prev > 400) return;
    for (let i = lowerBound(this.notes, Math.max(prev, this.hideBefore)); i < this.notes.length && this.notes[i].t <= now; i++) {
      const lane = this.notes[i].lane;
      if (lane === 'kick') this.kick(1);
      else if (lane === 'snare') this.kick(0.55);
    }
  }

  private kick(strength: number): void {
    this.pump = Math.max(this.pump, strength);
    if (strength < 0.8 || this.soundWaves.some(w => w.life > 0.55)) return;
    const free = this.soundWaves.filter(w => w.life <= 0);
    for (let k = 0; k < this.speakers.length && free.length; k++) {
      const w = free.pop()!;
      const sp = this.speakers[k];
      w.speaker = sp;
      sp.group.parent!.add(w.mesh);
      w.mesh.position.copy(sp.group.position);
      w.life = 1;
      w.strength = strength;
      w.mesh.visible = true;
    }
  }

  private updateSpeakers(dt: number): void {
    const p = this.pump;
    for (const sp of this.speakers) {
      sp.cone.position.z = p * 0.14;               // the cone pushes outward
      sp.cone.scale.setScalar(1 + p * 0.05);
      sp.ring.color.setRGB(1.5, 0.6, 0.12).multiplyScalar(0.15 + p * 0.45);   // subtler speaker pulse
    }
    for (const l of this.ampLights) l.intensity = 4 + p * 9;
    for (const w of this.soundWaves) {
      if (w.life <= 0) continue;
      w.life -= dt * 1.6;
      const age = 1 - w.life;
      w.mesh.scale.setScalar(1 + age * 1.4);
      w.mesh.position.z = w.speaker.group.position.z + age * 1.2;
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, w.life) * 0.2 * w.strength;
      if (w.life <= 0) w.mesh.visible = false;
    }
    this.pump = Math.max(0, p - dt * 6 * p - dt * 0.5);
  }

  private makeWave(side: number, x: number, tint: THREE.Color, lag: number): Wave {
    const zNear = -2.5, zFar = -LENGTH * 0.85;
    const pos = new Float32Array((BANDS + 1) * 2 * 3);
    const col = new Float32Array((BANDS + 1) * 2 * 3);
    const idx: number[] = [];
    const linePos = new Float32Array((BANDS + 1) * 3);
    for (let i = 0; i <= BANDS; i++) {
      const z = zNear + (zFar - zNear) * (i / BANDS);
      const xi = x + side * (i / BANDS) * 1.2;
      pos.set([xi, 0, z, xi, 0.1, z], i * 6);
      linePos.set([xi, 0.1, z], i * 3);
      if (i < BANDS) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    const curtain = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      opacity: 0.28,
    }));
    curtain.frustumCulled = false;
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
    const line = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: tint.clone() }));
    line.frustumCulled = false;
    this.scene.add(curtain, line);
    return { curtain, line, side, values: new Float32Array(BANDS + 1), tint, lag };
  }

  private buildTrack(): void {
    const len = LENGTH + 6;
    const track = new THREE.Mesh(new THREE.PlaneGeometry(HALF * 2 + 0.5, len).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#050b13' }));
    track.position.set(0, 0, -len / 2 + 3);
    this.scene.add(track);
    PAD_LANES.forEach((lane, i) => {
      const dim = i % 2 ? 0.012 : 0.02;
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W - 0.08, len).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(LANE_COLOR[lane]).multiplyScalar(dim) }));
      stripe.position.set(laneX(lane), 0.001, -len / 2 + 3);
      this.stripes.push({ lane, mesh: stripe, dim });
      this.scene.add(stripe);
      // target on the hit line, with the same shape as the note
      const shape = roundRectRing(0.92, CYMBALS.has(lane) ? 0.44 : 0.52, 0.1, 0.06);
      const pad = new THREE.Mesh(flat(new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false })),
        new THREE.MeshBasicMaterial({ color: LANE_COLOR[lane] }));
      pad.position.set(laneX(lane), 0.03, 0);
      this.pads.set(lane, pad);
      this.scene.add(pad);
      this.addIcon(lane, laneX(lane));
    });
    this.addIcon('kick', HALF + 0.45);   // kick: outside the track, on the right (spacing similar to the lanes)
    // thin dividers between lanes
    for (let i = 0; i <= PAD_LANES.length; i++) {
      const x = (i - PAD_LANES.length / 2) * LANE_W;
      const edge = i === 0 || i === PAD_LANES.length;
      const line = new THREE.Mesh(new THREE.BoxGeometry(edge ? 0.07 : 0.025, 0.02, len),
        new THREE.MeshBasicMaterial({ color: edge ? new THREE.Color(0.35, 0.8, 1.6) : new THREE.Color(0.08, 0.22, 0.38) }));
      line.position.set(x, 0.01, -len / 2 + 3);
      this.scene.add(line);
    }
    // on top, a 1 px line: the center divider lines up with the camera and, from afar,
    // the thin box disappears (gets smaller than a pixel); the line makes sure all of them reach the end of the track
    const pts: number[] = [];
    for (let i = 1; i < PAD_LANES.length; i++) {
      const x = (i - PAD_LANES.length / 2) * LANE_W;
      pts.push(x, 0.022, 3, x, 0.022, 3 - len);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: new THREE.Color(0.08, 0.22, 0.38) })));
  }

  /**
   * Piece whose icon (below the hit line) is under the touch/click — this is how you play without a drum kit.
   * Accepts an area around the icon of about half a lane on each side (a bit more vertically).
   */
  laneAt(clientX: number, clientY: number): Lane | null {
    const r = this.canvas.getBoundingClientRect();
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
    };
    const a = toScreen(new THREE.Vector3(0, 0.28, 1.45)), b = toScreen(new THREE.Vector3(LANE_W, 0.28, 1.45));
    const half = Math.abs(b.x - a.x) * 0.55;
    let best: Lane | null = null, bestD = Infinity;
    for (const [lane, icon] of this.icons) {
      const c = toScreen(icon.getWorldPosition(new THREE.Vector3()));
      const dx = Math.abs(clientX - c.x), dy = Math.abs(clientY - c.y);
      if (dx > half || dy > half * 1.6) continue;
      const d = dx * dx + dy * dy * 0.4;
      if (d < bestD) { bestD = d; best = lane; }
    }
    return best;
  }

  /** The player changed the piece colors: redo what is drawn only once (bands and icons). */
  refreshColors(): void {
    for (const s of this.stripes) (s.mesh.material as THREE.MeshBasicMaterial).color.set(LANE_COLOR[s.lane]).multiplyScalar(s.dim);
    for (const [lane, icon] of this.icons) {
      const mat = icon.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.map = instrumentIcon(lane, LANE_COLOR[lane]);
      mat.needsUpdate = true;
    }
  }

  private addIcon(lane: Lane, x: number): void {
    const icon = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.7),
      new THREE.MeshBasicMaterial({ map: instrumentIcon(lane, LANE_COLOR[lane]), color: new THREE.Color(NOTE_GLOW, NOTE_GLOW, NOTE_GLOW), transparent: true, depthWrite: false, toneMapped: false }));
    icon.position.set(x, 0.28, 1.45);
    icon.rotation.x = -0.75;
    this.icons.set(lane, icon);
    this.scene.add(icon);
  }

  private makeParticles(): void {
    const tex = radialTexture();
    for (let i = 0; i < 112; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      sprite.visible = false;
      this.scene.add(sprite);
      this.particles.push({ sprite, life: 0, vx: 0, vy: 0, vz: 0 });
    }
  }
}

// ------------------------------------------------------------- shapes and textures
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Lays a 2D shape (XY) on the floor (XZ), centered and facing up. */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.rotateX(-Math.PI / 2);
  g.computeBoundingBox();
  const bb = g.boundingBox!;
  g.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  return g;
}

function roundRectPath(p: THREE.Path, w: number, h: number, r: number): void {
  const x = -w / 2, y = -h / 2;
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.quadraticCurveTo(x + w, y, x + w, y + r);
  p.lineTo(x + w, y + h - r);
  p.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  p.lineTo(x + r, y + h);
  p.quadraticCurveTo(x, y + h, x, y + h - r);
  p.lineTo(x, y + r);
  p.quadraticCurveTo(x, y, x + r, y);
}

function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  roundRectPath(s, w, h, r);
  return s;
}

function roundRectRing(w: number, h: number, r: number, t: number): THREE.Shape {
  const s = roundRect(w, h, r);
  const hole = new THREE.Path();
  roundRectPath(hole, w - 2 * t, h - 2 * t, Math.max(0.01, r - t * 0.6));
  s.holes.push(hole);
  return s;
}

function circle(r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(0, 0, r, 0, Math.PI * 2, false);
  return s;
}

/** "+" sign rotated 45°, the hi-hat pedal X. */
function crossShape(arm: number, w: number): THREE.Shape {
  const pts: [number, number][] = [[w, arm], [-w, arm], [-w, w], [-arm, w], [-arm, -w], [-w, -w],
    [-w, -arm], [w, -arm], [w, -w], [arm, -w], [arm, w], [w, w]];
  const c = Math.SQRT1_2;
  const rot = pts.map(([x, y]) => new THREE.Vector2((x - y) * c, (x + y) * c));
  return new THREE.Shape(rot);
}

function ringShape(outer: number, inner: number): THREE.Shape {
  const s = circle(outer);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  s.holes.push(hole);
  return s;
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function radialTexture(): THREE.Texture {
  return canvasTexture(64, 64, g => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

function ampTexture(): THREE.Texture {
  return canvasTexture(512, 512, g => {
    g.fillStyle = '#21160e';
    g.fillRect(0, 0, 512, 512);
    g.fillStyle = '#0d0a08';
    g.fillRect(22, 22, 468, 468);
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    for (let i = 22; i < 490; i += 6) { g.beginPath(); g.moveTo(i, 22); g.lineTo(i, 490); g.stroke(); }
    g.strokeStyle = '#3a2a1c';
    g.lineWidth = 6;
    g.strokeRect(22, 22, 468, 468);
  });
}

function ampHeadTexture(): THREE.Texture {
  return canvasTexture(512, 160, g => {
    g.fillStyle = '#17110c';
    g.fillRect(0, 0, 512, 160);
    g.fillStyle = '#2a1e14';
    g.fillRect(14, 14, 484, 132);
    g.font = 'italic 700 34px system-ui, sans-serif';
    g.fillStyle = '#d8b07a';
    g.fillText('opendrumhero', 30, 62);
    for (let i = 0; i < 7; i++) {
      const x = 70 + i * 62, y = 110;
      g.fillStyle = '#0b0807';
      g.beginPath(); g.arc(x, y, 17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#c9a26a';
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
    }
    g.fillStyle = '#ff7a1a';
    g.shadowColor = '#ff7a1a';
    g.shadowBlur = 14;
    g.beginPath(); g.arc(470, 50, 7, 0, Math.PI * 2); g.fill();
  });
}

/** Piece icon (neon stroke style in the lane color), drawn on a canvas. */
function instrumentIcon(lane: Lane, color: string): THREE.Texture {
  return canvasTexture(128, 128, g => drawInstrumentIcon(g, lane, color));
}

function tolexTexture(): THREE.Texture {
  const t = canvasTexture(256, 256, g => {
    g.fillStyle = '#1c1612';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2600; i++) {   // grainy leather texture
      const v = 20 + Math.random() * 30;
      g.fillStyle = `rgba(${v + 10},${v},${v - 6},0.5)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  return t;
}

function grilleTexture(): THREE.Texture {
  return canvasTexture(512, 512, g => {
    g.fillStyle = '#16120e';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(160,140,110,0.10)';
    g.lineWidth = 2;
    for (let i = -512; i < 512; i += 7) {          // fabric weave
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 512, 512); g.stroke();
      g.beginPath(); g.moveTo(i + 512, 0); g.lineTo(i, 512); g.stroke();
    }
    g.fillStyle = '#c8a46e';
    g.font = 'italic 700 30px system-ui, sans-serif';
    g.fillText('opendrumhero', 296, 492);
  });
}

function wooferTexture(): THREE.Texture {
  return canvasTexture(256, 256, g => {
    const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
    grad.addColorStop(0, '#5a4a3a');
    grad.addColorStop(0.18, '#1a1410');
    grad.addColorStop(0.75, '#2b231c');
    grad.addColorStop(0.92, '#0c0907');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(128, 128, 128, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let r = 40; r < 118; r += 12) { g.beginPath(); g.arc(128, 128, r, 0, Math.PI * 2); g.stroke(); }
  });
}

function textSprite(text: string): THREE.Sprite {
  const tex = canvasTexture(512, 96, g => {
    g.font = '700 54px system-ui, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    g.fillStyle = '#ffffff';
    g.shadowColor = '#5ac8ff';
    g.shadowBlur = 18;
    g.fillText(text, 500, 48);
  });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  s.scale.set(4, 0.75, 1);
  s.center.set(1, 0.5);
  return s;
}

/**
 * Updates how many instances to draw and sends only the ones in use to the GPU.
 * Before, every frame re-sent the whole buffers (2048 positions per note type, ~2.8 MB per frame);
 * on Chrome/Windows that copy goes through an intermediate buffer and caused periodic stutters.
 */
function setUsed(m: THREE.InstancedMesh, count: number): void {
  const prev = m.count;
  m.count = count;
  if (!count && !prev) return;   // nothing before, nothing now: nothing to send
  for (const attr of [m.instanceMatrix, m.instanceColor]) {
    if (!attr) continue;
    attr.clearUpdateRanges();
    if (count) attr.addUpdateRange(0, count * attr.itemSize);
    attr.needsUpdate = true;
  }
}
