const crypto = require("node:crypto");

const ADDS = [1, 1, 2, 2, 5, 5, 10];
const MULS = [2, 2, 3, 4, 5];
const MAX_MULT = 250;

function rand() {
  return crypto.randomInt(0, 2 ** 32) / 2 ** 32;
}

function toHundredths(multiplier) {
  return Math.floor(Number(multiplier) * 100);
}

function payoutFor(amount, hundredths) {
  return Math.floor((Number(amount) * hundredths) / 100);
}

const ENERGY_DECAY = 1.05;
const ENERGY_STALL = 0.36;
const ENERGY_BOMB = 0.46;
const ENERGY_MIN = 0.08;
const ENERGY_MAX = 2.6;
/** Below this the plane is in the sea, not on a deck. */
const WATER_ENERGY = 0.12;

function courseShips() {
  return [
    { t: 0.28, shipLevel: 0.26 },
    { t: 0.5, shipLevel: 0.3 },
    { t: 0.72, shipLevel: 0.33 },
    { t: 0.97, shipLevel: 0.36 },
  ];
}

const CORRIDOR = 0.32;

function isCorridor(ev) {
  return Math.hypot(Number(ev?.ox) || 0, Number(ev?.oy) || 0) <= CORRIDOR;
}

function applyEnergyEvent(energy, ev) {
  let next = Number(energy) || 1;
  if (!ev) return next;
  if (ev.kind === "rocket") next *= ENERGY_BOMB;
  else if (ev.kind === "add") next += 0.14 + Number(ev.value || 0) * 0.028;
  else if (ev.kind === "mul") next += 0.22 + Number(ev.value || 0) * 0.045;
  return Math.min(ENERGY_MAX, Math.max(ENERGY_MIN, next));
}

function applyMultiplierEvent(multiplier, ev) {
  let m = Number(multiplier) || 1;
  if (!ev) return m;
  if (ev.kind === "add") m += Number(ev.value) || 0;
  else if (ev.kind === "mul") m *= Number(ev.value) || 1;
  else if (ev.kind === "rocket") m *= 0.5;
  return Math.min(MAX_MULT, Math.floor(m * 100) / 100);
}

/** Close to the deck → land. Too high → fly past. In the water → crash. */
function shipApproach(energy, ship, isLast) {
  const speed = Number(energy) || 0;
  const level = Number(ship?.shipLevel) || ENERGY_STALL;
  if (speed < WATER_ENERGY) return "water";
  if (isLast || speed <= level) return "land";
  return "pass";
}

function altitudeFromEnergy(energy) {
  return Math.round((6 + (Number(energy) || 1) * 48) * 10) / 10;
}

function energyAt(progress, plan) {
  let energy = 1;
  let t = 0;
  const end = Math.min(1, Math.max(0, Number(progress) || 0));
  const list = [...(plan?.events || [])].filter(isCorridor).sort((a, b) => a.t - b.t);
  let i = 0;
  const step = 0.01;
  while (t < end) {
    const dt = Math.min(step, end - t);
    t += dt;
    energy = Math.max(ENERGY_MIN, energy * Math.exp(-ENERGY_DECAY * dt));
    while (i < list.length && list[i].t <= t) {
      energy = applyEnergyEvent(energy, list[i]);
      i += 1;
    }
  }
  return energy;
}

function simulateFlight(events, ships = courseShips()) {
  let speed = 1;
  let mult = 1;
  let t = 0;
  const list = [...(events || [])].filter(isCorridor).sort((a, b) => a.t - b.t);
  const checks = [...(ships || [])].sort((a, b) => a.t - b.t);
  let i = 0;
  let shipIndex = 0;
  const step = 0.005;
  while (t < 1) {
    t = Math.min(1, t + step);
    speed = Math.max(ENERGY_MIN, speed * Math.exp(-ENERGY_DECAY * step));
    while (i < list.length && list[i].t <= t) {
      const ev = list[i];
      speed = applyEnergyEvent(speed, ev);
      mult = applyMultiplierEvent(mult, ev);
      i += 1;
      if (mult < 1) return { lands: false, crashAt: ev.t, missAt: ev.t };
    }
    while (shipIndex < checks.length && checks[shipIndex].t <= t) {
      const ship = checks[shipIndex];
      shipIndex += 1;
      const last = shipIndex >= checks.length;
      const result = shipApproach(speed, ship, last);
      if (result === "water") return { lands: false, crashAt: ship.t, missAt: ship.t };
      if (result === "land") return { lands: true, crashAt: 1, landAt: ship.t };
    }
  }
  return { lands: shipIndex >= checks.length, crashAt: 1 };
}

