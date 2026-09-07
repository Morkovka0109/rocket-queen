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

const FLEET_MAX = 5;
const FLEET_MIN = 4;
const CLOUD_COUNT = 28;

function waveFor(events) {
  if (!events.length) return { ratio: 0.6, freq: Math.PI * 3.2 };
  let seed = 0;
  for (const ev of events) seed += Math.round(ev.t * 1000) + (Number(ev.value) || 0) * 7;
  return {
    ratio: 0.5 + (seed % 51) / 100,
    freq: Math.PI * (2.2 + (Math.floor(seed / 4) % 25) / 10),
  };
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
    this.carriers = this.add.graphics().setDepth(2);
    this.pickups = this.add.container(0, 0).setDepth(7);
    this.trail = this.add.graphics().setDepth(5);
    this.fxLayer = this.add.graphics().setDepth(5);
    this.cloudLayer = this.add.graphics().setDepth(1);
    this.dots = Array.from({ length: 18 }, () => ({
      x: Math.random(),
      y: Math.random(),
      r: Math.random() * 1.6 + 0.4,
      s: Math.random() * 2 + 0.4,
    }));
    this.items = [];
    this.chromaCrop('plane-raw', 'plane');
    this.chromaCrop('carrier-left-raw', 'carrier-left');
    this.chromaCrop('carrier-right-raw', 'carrier-right');
    this.chromaCrop('rocket-raw', 'rocket');
    this.chromaCrop('cloud-raw', 'cloud');

    this.mark = this.add
      .text(0, 0, 'A', {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '92px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setAlpha(0.08)
      .setDepth(1);

    this.ships = Array.from({ length: FLEET_MAX }, (_, i) =>
      this.add
        .image(0, 0, i % 2 === 0 ? 'carrier-left' : 'carrier-right')
        .setDepth(2)
        .setOrigin(0.5, 0.72),
    );
    this.catapultRig = this.add.graphics().setDepth(3);
    this.courseGuide = this.add.graphics().setDepth(4);
    // The reference sky is filled with many small, muted clouds rather than a
    // few large white ones.
    this.cloudSprites = Array.from({ length: CLOUD_COUNT }, () =>
      this.add.image(0, 0, 'cloud').setDepth(1).setAlpha(0.5).setTint(0x9fb0d4),
    );
    this.cloudSeeds = Array.from({ length: CLOUD_COUNT }, (_, i) => ({
      x: (i * 0.618) % 1,
      y: ((i * 0.383) % 1) * 0.86,
      size: 0.55 + ((i * 7) % 10) / 14,
      drift: 6 + ((i * 3) % 7) * 2.2,
    }));

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

  // Narrow phones cannot fit five readable decks, so the fleet shrinks to the
  // minimum instead of turning every carrier into an unrecognisable sliver.
  fleetSize() {
    return this.size().w < 620 ? FLEET_MIN : FLEET_MAX;
  }

  layout() {
    const { w, h } = this.size();
    const horizon = h * 0.632;
    const n = this.fleetSize();
    const margin = w * 0.02;
    // Widest deck that still leaves clear water between neighbours while keeping
    // the outer carriers fully on screen: ww <= 0.86 * gap.
    const ww = (0.86 * (w - margin * 2)) / (n - 0.14);
    const first = ww * 0.5 + margin;
    const gap = (w - ww - margin * 2) / (n - 1);
    const fleet = Array.from({ length: n }, (_, i) => ({
      x: first + gap * i,
      y: horizon + 2,
      ww,
      hh: Math.max(52, ww * 0.36),
    }));
    return {
      w,
      h,
      horizon,
      fleet,
      left: fleet[0],
      ship: fleet[n - 1],
    };
  }

  // Keeps the plane sized against the deck it launches from, so the fleet and
  // the plane stay in proportion on every screen width.
  planeHeightFor(deckWidth) {
    return Math.max(24, Math.min(84, deckWidth * 0.22));
  }

  deckClearance() {
    return Math.max(12, (this.plane?.displayHeight || 40) * 0.4);
  }

  startPoint() {
    const { left, horizon } = this.layout();
    const halfW = (this.plane?.displayWidth || 60) * 0.55;
    return { x: Math.max(halfW, left.x - left.ww * 0.16), y: horizon - this.deckClearance() };
  }

  // Opening frame: the launch deck with its catapult, the plane, the first
  // stretch of the course and the next carrier ahead.
  startFraming() {
    const { w, h, fleet } = this.layout();
    const ahead = fleet[1] ?? fleet[0];
    const rightEdge = ahead.x + ahead.ww * 0.5 + w * 0.03;
    return {
      zoom: Phaser.Math.Clamp(w / rightEdge, 1, 2.6),
      x: rightEdge * 0.5,
      y: h * 0.46,
    };
  }

  // Pulls back to the full seascape while tracking the plane, so each carrier
  // ahead slides into frame as the flight goes on.
  cameraTarget() {
    const { w, h } = this.layout();
    const open = this.startFraming();
    if (!this.launched || this.phase === 'waiting') return open;
    const k = Phaser.Math.Easing.Sine.InOut(Phaser.Math.Clamp(this.progress / 0.55, 0, 1));
    return {
      zoom: lerp(open.zoom, 1, k),
      x: lerp(this.smooth.x, w / 2, k),
      y: lerp(this.smooth.y, h / 2, k),
    };
  }

  updateCamera(delta, snap = false) {
    const cam = this.cameras.main;
    const target = this.cameraTarget();
    if (snap || !this.cam) {
      this.cam = { ...target };
    } else {
      const k = 1 - Math.pow(0.004, delta / 1000);
      this.cam.x = lerp(this.cam.x, target.x, k);
      this.cam.y = lerp(this.cam.y, target.y, k);
      this.cam.zoom = lerp(this.cam.zoom, target.zoom, k);
    }
    cam.setZoom(this.cam.zoom);
    cam.centerOn(this.cam.x, this.cam.y);
  }

  catapultEnd() {
    const { w, horizon } = this.layout();
    const start = this.startPoint();
    return { x: start.x + Math.min(96, w * 0.07), y: horizon - 30 };
  }

  drawCatapult() {
    const g = this.catapultRig;
    if (!g) return;
    g.clear();
    const { horizon, fleet } = this.layout();
    const deck = fleet[0];
    const s = Math.max(0.4, deck.ww / 340);
    const start = this.startPoint();
    const railFrom = Math.max(2, deck.x - deck.ww * 0.4);
    const railTo = deck.x + deck.ww * 0.34;

    g.fillStyle(0x1d2536, 1);
    g.fillRect(railFrom, horizon - 4 * s, railTo - railFrom, 5 * s);
    g.fillStyle(0xffc933, 0.8);
    g.fillRect(railFrom + 4 * s, horizon - 2 * s, railTo - railFrom - 8 * s, 1.6 * s);

    // Shuttle the plane is hooked to, sitting under its wheels.
    g.fillStyle(0xdfe6f2, 1);
    g.fillRect(start.x - 10 * s, horizon - 9 * s, 20 * s, 6 * s);
    g.fillStyle(0x8fa2bd, 1);
    g.fillRect(start.x - 10 * s, horizon - 4 * s, 20 * s, 2 * s);

    // Jet blast deflector raised behind the shuttle.
    const plateX = start.x - 22 * s;
    if (plateX > railFrom) {
      g.fillStyle(0x39445c, 1);
      g.beginPath();
      g.moveTo(plateX - 12 * s, horizon);
      g.lineTo(plateX - 2 * s, horizon - 18 * s);
      g.lineTo(plateX + 6 * s, horizon - 17 * s);
      g.lineTo(plateX + 2 * s, horizon);
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

  landPoint() {
    const { ship, horizon } = this.layout();
    return { x: ship.x - ship.ww * 0.1, y: horizon - this.deckClearance() };
  }

  pathPoints() {
    const { h } = this.layout();
    const start = this.startPoint();
    const land = this.landPoint();
    const span = land.x - start.x;
    return [
      start,
      { x: start.x + span * 0.28, y: h * 0.26 },
      { x: start.x + span * 0.64, y: h * 0.1 },
      { x: land.x - 6, y: h * 0.17 },
    ];
  }

  planeCeiling() {
    const { h } = this.size();
    return h * 0.035 + (this.plane?.displayHeight || 56) * 0.6;
  }

  waveHeadroom() {
    const [p0, p1, p2, p3] = this.pathPoints();
    let apex = Infinity;
    for (let i = 0; i <= 24; i += 1) {
      const y = bezier(p0, p1, p2, p3, i / 24).y;
      if (y < apex) apex = y;
    }
    return Math.max(0, apex - this.planeCeiling());
  }

  pathAt(t) {
    const [p0, p1, p2, p3] = this.pathPoints();
    const clamped = Phaser.Math.Clamp(t, 0, 1);
    const pos = bezier(p0, p1, p2, p3, clamped);
    const wv = this.roundWave;
    const amp = (this.waveCap ?? 30) * wv.ratio;
    const wave = Math.sin(clamped * wv.freq) * amp * Math.sin(Math.PI * clamped);
    const tan = bezierTangent(p0, p1, p2, p3, clamped);
    const len = Math.hypot(tan.x, tan.y) || 1;
    const nx = -tan.y / len;
    const ny = tan.x / len;
    return {
      x: pos.x + nx * wave,
      y: Math.max(this.planeCeiling(), pos.y + ny * wave),
      angle: Phaser.Math.RadToDeg(Math.atan2(tan.y, tan.x)) * 0.62,
      nx,
      ny,
      tan,
    };
  }

  courseT(progress) {
    return Phaser.Math.Clamp(progress * 0.97, 0, 0.97);
  }

  flightT() {
    return this.courseT(this.progress);
  }

  redrawBackdrop() {
    const { w, h, horizon, fleet } = this.layout();
    // Palette sampled from the reference game: the sky brightens towards the
    // horizon and the sea is a flat, darker blue.
    this.sky.clear();
    this.sky.fillGradientStyle(0x213576, 0x213576, 0x34488f, 0x34488f, 1);
    this.sky.fillRect(0, 0, w, horizon);
    this.sea.clear();
    this.sea.fillStyle(0x0d1c71, 1);
    this.sea.fillRect(0, horizon, w, h - horizon);
    this.sea.lineStyle(1, 0xffffff, 0.28);
    this.sea.lineBetween(0, horizon, w, horizon);
    this.carriers.clear();
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
    this.cameras.main.setBounds(0, 0, w, h);
    this.waveCap = this.waveHeadroom();
    this.mark?.setPosition(w / 2, h * 0.18);
    this.mark?.setFontSize(Math.round(Math.min(110, w * 0.22)));
  }

  clearPickups() {
    this.items.forEach((item) => item.node.destroy());
    this.items = [];
    this.pickups.removeAll(true);
    this.nextSpawnT = 0.08;
    this.spawnIndex = 0;
    this.skySpawned = false;
  }

  spawnAlongCourse() {
    this.items.forEach((item) => item.node.destroy());
    this.items = [];
    this.pickups.removeAll(true);
    this.skySpawned = true;
    const events = skyEvents(this.roundMods);
    const { h, horizon } = this.layout();
    events.forEach((ev, i) => {
      const t = Phaser.Math.Clamp(Number(ev.t) || 0.2, 0.06, 0.95);
      const path = this.pathAt(this.courseT(t));
      const side = i % 2 === 0 ? -1 : 1;
      const offset = (ev.kind === 'rocket' ? 16 : 9) + (i % 3) * 7;
      const reach = ev.kind === 'rocket' ? 38 : 22;
      const x = path.x + path.nx * offset * side;
      const y = Phaser.Math.Clamp(
        path.y + path.ny * offset * side,
        h * 0.03 + reach,
        horizon - 24,
      );
      if (ev.kind === 'rocket') this.addBomb(x, y, t, 0.5, t);
      else if (ev.kind === 'mul') this.addMultiplier(x, y, `x${ev.value}`, t);
      else this.addMultiplier(x, y, String(ev.value), t);
    });
  }

  addBomb(x, y, t = 0, drop = 0.15, at = 1) {
    const img = this.add.image(0, 0, 'rocket').setDisplaySize(72, 72).setAngle(-28);
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
    // The reference game shows plain white numerals with a soft drop shadow.
    const label = this.add
      .text(0, 0, String(value).replace('.', ','), {
        fontFamily: 'Manrope, Arial, sans-serif',
        fontSize: '44px',
        color: '#ffffff',
        fontStyle: 'bold',
      })
      .setOrigin(0.5)
      .setShadow(0, 3, 'rgba(7,20,51,0.75)', 6, false, true);
    const node = this.add.container(x, y, [label]).setDepth(7);
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
        this.popup(item.node.x, item.node.y, String(item.value));
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

  // Dotted preview of the course just ahead of the plane, so the opening frame
  // already shows where the flight is heading.
  drawCourseGuide() {
    const g = this.courseGuide;
    if (!g) return;
    g.clear();
    if (this.phase === 'crashed' || this.phase === 'landed') return;
    const from = this.launched ? this.flightT() : 0;
    const steps = 24;
    for (let i = 1; i <= steps; i += 1) {
      const t = from + (i / steps) * 0.4;
      if (t > 0.97) break;
      const p = this.pathAt(t);
      g.fillStyle(0xbfe0ff, 0.32 * (1 - i / steps));
      g.fillCircle(p.x, p.y, 2.4);
    }
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
    if (this.trailAcc < 40) return;
    this.trailAcc = 0;
    this.trailPts.push({ x: this.plane.x - 18, y: this.plane.y + 6 });
    if (this.trailPts.length > 14) this.trailPts.shift();
  }

  drawTrail() {
    if (!this.trail) return;
    this.trail.clear();
    if (this.activeEvent === 'clouds') return;
    if (this.trailPts.length < 2) return;
    const n = this.trailPts.length;
    const boost = this.activeEvent === 'boost';
    this.trail.lineStyle(boost ? 5 : 3, boost ? 0xff7a2a : 0xffe27a, boost ? 0.55 : 0.35);
    this.trail.beginPath();
    this.trail.moveTo(this.trailPts[0].x, this.trailPts[0].y);
    for (let i = 1; i < n; i += 1) {
      this.trail.lineTo(this.trailPts[i].x, this.trailPts[i].y);
    }
    this.trail.strokePath();
    for (let i = 0; i < n; i += 2) {
      const p = this.trailPts[i];
      this.trail.fillStyle(0xffffff, 0.08 + (i / n) * 0.22);
      this.trail.fillCircle(p.x, p.y, 2 + (i / n) * 3);
    }
  }

  drawClouds(now) {
    if (!this.cloudSprites?.length) return;
    const { w, horizon } = this.layout();
    this.cloudSprites.forEach((cloud, i) => {
      const seed = this.cloudSeeds[i];
      const width = Math.max(34, w * 0.052 * seed.size);
      cloud.setDisplaySize(width, width * 0.42);
      const span = w + width * 2;
      cloud.setPosition(
        ((seed.x * span + now * seed.drift) % span) - width,
        horizon * (0.05 + seed.y * 0.82),
      );
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
    const { w, h, horizon } = this.layout();
    const now = _time / 1000;
    this.tick += 1;
    if ((this.tick & 1) === 1) {
      this.sparkles.clear();
      for (const d of this.dots) {
        const x = (d.x * w + now * d.s * 12) % w;
        const y = horizon + 8 + d.y * (h - horizon - 16);
        this.sparkles.fillStyle(0xffffff, 0.25 + Math.abs(Math.sin(now * d.s)) * 0.45);
        this.sparkles.fillCircle(x, y, d.r);
      }
    }

    this.pushTrail(delta);
    if ((this.tick & 1) === 0) this.drawTrail();
    if ((this.tick & 3) === 0) this.drawCourseGuide();
    this.drawClouds(now);
    this.bobPickups(now);
    this.maybeCollectRing();
    this.updateCamera(delta);

    if (this.control !== 'auto' || !this.plane) return;

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
    this.waveCap = this.waveHeadroom();
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
    const { horizon } = this.layout();
    const splash = { x: this.plane.x + 36, y: horizon + 18 };
    this.stopMotion();
    this.tweens.add({
      targets: this.plane,
      x: splash.x,
      y: splash.y,
      angle: 28,
      duration: 420,
      ease: 'Quad.in',
      onUpdate: () => {
        this.smooth.x = this.plane.x;
        this.smooth.y = this.plane.y;
        this.smooth.angle = this.plane.angle;
        this.syncLabel(24);
      },
      onComplete: () => {
        this.popup(splash.x, horizon - 10, 'В воду!', '#ff8b8b');
        this.tweens.add({
          targets: this.plane,
          alpha: 0,
          y: splash.y + 40,
          duration: 380,
        });
        const ring = this.add.ellipse(splash.x, horizon + 4, 10, 4, 0xffffff, 0.5).setDepth(7);
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
