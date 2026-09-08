import Phaser from 'phaser';
import { getAudio } from '../audio.js';
import { OceanBackground } from '../background/OceanBackground.js';

export const PLANE_SPRITE = '/assets/plane.png';
export const CARRIER_LEFT = '/assets/carrier-left.png';
export const CARRIER_RIGHT = '/assets/carrier-right.png';
export const ROCKET_SPRITE = '/assets/rocket.png';
export const CLOUD_SPRITE = '/assets/cloud.png';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Accelerate from rest and leave with slope 1, so the shot hands off at cruise
// speed instead of slamming into the path and braking.
function easeCatapult(t) {
  return t * t * (2 - t);
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

// Camera keeps the plane right of centre and half way up the frame.
const PLANE_SCREEN_X = 0.64;
const PLANE_SCREEN_Y = 0.5;
// Lowest the camera descends, chosen so the waterline settles at 63.2% height.
const HORIZON_SCREEN = 0.632;
// Energy at deck height. Above this the plane is in the sky; at or below it
// it is close enough to land instead of flying past.
const DECK_ENERGY = 0.36;

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
    this.track = { x: 0, y: 0 };
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
    this.shuttleSlide = 0;
    this.bump = { x: 0, y: 0 };
    this.bumpVel = { x: 0, y: 0 };
    this.angleBias = 0;
    this.launchT = 0;
    this.bounceLock = 0;
    this.shownProgress = 0;
    this.launchedAt = 0;
    this.flightMs = 18000;
    this.glide = 1;
    this.targetGlide = 1;
    this.glideEase = 320;
    this.popY = 0;
    this.onPickup = null;
    this.onAirborne = null;
  }

  setSpeed(value) {
    const speed = Phaser.Math.Clamp(Number(value) || 2, 1, 5);
    this.speedFactor = speed / 2;
    this.flightMs = Math.max(1500, 18000 / speed);
    getAudio().setRpm(this.speedFactor);
  }

  preload() {
    this.load.image('plane-raw', PLANE_SPRITE);
    this.load.image('carrier-left-raw', CARRIER_LEFT);
    this.load.image('carrier-right-raw', CARRIER_RIGHT);
    this.load.image('rocket-raw', ROCKET_SPRITE);
    this.load.image('cloud-raw', CLOUD_SPRITE);
    OceanBackground.preload(this);
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
    this.ocean = new OceanBackground(this, { depth: -20, horizonScreen: HORIZON_SCREEN });
    this.ocean.create();
    this.sky = this.add.graphics().setDepth(0);
    this.sky.setVisible(false);
    this.sea = this.add.graphics().setDepth(0);
    this.waves = this.add.graphics().setDepth(1);
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
    this.sea?.setVisible(false);
    this.waves?.setVisible(false);
    this.sparkles?.setVisible(false);

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

    // Launch carrier plus the checkpoint ships along the course (at least 4 total).
    this.ships = [
      this.add.image(0, 0, 'carrier-left').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-right').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-left').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-right').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-left').setDepth(2).setOrigin(0.5, 0.72),
      this.add.image(0, 0, 'carrier-right').setDepth(2).setOrigin(0.5, 0.72),
    ];
    this.planShips = null;
    this.missAt = null;
    this.landAt = null;
    this.catapultRig = this.add.graphics().setDepth(3);
    this.cloudSprites = [];

    this.plane = this.add.image(0, 0, 'plane').setDepth(8);
    this.plane.setOrigin(0.45, 0.78);
    this.plane.setAlpha(0);

    this.redrawBackdrop();
    const start = this.startPoint();
    this.smooth = { x: start.x, y: start.y, angle: -12 };
    this.track = { x: start.x, y: start.y };
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
    const checks = this.planShips?.length
      ? this.planShips
      : [
          { t: 0.28, shipLevel: 0.26 },
          { t: 0.50, shipLevel: 0.30 },
          { t: 0.72, shipLevel: 0.33 },
          { t: 0.97, shipLevel: 0.36 },
        ];
    const n = 1 + checks.length;
    const ww = Math.min(w * 0.5, (worldW * 0.78) / (n * 1.22));
    const x0 = w * 0.36;
    const x1 = worldW - w * 0.28;
    const launch = { x: x0, y: 0, ww };
    const fleet = [launch];
    for (const ship of checks) {
      const u = Phaser.Math.Clamp(Number(ship.t) / 0.97, 0.12, 1);
      fleet.push({
        x: lerp(x0, x1, u),
        y: 0,
        ww,
        t: Number(ship.t),
        shipLevel: Number(ship.shipLevel),
      });
    }
    return { w, h, worldW, horizon: 0, fleet, left: launch, ship: fleet[fleet.length - 1] };
  }

  // Keeps the plane sized against the deck it launches from.
  planeHeightFor(deckWidth) {
    return Math.max(26, Math.min(96, deckWidth * 0.2));
  }

  deckClearance() {
    const shipH = this.ships?.[0]?.displayHeight || 96;
    return Math.max(22, shipH * 0.3);
  }

  startPoint() {
    const { left } = this.layout();
    return { x: left.x - left.ww * 0.12, y: -this.deckClearance() };
  }

  landPoint() {
    const ship = this.landingShip();
    return { x: ship.x - ship.ww * 0.1, y: -this.deckClearance() };
  }

  fleetShipAt(at) {
    const { fleet } = this.layout();
    const last = fleet[fleet.length - 1];
    if (at == null) return last;
    let hit = fleet[1] || last;
    for (let i = 1; i < fleet.length; i += 1) {
      if (fleet[i].t != null && fleet[i].t <= at + 0.03) hit = fleet[i];
    }
    return hit;
  }

  // Open water beside the missed ship — never on a deck.
  missPoint() {
    const { fleet, left } = this.layout();
    const t = this.missAt;
    const matched = fleet.slice(1).find((slot) => slot.t != null && Math.abs(slot.t - Number(t)) < 0.04);
    if (!matched) {
      const px = this.plane?.x ?? 0;
      return { x: px + 28, y: 18 };
    }
    const ship = matched;
    const launchBow = left.x + left.ww * 0.48;
    const stern = ship.x - ship.ww * 0.5;
    const bow = ship.x + ship.ww * 0.5;
    const px = this.plane?.x ?? 0;
    if (px < stern - 8) {
      const x = Phaser.Math.Clamp(
        px + Math.max(56, (stern - px) * 0.4),
        launchBow + 56,
        stern - 32,
      );
      return { x, y: 18 };
    }
    return { x: bow + 44, y: 18 };
  }

  missedShip() {
    return this.fleetShipAt(this.missAt);
  }

  landingShip() {
    return this.fleetShipAt(this.landAt);
  }

  pathPoints() {
    const { h } = this.world();
    const start = this.startPoint();
    const { ship } = this.layout();
    const end = { x: ship.x - ship.ww * 0.1, y: -this.deckClearance() };
    const span = end.x - start.x;
    // Catapult throws the plane high off the deck; the course stays in the sky
    // and only sags toward the ships if energy falls.
    return [
      start,
      { x: start.x + span * 0.18, y: -h * 0.92 },
      { x: start.x + span * 0.48, y: -h * 0.78 },
      { x: end.x - 8, y: -h * 0.58 },
    ];
  }

  pathAt(t, glideOverride) {
    const [p0, p1, p2, p3] = this.pathPoints();
    const clamped = Phaser.Math.Clamp(t, 0, 1);
    const pos = bezier(p0, p1, p2, p3, clamped);
    const tan = bezierTangent(p0, p1, p2, p3, clamped);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len;
    const ny = tan.x / len;
    const { h } = this.world();
    const deckY = -this.deckClearance();
    const g = Number.isFinite(glideOverride) ? glideOverride : (this.glide ?? 1);
    const k = (g - DECK_ENERGY) / (1 - DECK_ENERGY);
    let y;
    if (k >= 1) y = pos.y - Math.min(k - 1, 2.4) * h * 0.16;
    else if (k <= 0) y = deckY + Math.min(-k, 1) * 28;
    else y = lerp(deckY, pos.y, k);
    const sag = Phaser.Math.Clamp(1 - Math.max(k, 0), 0, 1);
    return {
      x: pos.x,
      y,
      angle: this.pitchOf(tan.x, tan.y) + sag * 11,
      nx,
      ny,
      tan,
    };
  }

  // The original plane never stands on its tail: it stays almost level, with
  // a small nose-up on the climb and a small nose-down on the descent.
  pitchOf(dx, dy) {
    const deg = Phaser.Math.RadToDeg(Math.atan2(dy, Math.max(dx, 8)));
    return Phaser.Math.Clamp(deg * 0.7 + (this.angleBias || 0), -38, 12);
  }

  bounceOff(_x, _y, _strength = 36) {
    this.angleBias = -0.4;
  }

  sagOff(_strength = 70) {
    if (this.bumpVel) {
      this.bumpVel.x = 0;
      this.bumpVel.y = 0;
    }
    this.bounceLock = 220;
    this.energyLockUntil = this.time.now + 220;
    this.angleBias = 0.6;
    const from = this.targetGlide ?? this.glide ?? 1;
    this.targetGlide = Math.max(0.08, from * 0.46);
    this.glideEase = 560;
  }

  boostGlide(value) {
    const raw = String(value ?? '');
    const mul = /x|×/i.test(raw);
    const n = Number(raw.replace(/[^\d.]/g, '')) || 2;
    const add = mul ? 0.22 + n * 0.045 : 0.14 + n * 0.028;
    const from = this.targetGlide ?? this.glide ?? 1;
    this.targetGlide = Math.min(2.6, from + add);
    this.glideEase = 420;
    this.energyLockUntil = this.time.now + 220;
  }

  decayBump(delta) {
    if (!this.bumpVel) this.bumpVel = { x: 0, y: 0 };
    if (this.bounceLock > 0) this.bounceLock = Math.max(0, this.bounceLock - delta);
    const dt = delta / 1000;
    this.bump.x += this.bumpVel.x * dt;
    this.bump.y += this.bumpVel.y * dt;
    const drag = Math.exp(-delta / 240);
    this.bumpVel.x *= drag;
    this.bumpVel.y *= drag;
    const spring = Math.exp(-delta / 320);
    this.bump.x *= spring;
    this.bump.y *= spring;
    this.angleBias *= Math.exp(-delta / 280);
    if (Math.abs(this.bumpVel.x) < 2) this.bumpVel.x = 0;
    if (Math.abs(this.bumpVel.y) < 2) this.bumpVel.y = 0;
    if (Math.abs(this.bump.x) < 0.15) this.bump.x = 0;
    if (Math.abs(this.bump.y) < 0.15) this.bump.y = 0;
    if (Math.abs(this.angleBias) < 0.15) this.angleBias = 0;
    this.popY = (this.popY || 0) * Math.exp(-delta / 260);
    if (Math.abs(this.popY) < 0.25) this.popY = 0;
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
    return this.courseT(this.shownProgress ?? this.progress);
  }

  // Camera rides with the plane: no zoom, the world scrolls instead. It stops
  // descending once the waterline reaches its reference height, so a crash into
  // the sea stays in frame instead of dragging the horizon off screen.
  cameraTarget() {
    const { w, h, worldW } = this.world();
    const px = this.track?.x ?? this.smooth.x;
    const py = this.track?.y ?? this.smooth.y;
    const waiting = !this.launched || this.phase === 'waiting';
    const screenX = waiting ? 0.34 : PLANE_SCREEN_X;
    const anchorX = px - w * (screenX - 0.5);
    const anchorY = py - h * (PLANE_SCREEN_Y - 0.5);
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
      const kx = 1 - Math.exp(-delta / 110);
      const ky = 1 - Math.exp(-delta / 380);
      this.cam.x = lerp(this.cam.x, target.x, kx);
      this.cam.y = lerp(this.cam.y, target.y, ky);
      this.cam.zoom = 1;
    }
    cam.setZoom(1);
    cam.centerOn(this.cam.x, this.cam.y);
  }

  // Length of the stroke along the deck, from the shuttle to the bow.
  catapultRun() {
    const { left } = this.layout();
    return left.ww * 0.52;
  }

  catapultEnd() {
    const start = this.startPoint();
    return { x: start.x + this.catapultRun(), y: start.y - 10 };
  }

  drawCatapult() {
    const g = this.catapultRig;
    if (!g) return;
    g.clear();
    const { fleet } = this.layout();
    const deck = fleet[0];
    const s = Math.max(0.4, deck.ww / 340);
    const start = this.startPoint();
    const heave = this.shipHeave(deck.x, this.seaClock || 0);
    const railFrom = deck.x - deck.ww * 0.4;
    const railTo = deck.x + deck.ww * 0.34;

    g.fillStyle(0x1d2536, 1);
    g.fillRect(railFrom, heave - 4 * s, railTo - railFrom, 5 * s);
    g.fillStyle(0xffc933, 0.8);
    g.fillRect(railFrom + 4 * s, heave - 2 * s, railTo - railFrom - 8 * s, 1.6 * s);

    // Shuttle the plane is hooked to; it rides the rail during the shot.
    const shuttleX = start.x + this.catapultRun() * (this.shuttleSlide || 0);
    g.fillStyle(0xdfe6f2, 1);
    g.fillRect(shuttleX - 10 * s, heave - 9 * s, 20 * s, 6 * s);
    g.fillStyle(0x8fa2bd, 1);
    g.fillRect(shuttleX - 10 * s, heave - 4 * s, 20 * s, 2 * s);

    // Jet blast deflector raised behind the shuttle.
    const plateX = start.x - 22 * s;
    if (plateX > railFrom) {
      g.fillStyle(0x39445c, 1);
      g.beginPath();
      g.moveTo(plateX - 12 * s, heave);
      g.lineTo(plateX - 2 * s, heave - 18 * s);
      g.lineTo(plateX + 6 * s, heave - 17 * s);
      g.lineTo(plateX + 2 * s, heave);
      g.closePath();
      g.fillPath();
    }
  }

  catapultBlast(x, y) {
    const beat = Math.round(480 / this.speedFactor);
    for (let i = 0; i < 9; i += 1) {
      const steam = this.add
        .ellipse(x - i * 8, y + 10 + (i % 3) * 3, 14 + i, 8, i % 2 ? 0xdde6f4 : 0xffffff, 0.55)
        .setDepth(6);
      this.tweens.add({
        targets: steam,
        x: steam.x - 28 - i * 14,
        y: steam.y + 4,
        scaleX: 2.6 + i * 0.28,
        scaleY: 1.8 + i * 0.16,
        alpha: 0,
        duration: beat + i * 36,
        ease: 'Sine.out',
        onComplete: () => steam.destroy(),
      });
    }
  }

  redrawBackdrop() {
    const { w, h } = this.world();
    const { fleet } = this.layout();
    this.sea?.clear();
    this.sea?.setVisible(false);
    this.waves?.setVisible(false);
    this.sparkles?.setVisible(false);
    this.ocean?.resize();
    this.ships?.forEach((img, i) => {
      const slot = fleet[i];
      img.setVisible(Boolean(slot));
      if (!slot) return;
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

  // Only real pickups from the round sit on the course — after takeoff, never
  // over the launch deck. Dummy sky numbers are gone so every digit counts.
  scatterDecor() {
    this.decor?.forEach((d) => d.node.destroy());
    this.decor = [];
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
    const events = skyEvents(this.roundMods).filter((ev) => Number(ev.t) >= 0.16);
    const { h, worldW } = this.world();
    events.forEach((ev) => {
      const t = Phaser.Math.Clamp(Number(ev.t) || 0.2, 0.16, 0.9);
      const path = this.pathAt(this.courseT(t), 1);
      const tanLen = Math.hypot(path.tan.x, path.tan.y) || 1;
      const ox = Number.isFinite(Number(ev.ox)) ? Number(ev.ox) : (hashUnit(t * 97 + (ev.value || 1)) * 2 - 1);
      const oy = Number.isFinite(Number(ev.oy)) ? Number(ev.oy) : (hashUnit(t * 53 + 11) * 2 - 1);
      const spread = Math.hypot(ox, oy);
      const near = spread <= 0.32;
      const across = ox * h * (near ? 0.07 : 0.34);
      const along = oy * (near ? 22 : worldW * 0.04);
      const lift = oy * h * (near ? 0.045 : 0.2);
      const x = path.x + path.nx * across + (path.tan.x / tanLen) * along;
      const y = Phaser.Math.Clamp(
        path.y + path.ny * across + (path.tan.y / tanLen) * along + lift,
        -h * 0.92,
        -24,
      );
      if (ev.kind === 'rocket') this.addBomb(x, y, t, 0.5, t, ev.id);
      else if (ev.kind === 'mul') this.addMultiplier(x, y, `x${ev.value}`, t, ev.kind, ev.id, ev.value);
      else this.addMultiplier(x, y, String(ev.value), t, ev.kind, ev.id, ev.value);
    });
  }

  addBomb(x, y, t = 0, drop = 0.15, at = 1, id = null) {
    const img = this.add.image(0, 0, 'rocket').setDisplaySize(64, 64).setAngle(186);
    const node = this.add.container(x, y, [img]).setDepth(7);
    this.pickups.add(node);
    this.items.push({
      type: 'bomb',
      kind: 'rocket',
      id,
      drop,
      at,
      node,
      x,
      y,
      t,
      alive: true,
      bob: 4,
    });
  }

  addMultiplier(x, y, label, t = 0, kind = 'add', id = null, amount = null) {
    const node = this.numberLabel(x, y, label).setDepth(7);
    this.pickups.add(node);
    const value = Number(amount ?? String(label).replace(/[^\d.]/g, '')) || 1;
    this.items.push({ type: 'mult', kind, id, value, node, x, y, t, alive: true, bob: 4 });
  }

  collectNearby() {
    if (this.control === 'tween') return;
    if ((this.phase !== 'flying' && this.phase !== 'takeoff') || !this.plane) return;
    const pw = this.plane.displayWidth * 0.28;
    const ph = this.plane.displayHeight * 0.2;
    const hits = [];
    for (const item of this.items) {
      if (!item.alive || !item.node) continue;
      const iw = item.type === 'bomb' ? 16 : 12;
      const ih = item.type === 'bomb' ? 16 : 12;
      const dx = Math.abs(this.plane.x - item.node.x);
      const dy = Math.abs(this.plane.y - item.node.y);
      if (dx >= pw + iw || dy >= ph + ih) continue;
      hits.push({ item, d: dx * dx + dy * dy });
    }
    hits.sort((a, b) => a.d - b.d);
    const nearest = hits[0];
    if (!nearest) {
      this.glanceDecor(Math.max(22, this.plane.displayWidth * 0.22));
      return;
    }
    const item = nearest.item;
    item.alive = false;
    if (item.type === 'mult') {
      this.bounceOff(item.node.x, item.node.y, 12);
      this.boostGlide(item.value);
      this.collectFlash(item.node.x, item.node.y, `×${String(item.value).replace('x', '')}`);
      getAudio().collect();
      this.tweens.add({
        targets: item.node,
        scale: 1.4,
        alpha: 0,
        duration: 220,
        onComplete: () => item.node.destroy(),
      });
    } else {
      this.sagOff(86);
      this.explodeAt(item.node.x, item.node.y);
      this.popup(item.node.x, item.node.y, 'BANG!', '#ffe14a');
      getAudio().explode();
      this.tweens.add({
        targets: item.node,
        scale: 1.5,
        alpha: 0,
        duration: 200,
        onComplete: () => item.node.destroy(),
      });
    }
    this.onPickup?.({
      id: item.id,
      t: item.t,
      kind: item.kind,
      value: item.value,
    });
  }

  glanceDecor(reach) {
    if (!this.decor?.length) return;
    for (const d of this.decor) {
      if (d.hit || !d.node) continue;
      const dxy = Phaser.Math.Distance.Between(this.plane.x, this.plane.y, d.node.x, d.node.y);
      if (dxy > reach + (d.kind === 'rocket' ? 12 : 0)) continue;
      d.hit = true;
      this.tweens.add({
        targets: d.node,
        alpha: 0.15,
        duration: 180,
      });
      return;
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
    this.cloudSprites?.forEach((cloud) => cloud.setVisible(false));
  }

  drawClouds(_now) {}

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
    this.ocean?.update(delta);
    const now = _time / 1000;
    this.tick += 1;
    this.seaClock = now;
    this.drawWaves(now);
    this.bobShips(now);
    if ((this.tick & 1) === 1) this.drawSparkles(now);

    this.pushTrail(delta);
    if ((this.tick & 1) === 0) this.drawTrail();
    this.drawClouds(now);
    this.driftDecor(delta);
    this.bobPickups(now);
    this.maybeCollectRing();
    this.decayBump(delta);
    if (this.control !== 'tween') {
      if (this.launched && (this.phase === 'flying' || this.phase === 'takeoff')) {
        const span = Math.max(1200, this.flightMs);
        const dP = delta / span;
        const decay = Math.exp(-1.05 * dP);
        if (this.targetGlide != null) {
          this.targetGlide = Math.max(0.08, this.targetGlide * decay);
          const tau = Math.max(180, this.glideEase || 320);
          this.glide += (this.targetGlide - this.glide) * (1 - Math.exp(-delta / tau));
        } else {
          this.glide = Math.max(0.08, (this.glide || 1) * decay);
        }
        this.glide = Phaser.Math.Clamp(this.glide, 0.08, 2.6);
        this.shownProgress = Phaser.Math.Clamp((this.shownProgress || 0) + dP, 0, 0.97);
        const err = (this.progress || 0) - this.shownProgress;
        // Never rewind after the catapult: server progress lags the visual shot
        // and pulling shownProgress back makes the plane slide backward.
        if (err > 0.04) {
          this.shownProgress += err * (1 - Math.exp(-delta / 1800));
        }
        getAudio().setRpm(Math.max(0.4, (this.glide || 1) * (this.speedFactor || 1)));
      } else if (!this.launched || this.phase === 'waiting') {
        this.shownProgress = this.progress;
        this.glide = 1;
        this.targetGlide = 1;
        this.glideEase = 320;
      }
    }

    if (this.control === 'auto' && this.plane) {
      if (!this.launched || this.phase === 'waiting') {
        const start = this.startPoint();
        this.track.x = start.x;
        this.track.y = start.y;
        this.smooth.x = start.x;
        this.smooth.y = start.y;
        this.smooth.angle = -8;
      } else if (this.phase === 'takeoff') {
        const point = this.pathAt(this.flightT());
        this.track.x = point.x;
        this.track.y = point.y;
        this.smooth.x = point.x;
        this.smooth.y = lerp(this.smooth.y, point.y + (this.popY || 0), 1 - Math.exp(-delta / 160));
        this.smooth.angle = lerp(this.smooth.angle, point.angle, 1 - Math.exp(-delta / 220));
        this.collectNearby();
      } else if (this.phase === 'flying') {
        this.visualM = this.displayM;
        this.visualCourse = lerp(
          this.visualCourse,
          this.courseM,
          1 - Math.pow(0.08, delta / 16.67),
        );
        const point = this.pathAt(this.flightT());
        this.track.x = point.x;
        this.track.y = point.y;
        this.smooth.x = point.x;
        this.smooth.y = lerp(this.smooth.y, point.y + (this.popY || 0), 1 - Math.exp(-delta / 160));
        this.smooth.angle = lerp(this.smooth.angle, point.angle, 1 - Math.exp(-delta / 220));
        this.collectNearby();
      } else if (this.phase === 'landing') {
        this.stepLanding(delta, now);
      } else if (this.phase === 'landed') {
        const land = this.landPoint();
        this.track.x = land.x;
        this.track.y = land.y;
        this.smooth.x = land.x;
        this.smooth.y = land.y;
        this.smooth.angle = -16;
      }
      this.placeFromSmooth();
    }

    this.updateCamera(delta);
  }

  seaSwell(x, now) {
    const s = this.world().h / 720;
    return (
      Math.sin(x * 0.0036 + now * 0.92) * 6.4 * s +
      Math.sin(x * 0.0068 + now * 1.18 + 1.2) * 2.6 * s
    );
  }

  seaChop(x, now) {
    const s = this.world().h / 720;
    return (
      Math.sin(x * 0.019 + now * 1.55) * 1.5 * s +
      Math.sin(x * 0.041 + now * 2.2 + 0.8) * 0.65 * s
    );
  }

  seaSurface(x, now) {
    return this.seaSwell(x, now) + this.seaChop(x, now);
  }

  shipHeave(x, now) {
    return this.seaSwell(x, now);
  }

  shipPitch(x, half, now) {
    const dy = this.seaSwell(x + half, now) - this.seaSwell(x - half, now);
    return Phaser.Math.Clamp(Phaser.Math.RadToDeg(Math.atan2(dy, Math.max(24, half * 2))) * 0.85, -1.5, 1.5);
  }

  bobShips(now) {
    const { fleet } = this.layout();
    this.ships?.forEach((img, i) => {
      const slot = fleet[i];
      if (!slot) return;
      img.setPosition(slot.x, slot.y + this.shipHeave(slot.x, now));
      img.setAngle(this.shipPitch(slot.x, slot.ww * 0.38, now));
    });
    if (this.phase === 'waiting' || this.phase === 'takeoff') this.drawCatapult();
  }

  drawWaves(_now) {
    this.waves?.clear();
  }

  // Glints on the water, drawn only across the stretch the camera can see.
  drawSparkles(_now) {
    this.sparkles?.clear();
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
    this.planShips = Array.isArray(mod?.ships) && mod.ships.length ? mod.ships : this.planShips;
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
      const path = this.pathAt(t, 1);
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
    getAudio().collect();
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
      this.shuttleSlide = 0;
      this.bump = { x: 0, y: 0 };
      this.bumpVel = { x: 0, y: 0 };
      this.glide = 1;
      this.targetGlide = 1;
      this.glideEase = 320;
      this.angleBias = 0;
      this.launchT = 0;
      this.bounceLock = 0;
      this.shownProgress = 0;
      this.launchedAt = 0;
      this.missAt = null;
      this.landAt = null;
      this.landSettle = null;
      this.onDeck = false;
      this.clearRoundFx();
      this.clearPickups();
      this.clearTrail();
      this.stopMotion();
      const start = this.startPoint();
      this.smooth.x = start.x;
      this.smooth.y = start.y;
      this.track.x = start.x;
      this.track.y = start.y;
      this.updateCamera(0, true);
      this.drawCatapult();
      getAudio().stopEngine();
      getAudio().setBed('wait');
      if (prev !== 'waiting') this.appearPlane();
      else this.plane?.setAlpha(1);
    }
  }

  stopMotion() {
    this.tweens.killTweensOf(this.plane);
    if (this.moveDummy) this.tweens.killTweensOf(this.moveDummy);
    this.tweens.killTweensOf(this);
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
    this.shuttleSlide = 0;
    this.bump = { x: 0, y: 0 };
    this.bumpVel = { x: 0, y: 0 };
    this.glide = 1;
    this.targetGlide = 1;
    this.glideEase = 320;
    this.angleBias = 0;
    this.popY = 0;
    this.missAt = null;
    this.landAt = null;
    this.plane.setAlpha(1);
    this.plane.setScale(this.baseScale);
    const start = this.startPoint();
    this.plane.setPosition(start.x, start.y);
    this.plane.setAngle(-2);
    if (skyEvents(this.roundMods).length) this.spawnAlongCourse();

    const sync = () => {
      this.smooth.x = this.plane.x;
      this.smooth.y = this.plane.y;
      this.smooth.angle = this.plane.angle;
      this.track.x = this.plane.x;
      this.track.y = this.plane.y;
      this.syncLabel();
    };

    const from = { x: start.x, y: start.y };
    this.moveDummy = { t: 0 };
    this.flightMs = Math.max(1500, 18000 / Math.max(0.5, this.speedFactor * 2));
    const { w, h } = this.world();
    let launchT = 0.16;
    let target = this.pathAt(this.courseT(launchT), 1);
    while (
      launchT < 0.4 &&
      (target.x < from.x + w * 0.22 || target.y > from.y - h * 0.52)
    ) {
      launchT += 0.02;
      target = this.pathAt(this.courseT(launchT), 1);
    }
    this.launchT = launchT;
    this.shownProgress = 0;
    this.launchedAt = this.time.now;
    const mid = {
      x: from.x + (target.x - from.x) * 0.42,
      y: from.y + (target.y - from.y) * 0.68,
    };

    this.catapultBlast(start.x, start.y);
    const audio = getAudio();
    audio.unlock();
    audio.catapult();
    audio.setRpm(this.speedFactor);
    audio.startEngine();
    audio.setBed('fly');
    this.tweens.add({
      targets: this.moveDummy,
      t: 1,
      duration: 380,
      ease: 'Linear',
      onUpdate: () => {
        const t = easeCatapult(this.moveDummy.t);
        const u = 1 - t;
        this.plane.x = u * u * from.x + 2 * u * t * mid.x + t * t * target.x;
        this.plane.y = u * u * from.y + 2 * u * t * mid.y + t * t * target.y;
        const dx = 2 * u * (mid.x - from.x) + 2 * t * (target.x - mid.x);
        const dy = 2 * u * (mid.y - from.y) + 2 * t * (target.y - mid.y);
        this.plane.angle = lerp(this.plane.angle, this.pitchOf(Math.max(dx, 12), dy), 0.28);
        this.shuttleSlide = t;
        this.shownProgress = this.launchT * t;
        this.drawCatapult();
        sync();
      },
      onComplete: () => {
        this.shuttleSlide = 1;
        this.shownProgress = this.launchT;
        this.launchedAt = this.time.now - this.launchT * this.flightMs;
        this.plane.setPosition(target.x, target.y);
        this.smooth.x = target.x;
        this.smooth.y = target.y;
        this.track.x = target.x;
        this.track.y = target.y;
        this.drawCatapult();
        this.tweens.add({
          targets: this,
          shuttleSlide: 0,
          duration: 160,
          ease: 'Quad.in',
          onUpdate: () => this.drawCatapult(),
        });
        sync();
        this.phase = 'flying';
        this.control = 'auto';
        this.onAirborne?.(this.launchT);
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
    this.shuttleSlide = 0;
    this.launchT = 0;
    this.launchedAt = 0;
    this.drawCatapult();
    this.plane?.setAlpha(1);
    this.plane?.setScale(this.baseScale);
    getAudio().stopEngine();
    getAudio().setBed('wait');
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

  setEnergy(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return;
    const next = Phaser.Math.Clamp(n, 0.08, 2.6);
    const local = this.targetGlide ?? this.glide ?? 1;
    if ((this.energyLockUntil || 0) > this.time.now) {
      if (Math.abs(next - local) > 0.04) return;
    }
    if (Math.abs(next - local) > 0.2) {
      this.targetGlide = local + (next - local) * 0.4;
      return;
    }
    this.targetGlide = next;
  }

  land(onSettled, landAt) {
    if (landAt != null) this.landAt = Number(landAt);
    if (!this.plane || this.phase === 'landed' || this.phase === 'landing') {
      onSettled?.();
      return;
    }
    this.phase = 'landing';
    this.control = 'auto';
    this.stopMotion();
    this.landSettle = onSettled;
    this.onDeck = false;
    this.landHits = 0;
    this.items.forEach((item) => {
      if (!item.alive) return;
      item.alive = false;
      this.tweens.add({
        targets: item.node,
        alpha: 0,
        duration: 220,
        onComplete: () => item.node.destroy(),
      });
    });
    const land = this.landPoint();
    const dx = land.x - this.plane.x;
    const dy = land.y - this.plane.y;
    this.landVel = {
      x: Phaser.Math.Clamp(dx * 1.15 + 90, 120, 360),
      y: Phaser.Math.Clamp(dy * 0.85 + 55, 50, 320),
    };
    getAudio().setRpm(0.45);
    this.time.delayedCall(3200, () => {
      if (this.phase === 'landing') this.finishLanding();
    });
  }

  stepLanding(delta, now) {
    if (!this.plane || !this.landVel) return;
    const dt = Math.min(0.045, delta / 1000);
    const { h } = this.world();
    const ship = this.landingShip();
    const land = this.landPoint();
    const heave = this.shipHeave(ship.x, now);
    const deckY = land.y + heave;
    const gravity = h * 1.35;
    const minX = ship.x - ship.ww * 0.4;
    const maxX = ship.x + ship.ww * 0.26;

    this.landVel.y += gravity * dt;
    this.plane.x += this.landVel.x * dt;
    this.plane.y += this.landVel.y * dt;
    this.plane.x = Phaser.Math.Clamp(this.plane.x, minX, maxX);

    if (this.plane.y >= deckY) {
      const impact = Math.max(0, this.landVel.y);
      this.plane.y = deckY;
      if (!this.onDeck) {
        this.onDeck = true;
        getAudio().land();
        getAudio().stopEngine();
      }
      if (impact > 36) {
        this.landHits += 1;
        this.landVel.y = -impact * (this.landHits === 1 ? 0.32 : 0.16);
        this.landVel.x *= 0.7;
        this.plane.angle += 4;
        this.deckHitFx(this.plane.x, deckY, this.landHits === 1 ? 1 : 0.45);
      } else {
        this.landVel.y = 0;
      }
      this.landVel.x *= Math.exp(-dt / 0.26);
    }

    if (this.plane.x >= maxX - 1) this.landVel.x *= 0.35;

    const pitch = this.shipPitch(ship.x, ship.ww * 0.38, now);
    const flying = this.plane.y < deckY - 3;
    const want = flying
      ? Phaser.Math.Clamp(this.landVel.y * 0.035 - 2, -16, 14)
      : -12 + pitch * 0.4;
    this.plane.angle = lerp(this.plane.angle, want, 1 - Math.exp(-delta / 150));

    this.smooth.x = this.plane.x;
    this.smooth.y = this.plane.y;
    this.smooth.angle = this.plane.angle;
    this.track.x = this.plane.x;
    this.track.y = this.plane.y;
    this.syncLabel();

    const still = Math.abs(this.landVel.x) < 14 && Math.abs(this.landVel.y) < 10;
    if (this.onDeck && still && this.plane.y >= deckY - 2) this.finishLanding();
  }

  finishLanding() {
    if (this.phase !== 'landing') return;
    this.phase = 'landed';
    this.launched = false;
    this.onDeck = true;
    this.landVel = { x: 0, y: 0 };
    getAudio().win();
    getAudio().stopEngine();
    getAudio().setBed('wait');
    const done = this.landSettle;
    this.landSettle = null;
    done?.();
  }

  deckHitFx(x, y, power = 1) {
    const n = Math.round(5 * power);
    for (let i = 0; i < n; i += 1) {
      const puff = this.add
        .ellipse(x - 8 - i * 7, y + 2, 10 + i * 2, 5, i % 2 ? 0xdde6f4 : 0xffffff, 0.5 * power)
        .setDepth(7);
      this.tweens.add({
        targets: puff,
        x: puff.x - 18 - i * 6,
        y: puff.y - 4,
        scaleX: 2.2,
        scaleY: 1.6,
        alpha: 0,
        duration: 280 + i * 40,
        ease: 'Sine.out',
        onComplete: () => puff.destroy(),
      });
    }
    const skid = this.add.rectangle(x - 16, y + 1, 28 * power, 2, 0xffffff, 0.35).setDepth(6);
    this.tweens.add({
      targets: skid,
      scaleX: 2.4,
      alpha: 0,
      duration: 420,
      onComplete: () => skid.destroy(),
    });
  }

  crash(point, onSettled, missAt) {
    if (missAt != null) this.missAt = Number(missAt);
    if (!this.launched || this.phase === 'landing' || this.phase === 'landed' || this.phase === 'crashed') {
      onSettled?.();
      return;
    }
    this.displayM = Number(point) || this.displayM;
    this.visualM = this.displayM;
    this.phase = 'crashed';
    this.control = 'tween';
    this.clearTrail();
    this.stopMotion();
    getAudio().stopEngine();
    const from = { x: this.plane.x, y: this.plane.y, angle: this.plane.angle };
    const splash = this.missPoint();
    const fall = Math.max(80, splash.y - from.y);
    this.moveDummy = { t: 0 };
    this.tweens.add({
      targets: this.moveDummy,
      t: 1,
      duration: Phaser.Math.Clamp(Math.round(fall * 0.85), 520, 1400),
      ease: 'Quad.in',
      onUpdate: () => {
        const t = this.moveDummy.t;
        const mid = {
          x: from.x + (splash.x - from.x) * 0.62,
          y: lerp(from.y, splash.y, 0.28),
        };
        const u = 1 - t;
        this.plane.x = u * u * from.x + 2 * u * t * mid.x + t * t * splash.x;
        this.plane.y = u * u * from.y + 2 * u * t * mid.y + t * t * splash.y;
        this.plane.angle = lerp(from.angle, 26, t);
        this.smooth.x = this.plane.x;
        this.smooth.y = this.plane.y;
        this.smooth.angle = this.plane.angle;
        this.track.x = this.plane.x;
        this.track.y = this.plane.y;
        this.syncLabel(24);
      },
      onComplete: () => {
        this.launched = false;
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
        getAudio().splash();
        getAudio().lose();
        getAudio().setBed('wait');
        onSettled?.();
      },
    });
  }
}