function multiplierAt(progress, plan) {
  let m = 1;
  const p = Math.max(0, Number(progress) || 0);
  for (const ev of plan.events || []) {
    if (ev.t > p) continue;
    if (ev.kind === "add") m += Number(ev.value) || 0;
    else if (ev.kind === "mul") m *= Number(ev.value) || 1;
    else if (ev.kind === "rocket") m *= 0.5;
  }
  return Math.min(MAX_MULT, Math.floor(m * 100) / 100);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

function makeSkyEvents() {
  const pairs = 18 + Math.floor(rand() * 4);
  const kinds = [];
  for (let i = 0; i < pairs; i += 1) {
    kinds.push("rocket");
    kinds.push(rand() < 0.42 ? "mul" : "add");
  }
  shuffle(kinds);
  const first = 0.18;
  const last = 0.9;
  const n = kinds.length;
  const span = last - first;
  const events = kinds.map((kind, i) => {
    const slot = first + ((i + 0.5) / n) * span;
    const jitter = (rand() - 0.5) * (span / n) * 1.4;
    const t = Math.round(Math.min(last, Math.max(first, slot + jitter)) * 1000) / 1000;
    const corridor = rand() < 0.58;
    const ox = Math.round((corridor ? (rand() * 2 - 1) * 0.22 : rand() * 2 - 1) * 1000) / 1000;
    const oy = Math.round((corridor ? (rand() * 2 - 1) * 0.2 : rand() * 2 - 1) * 1000) / 1000;
    if (kind === "rocket") return { t, kind, value: 2, ox, oy };
    if (kind === "mul") return { t, kind, value: MULS[Math.floor(rand() * MULS.length)], ox, oy };
    return { t, kind, value: ADDS[Math.floor(rand() * ADDS.length)], ox, oy };
  });
  events.sort((a, b) => a.t - b.t);
  events.forEach((ev, i) => {
    ev.id = i;
  });
  return events;
}

function generateFlight(houseEdge) {
  const edge = Math.min(Math.max(Number(houseEdge) || 0, 0), 0.2);
  const events = makeSkyEvents();
  const ships = courseShips();
  let { lands, crashAt } = simulateFlight(events, ships);
  if (lands && rand() < edge) {
    const extra = events.find((ev) => ev.kind !== "rocket" && isCorridor(ev) && ev.t > 0.52);
    if (extra) {
      extra.kind = "rocket";
      extra.value = 2;
    }
    ({ lands, crashAt } = simulateFlight(events, ships));
  }
  return {
    lands,
    crashAt,
    ships,
    events,
    pickups: events.filter((e) => e.kind !== "rocket"),
    rockets: events.filter((e) => e.kind === "rocket").map((e) => ({ t: e.t, drop: 0.5 })),
    durationMs: 18000,
  };
}

function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 2;
  return Math.min(5, Math.max(1, n));
}

function durationForSpeed(plan, speed) {
  return Math.max(1500, Math.round((plan.durationMs || 9000) / clampSpeed(speed)));
}

function publicFlight(plan) {
  return {
    events: plan.events || [],
    pickups: plan.pickups || [],
    rockets: plan.rockets || [],
    ships: plan.ships || courseShips(),
  };
}

module.exports = {
  toHundredths,
  payoutFor,
  multiplierAt,
  generateFlight,
  publicFlight,
  clampSpeed,
  durationForSpeed,
  applyEnergyEvent,
  applyMultiplierEvent,
  isCorridor,
  altitudeFromEnergy,
  energyAt,
  simulateFlight,
  shipApproach,
  courseShips,
  ENERGY_DECAY,
  ENERGY_STALL,
  ENERGY_MIN,
  WATER_ENERGY,
};
