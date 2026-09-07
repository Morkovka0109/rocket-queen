const crypto = require("node:crypto");

const MAX_CRASH = 1_000_000;

function generateCrashPoint(houseEdge) {
  const edge = Math.min(Math.max(Number(houseEdge) || 0, 0), 0.2);
  const r = crypto.randomInt(0, 2 ** 32) / 2 ** 32;
  if (r < edge) return 1;
  const crash = (1 - edge) / (1 - r);
  const capped = Math.min(crash, MAX_CRASH);
  return Math.max(1, Math.floor(capped * 100) / 100);
}

function multiplierAt(elapsedMs, growthPerSecond) {
  const seconds = Math.max(0, elapsedMs) / 1000;
  return Math.exp(growthPerSecond * seconds);
}

function toHundredths(multiplier) {
  return Math.floor(Number(multiplier) * 100);
}

function payoutFor(amount, hundredths) {
  return Math.floor((Number(amount) * hundredths) / 100);
}

module.exports = {
  generateCrashPoint,
  multiplierAt,
  toHundredths,
  payoutFor,
};
