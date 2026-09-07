function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function loadAddonConfig(overrides = {}) {
  return {
    houseEdge: Number(overrides.houseEdge ?? process.env.AVIATOR_HOUSE_EDGE ?? process.env.HOUSE_EDGE ?? 0.03),
    tickMs: numberEnv("AVIATOR_TICK_MS", 100),
    waitMs: numberEnv("AVIATOR_WAIT_MS", 5000),
    crashDisplayMs: numberEnv("AVIATOR_CRASH_DISPLAY_MS", 4000),
    growthPerSecond: Number(overrides.growthPerSecond ?? process.env.AVIATOR_GROWTH_PER_SECOND ?? 0.06),
    minBet: numberEnv("AVIATOR_MIN_BET", 1),
    maxBet: numberEnv("AVIATOR_MAX_BET", 500),
    namespace: overrides.namespace || process.env.AVIATOR_SOCKET_NAMESPACE || "/aviator",
    payoutGroupId: process.env.AVIATOR_PAYOUT_GROUP || null,
  };
}

module.exports = { loadAddonConfig };
