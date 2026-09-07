import Phaser from 'phaser';

export const PLANE_SPRITE = '/assets/plane.png';
export const CARRIER_LEFT = '/assets/carrier-left.png';
export const CARRIER_RIGHT = '/assets/carrier-right.png';
export const ROCKET_SPRITE = '/assets/rocket.png';
export const CLOUD_SPRITE = '/assets/cloud.png';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function bezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}

function bezierTangent(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

function skyEvents(mod) {
  if (!mod) return [];
  if (Array.isArray(mod.events) && mod.events.some((ev) => ev?.kind)) {
    return mod.events.filter((ev) => ev?.kind);
  }
  const out = [];
  for (const p of mod.pickups || []) {
    const t = Number(p.t) || 0.2;
    if (p.kind === 'rocket' || p.drop) out.push({ t, kind: 'rocket', value: 2 });
    else if (p.kind === 'mul' || p.mul) out.push({ t, kind: 'mul', value: p.mul || p.value });
    else out.push({ t, kind: 'add', value: p.add || p.value || 1 });
  }
  for (const r of mod.rockets || []) {
    out.push({ t: Number(r.t) || 0.2, kind: 'rocket', value: 2 });
  }
  return out;
}

// The world is far wider and taller than the viewport: the camera rides along
// with the plane and the sea scrolls out of frame once it climbs, exactly as in
// the reference game.
const WORLD_SPANS = 5.5; // screens of horizontal course
const SKY_SPANS = 3.2; // screens of climbing room above the waterline
const SEA_SPANS = 1.1; // screens of water below the waterline
const CLOUD_COUNT = 30;
const DECOR_NUMBERS = 96;
const DECOR_ROCKETS = 16;

// Camera keeps the plane right of centre and half way up the frame.
const PLANE_SCREEN_X = 0.64;
const PLANE_SCREEN_Y = 0.5;
// Lowest the camera descends, chosen so the waterline settles at 63.2% height.
const HORIZON_SCREEN = 0.632;

function waveFor(events) {
  if (!events.length) return { ratio: 0.6, freq: Math.PI * 3.2 };
  let seed = 0;
  for (const ev of events) seed += Math.round(ev.t * 1000) + (Number(ev.value) || 0) * 7;
  return {
    ratio: 0.5 + (seed % 51) / 100,
    freq: Math.PI * (2.2 + (Math.floor(seed / 4) % 25) / 10),
  };
}

// Deterministic scatter so decor keeps its place across redraws.
function hashUnit(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export class PlaneScene extends Phaser.Scene {
  constructor() {
    super('plane');
    this.phase = 'waiting';
    this.displayM = 1;
    this.visualM = 1;
    this.courseM = 1;
    this.visualCourse = 1;
    this.label = { x: 0, y: 0 };
    this.control = 'auto';
    this.smooth = { x: 0, y: 0, angle: -8 };
    this.nextSpawnT = 0.08;
    this.spawnIndex = 0;
    this.trailPts = [];
    this.trailAcc = 0;
    this.baseScale = 0.16;
    this.tick = 0;
    this.launched = false;
    this.round = 'waiting';
    this.skySpawned = false;
    this.roundMods = null;
    this.activeEvent = null;
    this.ringCollected = false;
    this.ringItem = null;
    this.progress = 0;
    this.speedFactor = 1;
    this.roundWave = waveFor([]);
  }

  setSpeed(value) {
    this.speedFactor = Phaser.Math.Clamp(Number(value) || 2, 1, 5) / 2;
  }

  preload() {
    this.load.image('plane-raw', PLANE_SPRITE);
    this.load.image('carrier-left-raw', CARRIER_LEFT);
    this.load.image('carrier-right-raw', CARRIER_RIGHT);
    this.load.image('rocket-raw', ROCKET_SPRITE);
    this.load.image('cloud-raw', CLOUD_SPRITE);
  }

  chromaCrop(srcKey, destKey) {
    const src = this.textures.get(srcKey).getSourceImage();
    const canvas = document.createElement('canvas');
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = img;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 170 && b > 170 && g < 90) data[i + 3] = 0;
      else if (r > 200 && b > 150 && g < 150) data[i + 3] = Math.min(data[i + 3], 30);
    }
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    const pad = 2;
    const cw = Math.max(8, maxX - minX + 1 + pad * 2);
    const ch = Math.max(8, maxY - minY + 1 + pad * 2);
    const out = document.createElement('canvas');
    out.width = cw;
    out.height = ch;
    out.getContext('2d').drawImage(canvas, minX - pad, minY - pad, cw, ch, 0, 0, cw, ch);
    if (this.textures.exists(destKey)) this.textures.remove(destKey);
    this.textures.addCanvas(destKey, out);
  }

  create() {
    this.sky = this.add.graphics().setDepth(0);
    this.sea = this.add.graphics().setDepth(0);
    this.sparkles = this.add.graphics().setDepth(1);
    this.pickups = this.add.container(0, 0).setDepth(7);
    this.trail = this.add.graphics().setDepth(5);
    this.fxLayer = this.add.graphics().setDepth(5);
    this.cloudLayer = this.add.graphics().setDepth(1);
    this.dots = Array.from({ length: 260 }, (_, i) => ({
      x: hashUnit(i + 1),
      y: hashUnit(i + 91),
      r: hashUnit(i + 181) * 1.4 + 0.5,
      s: hashUnit(i + 271) * 2 + 0.4,
    }));
    this.items = [];
    this.decor = [];
    this.chromaCrop('plane-raw', 'plane');
    this.chromaCrop('carrier-left-raw', 'carrier-left');
    this.chromaCrop('carrier-right-raw', 'carrier-right');
    this.chromaCrop('rocket-raw', 'rocket');
    this.chromaCrop('cloud-raw', 'cloud');

    // Squadron emblem is pinned to the viewport in the reference game, not to
    // the world, so it stays put while everything else scrolls past.
    this.mark = this.add
      .text(0, 0, 'A', {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '92px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setAlpha(0.08)
      .setScrollFactor(0)
      .setDepth(1);

    // Only two carriers exist: the one launched from and the one landed on.
    this.ships = [
      this.add.image(0, 0, 'carrier-left').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-right').setDepth(2).setOrigin(0.5, 0.72),
    ];
    this.catapultRig = this.add.graphics().setDepth(3);
    this.cloudSprites = Array.from({ length: CLOUD_COUNT }, () =>
      this.add.image(0, 0, 'cloud').setDepth(1).setAlpha(0.5).setTint(0x9fb0d4),
    );

    this.plane = this.add.image(0, 0, 'plane').setDepth(8);
    this.plane.setOrigin(0.52, 0.58);
    this.plane.setAlpha(0);

    this.redrawBackdrop();
    const start = this.startPoint();
    this.smooth = { x: start.x, y: start.y, angle: -12 };
    this.updateCamera(0, true);
    this.placeFromSmooth();
    this.appearPlane();
    this.scale.on('resize', () => this.redrawBackdrop());
  }

  size() {
    return {
      w: this.scale.gameSize.width,
      h: this.scale.gameSize.height,
    };
  }

  // Waterline sits at world y = 0; the sky runs into negative y.
  world() {
    const { w, h } = this.size();
    return {
      w,
      h,
      worldW: w * WORLD_SPANS,
      skyTop: -h * SKY_SPANS,
      seaBottom: h * SEA_SPANS,
    };
  }

  layout() {
    const { w, h, worldW } = this.world();
    const ww = w * 0.52;
    const launch = { x: w * 0.16, y: 0, ww };
    const target = { x: worldW - w * 0.34, y: 0, ww };
    return { w, h, worldW, horizon: 0, fleet: [launch, target], left: launch, ship: target };
  }

  // Keeps the plane sized against the deck it launches from.
  planeHeightFor(deckWidth) {
    return Math.max(26, Math.min(96, deckWidth * 0.2));
  }

  deckClearance() {
    return Math.max(12, (this.plane?.displayHeight || 40) * 0.4);
  }

  startPoint() {
    const { left } = this.layout();
    return { x: left.x - left.ww * 0.16, y: -this.deckClearance() };
  }

  landPoint() {
    const { ship } = this.layout();
    return { x: ship.x - ship.ww * 0.1, y: -this.deckClearance() };
  }

  pathPoints() {
    const { h } = this.world();
    const start = this.startPoint();
    const land = this.landPoint();
    const span = land.x - start.x;
    // Climbs about a screen and a half above the waterline, so the sea leaves
    // the frame for most of the flight and only returns for the landing.
    return [
      start,
      { x: start.x + span * 0.22, y: -h * 1.05 },
      { x: start.x + span * 0.7, y: -h * 1.5 },
      { x: land.x - 8, y: -h * 0.32 },
    ];
  }

  pathAt(t) {
    const [p0, p1, p2, p3] = this.pathPoints();
    const clamped = Phaser.Math.Clamp(t, 0, 1);
    const pos = bezier(p0, p1, p2, p3, clamped);
    const wv = this.roundWave;
    const amp = (this.waveCap ?? 40) * wv.ratio;
    const wave = Math.sin(clamped * wv.freq) * amp * Math.sin(Math.PI * clamped);
    const tan = bezierTangent(p0, p1, p2, p3, clamped);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len;
    const ny = tan.x / len;
    return {
      x: pos.x + nx * wave,
      y: pos.y + ny * wave,
      angle: Phaser.Math.RadToDeg(Math.atan2(tan.y, tan.x)) * 0.62,
      nx,
      ny,
      tan,
    };
  }

  // Height of the course at a given world x. The course is monotonic in x, so a
  // coarse sample with a linear fill is accurate enough to hang scenery on.
  courseYAtX(x) {
    const [p0, p1, p2, p3] = this.pathPoints();
    let prev = bezier(p0, p1, p2, p3, 0);
    for (let i = 1; i <= 48; i += 1) {
      const cur = bezier(p0, p1, p2, p3, i / 48);
      if (x <= cur.x) {
        const span = cur.x - prev.x || 1;
        return lerp(prev.y, cur.y, Phaser.Math.Clamp((x - prev.x) / span, 0, 1));
      }
      prev = cur;
    }
    return prev.y;
  }

  courseT(progress) {
    return Phaser.Math.Clamp(progress * 0.97, 0, 0.97);
  }

  flightT() {
    return this.courseT(this.progress);
  }

  // Camera rides with the plane: no zoom, the world scrolls instead. It stops
  // descending once the waterline reaches its reference height, so a crash into
  // the sea stays in frame instead of dragging the horizon off screen.
  cameraTarget() {
    const { w, h, worldW } = this.world();
    const anchorX = this.smooth.x - w * (PLANE_SCREEN_X - 0.5);
    const anchorY = this.smooth.y - h * (PLANE_SCREEN_Y - 0.5);
    const lowest = h * (0.5 - HORIZON_SCREEN);
    return {
      zoom: 1,
      x: Phaser.Math.Clamp(anchorX, w / 2, worldW - w / 2),
      y: Math.min(anchorY, lowest),
    };
  }

  updateCamera(delta, snap = false) {
    const cam = this.cameras.main;
    const target = this.cameraTarget();
    if (snap || !this.cam) {
      this.cam = { ...target };
    } else {
      // Tight follow: the reference keeps the plane pinned in the frame, so the
      // camera may only lag enough to absorb the clamp transitions.
      const k = 1 - Math.exp(-delta / 45);
      this.cam.x = lerp(this.cam.x, target.x, k);
      this.cam.y = lerp(this.cam.y, target.y, k);
      this.cam.zoom = target.zoom;
    }
    cam.setZoom(this.cam.zoom);
    cam.centerOn(this.cam.x, this.cam.y);
  }

  catapultEnd() {
    const { w } = this.size();
    const start = this.startPoint();
    return { x: start.x + Math.min(96, w * 0.07), y: -30 };
  }

  drawCatapult() {
    const g = this.catapultRig;
    if (!g) return;
    g.clear();
    const { fleet } = this.layout();
    const deck = fleet[0];
    const s = Math.max(0.4, deck.ww / 340);
    const start = this.startPoint();
    const railFrom = deck.x - deck.ww * 0.4;
    const railTo = deck.x + deck.ww * 0.34;

    g.fillStyle(0x1d2536, 1);
    g.fillRect(railFrom, -4 * s, railTo - railFrom, 5 * s);
    g.fillStyle(0xffc933, 0.8);
    g.fillRect(railFrom + 4 * s, -2 * s, railTo - railFrom - 8 * s, 1.6 * s);

    // Shuttle the plane is hooked to, sitting under its wheels.
    g.fillStyle(0xdfe6f2, 1);
    g.fillRect(start.x - 10 * s, -9 * s, 20 * s, 6 * s);
    g.fillStyle(0x8fa2bd, 1);
    g.fillRect(start.x - 10 * s, -4 * s, 20 * s, 2 * s);

    // Jet blast deflector raised behind the shuttle.
    const plateX = start.x - 22 * s;
    if (plateX > railFrom) {
      g.fillStyle(0x39445c, 1);
      g.beginPath();
      g.moveTo(plateX - 12 * s, 0);
      g.lineTo(plateX - 2 * s, -18 * s);
      g.lineTo(plateX + 6 * s, -17 * s);
      g.lineTo(plateX + 2 * s, 0);
      g.closePath();
      g.fillPath();
    }
  }

  catapultBlast(x, y) {
    for (let i = 0; i < 4; i += 1) {
      const puff = this.add
        .ellipse(x - i * 12, y + 14 + (i % 2) * 5, 16, 10, 0xffffff, 0.5)
        .setDepth(6);
      this.tweens.add({
        targets: puff,
        x: puff.x - 46 - i * 16,
        scaleX: 3.4,
        scaleY: 2.4,
        alpha: 0,
        duration: Math.round((420 + i * 80) / this.speedFactor),
        ease: 'Sine.out',
        onComplete: () => puff.destroy(),
      });
    }
  }

  redrawBackdrop() {
    const { w, h, worldW, skyTop, seaBottom } = this.world();
    const { fleet } = this.layout();
    // Palette sampled from the reference game: the sky brightens towards the
    // waterline and the sea is a flat, darker blue.
    this.sky.clear();
    this.sky.fillGradientStyle(0x1b2a63, 0x1b2a63, 0x34488f, 0x34488f, 1);
    this.sky.fillRect(0, skyTop, worldW, -skyTop);
    this.sea.clear();
    this.sea.fillStyle(0x0d1c71, 1);
    this.sea.fillRect(0, 0, worldW, seaBottom);
    this.sea.lineStyle(1, 0xffffff, 0.28);
    this.sea.lineBetween(0, 0, worldW, 0);
    this.ships?.forEach((img, i) => {
      const slot = fleet[i];
      img.setVisible(Boolean(slot));
      if (!slot) return;
      img.setPosition(slot.x, slot.y);
      img.setDisplaySize(slot.ww, (img.height / img.width) * slot.ww);
    });
    if (this.plane) {
      const targetH = this.planeHeightFor(fleet[0].ww);
      this.baseScale = targetH / this.plane.height;
      if (this.phase !== 'appearing') this.plane.setScale(this.baseScale);
    }
    this.drawCatapult();
    this.waveCap = Math.max(20, h * 0.05);
    this.scatterDecor();
    this.layoutClouds();
    this.mark?.setPosition(w / 2, h * 0.07);
    this.mark?.setFontSize(Math.round(Math.min(96, w * 0.1)));
  }

  clearPickups() {
    this.items.forEach((item) => item.node.destroy());
    this.items = [];
    this.pickups.removeAll(true);
    this.nextSpawnT = 0.08;
    this.spawnIndex = 0;
    this.skySpawned = false;
    this.scatterDecor();
  }

  // The reference sky is littered with numbers and missiles that are never
  // collected — they exist to make the sky feel busy while the world scrolls.
  // Scenery is hung off the course rather than sprayed over the whole world, so
  // it stays dense in frame without spawning thousands of unseen objects.
  scatterDecor() {
    this.decor?.forEach((d) => d.node.destroy());
    this.decor = [];
    const clear = Math.max(90, (this.plane?.displayWidth || 90) * 1.5);
    const values = [1, 1, 2, 2, 2, 3, 5, 10];

    for (let i = 0; i < DECOR_NUMBERS; i += 1) {
      const spot = this.corridorSpot(i * 3 + 5, clear, 0.6);
      // Seeded well away from the offset seed, otherwise face value would track
      // distance from the course and every nearby number would read "1".
      const value = values[Math.floor(hashUnit(i * 7 + 1013) * values.length)];
      this.decor.push({ node: this.numberLabel(spot.x, spot.y, String(value)) });
    }

    for (let i = 0; i < DECOR_ROCKETS; i += 1) {
      const spot = this.corridorSpot(i * 5 + 41, clear * 1.6, 0.9);
      const img = this.add
        .image(spot.x, spot.y, 'rocket')
        .setDisplaySize(74, 74)
        .setAngle(186)
        .setDepth(6);
      this.decor.push({ node: img, drift: 26 + hashUnit(i * 5 + 43) * 34 });
    }
  }

  // A point beside the course: spread along its length, offset above or below
  // by at least `clear` so the plane can never brush it.
  corridorSpot(seed, clear, spread) {
    const { h, worldW } = this.world();
    const x = hashUnit(seed) * worldW;
    const base = this.courseYAtX(x);
    const offset = clear + hashUnit(seed + 2) * h * spread;
    const ceiling = -h * 0.08;
    const below = base + offset;
    // Where the course runs close to the water there is no room underneath it.
    // Those points are mirrored above the course instead of being clamped, which
    // would otherwise stack every one of them onto the waterline.
    const under = hashUnit(seed + 1) >= 0.5 && below < ceiling;
    return { x, y: under ? below : base - offset };
  }

  driftDecor(delta) {
    if (!this.decor?.length) return;
    const { worldW } = this.world();
    for (const d of this.decor) {
      if (!d.drift) continue;
      d.node.x -= d.drift * (delta / 1000);
      if (d.node.x < -120) d.node.x = worldW + 120;
    }
  }

  // Plain white numeral with the short dark underline the reference uses.
  numberLabel(x, y, value) {
    const label = this.add
      .text(0, 0, String(value).replace('.', ','), {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '46px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(7,20,51,0.75)', 6, false, true);
    const bar = this.add.rectangle(0, label.height * 0.42, label.width * 0.42, 5, 0x121a35, 0.85);
    return this.add.container(x, y, [bar, label]).setDepth(6);
  }

  spawnAlongCourse() {
    this.items.forEach((item) => item.node.destroy());
    this.items = [];
    this.pickups.removeAll(true);
    this.skySpawned = true;
    const events = skyEvents(this.roundMods);
    events.forEach((ev, i) => {
      const t = Phaser.Math.Clamp(Number(ev.t) || 0.2, 0.06, 0.95);
      const path = this.pathAt(this.courseT(t));
      const side = i % 2 === 0 ? -1 : 1;
      const offset = (ev.kind === 'rocket' ? 16 : 9) + (i % 3) * 7;
      const x = path.x + path.nx * offset * side;
      const y = path.y + path.ny * offset * side;
      if (ev.kind === 'rocket') this.addBomb(x, y, t, 0.5, t);
      else if (ev.kind === 'mul') this.addMultiplier(x, y, `x${ev.value}`, t);
      else this.addMultiplier(x, y, String(ev.value), t);
    });
  }

  addBomb(x, y, t = 0, drop = 0.15, at = 1) {
    const img = this.add.image(0, 0, 'rocket').setDisplaySize(72, 72).setAngle(186);
    const node = this.add.container(x, y, [img]).setDepth(7);
    this.pickups.add(node);
    this.items.push({
      type: 'bomb',
      drop,
      at,
      node,
      x,
      y,
      t,
      alive: true,
      bob: 5,
    });
  }

  addMultiplier(x, y, value, t = 0) {
    const node = this.numberLabel(x, y, value).setDepth(7);
    this.pickups.add(node);
    this.items.push({ type: 'mult', value, node, x, y, t, alive: true, bob: -10 });
  }

  collectNearby() {
    if ((this.phase !== 'flying' && this.phase !== 'takeoff') || !this.plane) return;
    const reach = Math.max(36, this.plane.displayWidth * 0.42);
    for (const item of this.items) {
      if (!item.alive) continue;
      const d = Phaser.Math.Distance.Between(this.plane.x, this.plane.y, item.node.x, item.node.y);
      const hit = item.type === 'bomb' ? d < reach + 10 : d < reach;
      if (!hit) continue;
      item.alive = false;
      if (item.type === 'mult') {
        this.collectFlash(item.node.x, item.node.y, `×${String(item.value).replace('x', '')}`);
        this.tweens.add({
          targets: item.node,
          scale: 1.4,
          alpha: 0,
          duration: 220,
          onComplete: () => item.node.destroy(),
        });
      } else {
        this.explodeAt(item.node.x, item.node.y);
        this.popup(item.node.x, item.node.y, '÷2', '#ff6b6b');
        this.tweens.add({
          targets: item.node,
          scale: 1.5,
          alpha: 0,
          duration: 200,
          onComplete: () => item.node.destroy(),
        });
      }
    }
  }

  // Collected numbers burst as a white star with the multiplier written across
  // it, matching the reference pickup effect.
  collectFlash(x, y, text) {
    const star = this.add.graphics().setDepth(8);
    star.fillStyle(0xffffff, 0.92);
    star.beginPath();
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      const r = i % 2 === 0 ? 30 : 12;
      const px = Math.cos(a) * r;
      const py = Math.sin(a) * r;
      if (i === 0) star.moveTo(px, py);
      else star.lineTo(px, py);
    }
    star.closePath();
    star.fillPath();
    const label = this.add
      .text(0, 0, text, {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '30px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setShadow(0, 2, 'rgba(7,20,51,0.8)', 5, false, true);
    const node = this.add.container(x, y, [star, label]).setDepth(8);
    this.tweens.add({
      targets: node,
      scale: 1.5,
      alpha: 0,
      duration: 520,
      ease: 'Sine.out',
      onComplete: () => node.destroy(),
    });
  }

  popup(x, y, text, color = '#ffe14a') {
    const label = this.add
      .text(x, y, text, {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '22px',
        color,
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setDepth(8);
    this.tweens.add({
      targets: label,
      y: y - 40,
      alpha: 0,
      duration: 700,
      onComplete: () => label.destroy(),
    });
  }

  explodeAt(x, y) {
    const flash = this.add.circle(x, y, 8, 0xffb347, 1).setDepth(7);
    this.tweens.add({
      targets: flash,
      scale: 8,
      alpha: 0,
      duration: 420,
      onComplete: () => flash.destroy(),
    });
  }

  appearPlane() {
    if (!this.plane) return;
    this.tweens.killTweensOf(this.plane);
    this.plane.setAlpha(0);
    this.plane.setScale(this.baseScale * 0.78);
    this.tweens.add({
      targets: this.plane,
      alpha: 1,
      scale: this.baseScale,
      duration: 520,
      ease: 'Sine.out',
    });
  }

  clearTrail() {
    this.trailPts = [];
    this.trailAcc = 0;
    this.trail?.clear();
  }

  pushTrail(delta) {
    if (!this.plane || (this.phase !== 'flying' && this.phase !== 'landing' && this.phase !== 'takeoff')) {
      if (this.phase === 'waiting' || this.phase === 'landed') this.trail?.clear();
      return;
    }
    this.trailAcc += delta;
    if (this.trailAcc < 55) return;
    this.trailAcc = 0;
    const back = this.plane.displayWidth * 0.5;
    const n = this.trailSeq = (this.trailSeq || 0) + 1;
    this.trailPts.push({
      x: this.plane.x - back,
      y: this.plane.y + 4 + (hashUnit(n + 61) - 0.5) * 10,
      r: 6 + hashUnit(n + 3) * 8,
    });
    if (this.trailPts.length > 22) this.trailPts.shift();
  }

  // Exhaust is a thinning chain of dark smoke puffs, not a drawn line.
  drawTrail() {
    if (!this.trail) return;
    this.trail.clear();
    if (this.activeEvent === 'clouds') return;
    const n = this.trailPts.length;
    if (!n) return;
    const boost = this.activeEvent === 'boost';
    for (let i = 0; i < n; i += 1) {
      const p = this.trailPts[i];
      const age = i / n;
      this.trail.fillStyle(boost ? 0xff8a3a : 0x6b6152, 0.1 + age * 0.4);
      this.trail.fillCircle(p.x, p.y, p.r * (0.45 + age * 0.75));
    }
  }

  // Cloud heights are fixed at layout time: they drift far too slowly for the
  // course height under them to change, and resampling it every frame for every
  // cloud would cost more than the whole backdrop.
  layoutClouds() {
    if (!this.cloudSprites?.length) return;
    const { w } = this.world();
    this.cloudSeeds = this.cloudSprites.map((cloud, i) => {
      const width = Math.max(40, w * 0.055 * (0.55 + hashUnit(i + 11) * 0.8));
      cloud.setDisplaySize(width, width * 0.42);
      const spot = this.corridorSpot(i * 7 + 101, width * 0.8, 1.15);
      return { width, y: spot.y, home: spot.x, drift: 5 + hashUnit(i + 21) * 14 };
    });
  }

  drawClouds(now) {
    if (!this.cloudSeeds?.length) return;
    const { worldW } = this.world();
    this.cloudSprites.forEach((cloud, i) => {
      const seed = this.cloudSeeds[i];
      const span = worldW + seed.width * 2;
      cloud.setPosition(((seed.home + now * seed.drift) % span) - seed.width, seed.y);
    });
  }

  bobPickups(now) {
    for (const item of this.items) {
      if (!item.alive) continue;
      item.node.y = item.y + Math.sin(now * 2.4 + item.t * 8) * (item.bob || 8);
    }
  }

  // The HTML label lives outside the canvas, so world coordinates have to be
  // projected through the camera before the DOM can use them.
  syncLabel(lift = this.plane ? this.plane.displayHeight * 0.28 : 0) {
    if (!this.plane) return;
    const cam = this.cameras.main;
    const view = cam.worldView;
    const wx = this.plane.x;
    const wy = this.plane.y - lift;
    if (!view || view.width <= 0 || view.height <= 0) {
      this.label = { x: wx, y: wy };
      return;
    }
    this.label = {
      x: ((wx - view.x) / view.width) * cam.width,
      y: ((wy - view.y) / view.height) * cam.height,
    };
  }

  placeFromSmooth() {
    if (!this.plane) return;
    this.plane.setPosition(this.smooth.x, this.smooth.y);
    this.plane.setAngle(this.smooth.angle);
    this.syncLabel();
  }

  update(_time, delta) {
    const now = _time / 1000;
    this.tick += 1;
    if ((this.tick & 1) === 1) this.drawSparkles(now);

    this.pushTrail(delta);
    if ((this.tick & 1) === 0) this.drawTrail();
    this.drawClouds(now);
    this.driftDecor(delta);
    this.bobPickups(now);
    this.maybeCollectRing();

    if (this.control === 'auto' && this.plane) {
      const follow = 1 - Math.pow(0.0008, delta / 1000);
      if (!this.launched || this.phase === 'waiting') {
        const start = this.startPoint();
        this.smooth.x = lerp(this.smooth.x, start.x, follow);
        this.smooth.y = lerp(this.smooth.y, start.y, follow);
        this.smooth.angle = lerp(this.smooth.angle, -20, follow);
      } else if (this.phase === 'takeoff') {
        const point = this.pathAt(0.16);
        this.smooth.x = lerp(this.smooth.x, point.x, follow * 0.9);
        this.smooth.y = lerp(this.smooth.y, point.y, follow * 0.9);
        this.smooth.angle = lerp(this.smooth.angle, point.angle, follow * 0.55);
        this.collectNearby();
      } else if (this.phase === 'flying') {
        this.visualM = lerp(
          this.visualM,
          this.displayM,
          this.displayM < this.visualM - 0.01 ? 1 - Math.pow(0.02, delta / 16.67) : 1 - Math.pow(0.08, delta / 16.67),
        );
        this.visualCourse = lerp(
          this.visualCourse,
          this.courseM,
          1 - Math.pow(0.08, delta / 16.67),
        );
        const point = this.pathAt(this.flightT());
        this.smooth.x = lerp(this.smooth.x, point.x, follow * 0.9);
        this.smooth.y = lerp(this.smooth.y, point.y, follow * 0.9);
        this.smooth.angle = lerp(this.smooth.angle, point.angle, follow * 0.55);
        if (this.activeEvent === 'turbulence') {
          this.smooth.x += Math.sin(now * 28) * 5;
          this.smooth.y += Math.cos(now * 21) * 4;
        }
        this.collectNearby();
      } else if (this.phase === 'landed') {
        const land = this.landPoint();
        this.smooth.x = lerp(this.smooth.x, land.x, follow);
        this.smooth.y = lerp(this.smooth.y, land.y, follow);
        this.smooth.angle = lerp(this.smooth.angle, -16, follow);
      }
      this.placeFromSmooth();
    }

    this.updateCamera(delta);
  }

  // Glints on the water, drawn only across the stretch the camera can see.
  drawSparkles(now) {
    const { h, worldW, seaBottom } = this.world();
    const view = this.cameras.main.worldView;
    this.sparkles.clear();
    if (!view || view.bottom < 0) return;
    for (const d of this.dots) {
      const x = (d.x * worldW + now * d.s * 12) % worldW;
      if (x < view.x - 40 || x > view.right + 40) continue;
      // Glints crowd just under the waterline and thin out towards the viewer.
      const y = 8 + Math.pow(d.y, 2.2) * (seaBottom - 16);
      this.sparkles.fillStyle(0xffffff, 0.25 + Math.abs(Math.sin(now * d.s + d.y * 6)) * 0.45);
      this.sparkles.fillCircle(x, y, d.r * (1 + (1 - d.y) * 0.4) * (h / 900));
    }
  }

  clearRoundFx() {
    this.roundMods = null;
    this.roundWave = waveFor([]);
    this.activeEvent = null;
    this.ringCollected = false;
    if (this.ringItem) {
      this.ringItem.node.destroy();
      this.ringItem = null;
    }
    this.cloudLayer?.clear();
    this.fxLayer?.clear();
    this.plane?.clearTint();
  }

  applyRoundEvents(mod) {
    if (this.ringItem) {
      this.ringItem.node.destroy();
      this.ringItem = null;
    }
    this.roundMods = mod || null;
    this.ringCollected = false;
    this.activeEvent = null;
    if (mod?.golden) this.plane?.setTint(0xffd56a);
    else this.plane?.clearTint();
    const events = skyEvents(mod);
    this.roundWave = waveFor(events);
    if (events.length) this.spawnAlongCourse();
    else this.clearPickups();
    if (mod?.ringAt) {
      const t = Phaser.Math.Clamp(Number(mod.ringAt), 0.12, 0.85);
      const path = this.pathAt(t);
      this.spawnRing(path.x, path.y, t);
    }
    this.redrawBackdrop();
  }

  setActiveEvent(type) {
    this.activeEvent = type || null;
  }

  spawnRing(x, y, t) {
    const g = this.add.graphics();
    g.lineStyle(8, 0xffe14a, 0.95);
    g.strokeCircle(0, 0, 22);
    g.lineStyle(3, 0xffffff, 0.7);
    g.strokeCircle(0, 0, 14);
    const node = this.add.container(x, y, [g]).setDepth(5);
    this.pickups.add(node);
    this.ringItem = { node, x, y, t, alive: true };
  }

  maybeCollectRing() {
    if (!this.ringItem?.alive || !this.roundMods?.ringAt) return;
    if (this.visualCourse + 0.02 < this.roundMods.ringAt && this.progress + 0.02 < this.roundMods.ringAt) return;
    this.ringItem.alive = false;
    this.ringCollected = true;
    this.popup(this.ringItem.node.x, this.ringItem.node.y, '+кольцо');
    this.tweens.add({
      targets: this.ringItem.node,
      scale: 1.6,
      alpha: 0,
      duration: 280,
      onComplete: () => this.ringItem?.node.destroy(),
    });
  }

  setPhase(phase) {
    const prev = this.phase;
    if (phase === 'flying' && (prev === 'landing' || prev === 'landed')) return;
    this.round = phase;
    if (phase === 'flying') return;
    if (phase === 'waiting') {
      this.launched = false;
      this.phase = 'waiting';
      this.control = 'auto';
      this.displayM = 1;
      this.visualM = 1;
      this.courseM = 1;
      this.visualCourse = 1;
      this.progress = 0;
      this.clearRoundFx();
      this.clearPickups();
      this.clearTrail();
      this.stopMotion();
      const start = this.startPoint();
      this.smooth.x = start.x;
      this.smooth.y = start.y;
      this.updateCamera(0, true);
      if (prev !== 'waiting') this.appearPlane();
      else this.plane?.setAlpha(1);
    }
  }

  stopMotion() {
    this.tweens.killTweensOf(this.plane);
    if (this.moveDummy) this.tweens.killTweensOf(this.moveDummy);
  }

  launch() {
    if (!this.plane) return;
    if (this.launched && (this.phase === 'flying' || this.phase === 'takeoff')) return;
    this.stopMotion();
    this.launched = true;
    this.visualM = 1;
    this.displayM = 1;
    this.courseM = 1;
    this.visualCourse = 1;
    this.progress = 0;
    this.control = 'tween';
    this.phase = 'takeoff';
    this.plane.setAlpha(1);
    this.plane.setScale(this.baseScale);
    const start = this.startPoint();
    this.plane.setPosition(start.x, start.y);
    this.plane.setAngle(-4);
    if (skyEvents(this.roundMods).length) this.spawnAlongCourse();

    const sync = () => {
      this.smooth.x = this.plane.x;
      this.smooth.y = this.plane.y;
      this.smooth.angle = this.plane.angle;
      this.syncLabel();
      this.collectNearby();
    };

    const from = { x: start.x, y: start.y, angle: -4 };
    const ctrl = this.catapultEnd();
    this.moveDummy = { t: 0 };

    this.catapultBlast(start.x, start.y);
    this.tweens.add({
      targets: this.moveDummy,
      t: 1,
      duration: Math.round(420 / this.speedFactor),
      ease: 'Sine.inOut',
      onUpdate: () => {
        const t = this.moveDummy.t;
        const u = 1 - t;
        const target = this.pathAt(Math.max(0.12, this.flightT()));
        this.plane.x = u * u * from.x + 2 * u * t * ctrl.x + t * t * target.x;
        this.plane.y = u * u * from.y + 2 * u * t * ctrl.y + t * t * target.y;
        this.plane.angle = from.angle + (target.angle - from.angle) * t;
        sync();
      },
      onComplete: () => {
        sync();
        this.phase = 'flying';
        this.control = 'auto';
      },
    });
  }

  abortLaunch() {
    this.launched = false;
    this.phase = 'waiting';
    this.control = 'auto';
    this.displayM = 1;
    this.visualM = 1;
    this.courseM = 1;
    this.visualCourse = 1;
    this.clearTrail();
    this.stopMotion();
    this.plane?.setAlpha(1);
    this.plane?.setScale(this.baseScale);
  }

  setMultiplier(value) {
    this.displayM = Number(value) || 1;
  }

  setCourse(value) {
    this.courseM = Number(value) || 1;
  }

  setProgress(value) {
    this.progress = Phaser.Math.Clamp(Number(value) || 0, 0, 1);
  }

  land() {
    if (!this.plane || this.phase === 'landed' || this.phase === 'landing') return;
    this.phase = 'landing';
    this.control = 'tween';
    this.stopMotion();
    this.items.forEach((item) => {
      if (!item.alive) return;
      item.alive = false;
      this.tweens.add({
        targets: item.node,
        alpha: 0,
        duration: 280,
        onComplete: () => item.node.destroy(),
      });
    });
    const from = { x: this.plane.x, y: this.plane.y, angle: this.plane.angle };
    const land = this.landPoint();
    this.moveDummy = { t: 0 };
    this.tweens.add({
      targets: this.moveDummy,
      t: 1,
      duration: 1100,
      ease: 'Sine.inOut',
      onUpdate: () => {
        const t = this.moveDummy.t;
        const mid = {
          x: from.x + (land.x - from.x) * 0.55,
          y: Math.min(from.y, land.y) - 70,
        };
        const u = 1 - t;
        this.plane.x = u * u * from.x + 2 * u * t * mid.x + t * t * land.x;
        this.plane.y = u * u * from.y + 2 * u * t * mid.y + t * t * land.y;
        this.plane.angle = lerp(from.angle, -14, t);
        this.smooth.x = this.plane.x;
        this.smooth.y = this.plane.y;
        this.smooth.angle = this.plane.angle;
        this.syncLabel();
      },
      onComplete: () => {
        this.phase = 'landed';
        this.launched = false;
        this.control = 'auto';
        this.popup(land.x, land.y - 46, 'Посадка!', '#9effb0');
      },
    });
  }

  crash(point) {
    if (!this.launched) return;
    if (this.phase === 'landing' || this.phase === 'landed') return;
    this.displayM = Number(point) || this.displayM;
    this.visualM = this.displayM;
    this.phase = 'crashed';
    this.control = 'tween';
    this.clearTrail();
    const fall = Math.max(0, 18 - this.plane.y);
    const splash = { x: this.plane.x + Math.max(36, fall * 0.22), y: 18 };
    this.stopMotion();
    this.tweens.add({
      targets: this.plane,
      x: splash.x,
      y: splash.y,
      angle: 28,
      // A dive from cruising height covers far more ground than one off the
      // deck, so the fall is timed by distance instead of a fixed beat.
      duration: Phaser.Math.Clamp(Math.round(fall * 0.9), 420, 1500),
      ease: 'Quad.in',
      onUpdate: () => {
        this.smooth.x = this.plane.x;
        this.smooth.y = this.plane.y;
        this.smooth.angle = this.plane.angle;
        this.syncLabel(24);
      },
      onComplete: () => {
        this.popup(splash.x, -10, 'В воду!', '#ff8b8b');
        this.tweens.add({
          targets: this.plane,
          alpha: 0,
          y: splash.y + 40,
          duration: 380,
        });
        const ring = this.add.ellipse(splash.x, 4, 10, 4, 0xffffff, 0.5).setDepth(7);
        this.tweens.add({
          targets: ring,
          scaleX: 8,
          scaleY: 3,
          alpha: 0,
          duration: 700,
          onComplete: () => ring.destroy(),
        });
      },
    });
  }
}
