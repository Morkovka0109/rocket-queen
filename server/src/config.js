function requiredInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric env ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const allowDevAuth = String(process.env.ALLOW_DEV_AUTH || '').toLowerCase() === 'true';
  const botToken = process.env.BOT_TOKEN || '';

  if (nodeEnv === 'production' && (!botToken || botToken === 'your_telegram_bot_token')) {
    throw new Error('BOT_TOKEN is required in production');
  }

  const startingBalance = requiredInt('STARTING_BALANCE', 1000);

  return {
    nodeEnv,
    port: requiredInt('PORT', 3001),
    botToken,
    clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
    socketNamespace: process.env.SOCKET_NAMESPACE || '/aviator',
    houseEdge: Number(process.env.HOUSE_EDGE ?? 0.03),
    startingBalanceCents: Math.round(startingBalance * 100),
    allowDevAuth: nodeEnv !== 'production' && allowDevAuth,
    tickMs: requiredInt('TICK_MS', 100),
    waitMs: requiredInt('WAIT_MS', 5000),
    crashDisplayMs: requiredInt('CRASH_DISPLAY_MS', 4000),
    growthPerSecond: Number(process.env.GROWTH_PER_SECOND ?? 0.06),
    minBetCents: 100,
    maxBetCents: 50_000,
  };
}
