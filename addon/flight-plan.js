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

function generateFlight(houseEdge) {
  const edge = Math.min(Math.max(Number(houseEdge) || 0, 0), 0.2);
  const events = [];
  const n = 7 + Math.floor(rand() * 5);
  const first = 0.08;
  const step = (0.94 - first) / Math.max(1, n - 1);
  for (let i = 0; i < n; i += 1) {
    const jitter = (rand() - 0.5) * step * 0.6;
    const t = Math.round(Math.min(0.95, Math.max(0.06, first + step * i + jitter)) * 1000) / 1000;
    const roll = rand();
    if (roll < 0.28) events.push({ t, kind: "rocket", value: 2 });
    else if (roll < 0.48) events.push({ t, kind: "mul", value: MULS[Math.floor(rand() * MULS.length)] });
    else events.push({ t, kind: "add", value: ADDS[Math.floor(rand() * ADDS.length)] });
  }
  events.sort((a, b) => a.t - b.t);
  const peak = multiplierAt(1, { events });
  const pLand = Math.min(0.72, (1 - edge) / Math.max(peak, 0.5));
  const lands = rand() < pLand;
  const crashAt = lands ? 1 : Math.round((0.55 + rand() * 0.38) * 1000) / 1000;
  return {
    lands,
    crashAt,
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
    lands: Boolean(plan.lands),
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
};
