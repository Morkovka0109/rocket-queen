export function rollRoundEvents(crashPoint, growthPerSecond) {
  const events = [];
  let crash = Number(crashPoint) || 1;
  let golden = false;

  if (Math.random() < 0.08) {
    golden = true;
    crash = Math.max(crash * (1.8 + Math.random()), 3.5);
    crash = Math.round(crash * 100) / 100;
    events.push({ type: 'golden' });
  } else if (Math.random() < 0.2) {
    crash = Math.min(crash, Math.round((1.06 + Math.random() * 0.4) * 100) / 100);
    events.push({ type: 'early' });
  } else {
    events.push({ type: 'normal' });
  }

  const segments = [{ at: 0, rate: growthPerSecond }];
  if (Math.random() < 0.32) {
    const fromMs = 1100 + Math.floor(Math.random() * 2800);
    const toMs = fromMs + 1200 + Math.floor(Math.random() * 600);
    segments.push({ at: fromMs, rate: growthPerSecond * 0.3 });
    segments.push({ at: toMs, rate: growthPerSecond });
    events.push({ type: 'turbulence', fromMs, toMs });
  }
  if (Math.random() < 0.3) {
    const fromMs = 1800 + Math.floor(Math.random() * 3200);
    const toMs = fromMs + 700 + Math.floor(Math.random() * 400);
    segments.push({ at: fromMs, rate: growthPerSecond * 2.5 });
    segments.push({ at: toMs, rate: growthPerSecond });
    events.push({ type: 'boost', fromMs, toMs });
  }
  segments.sort((a, b) => a.at - b.at);

  let landingZone = null;
  if (Math.random() < 0.24) {
    const from = Math.round((1.45 + Math.random() * 1.4) * 100) / 100;
    const to = Math.round((from + 0.28 + Math.random() * 0.12) * 100) / 100;
    landingZone = { from, to };
    events.push({ type: 'landing', from, to });
  }

  let ringAt = null;
  const ringBonus = 0.25;
  if (Math.random() < 0.38) {
    ringAt = Math.round((1.25 + Math.random() * 1.6) * 100) / 100;
    events.push({ type: 'ring', at: ringAt, bonus: ringBonus });
  }

  if (Math.random() < 0.34) {
    const fromMs = 1400 + Math.floor(Math.random() * 4200);
    const toMs = fromMs + 1600;
    events.push({ type: 'clouds', fromMs, toMs });
  }

  const bombs = [];
  const bombCap = crash - 0.06;
  if (bombCap > 1.2) {
    const n = 2 + Math.floor(Math.random() * 3);
    let at = 1.16 + Math.random() * 0.14;
    for (let i = 0; i < n && at < bombCap; i += 1) {
      bombs.push({
        at: Math.round(at * 100) / 100,
        drop: Math.round((0.12 + Math.random() * 0.1) * 100) / 100,
      });
      at += 0.28 + Math.random() * 0.42;
    }
  }

  return {
    crash,
    golden,
    segments,
    landingZone,
    ringAt,
    ringBonus,
    bombs,
    events,
  };
}

export function multiplierFromSegments(elapsedMs, segments, fallbackRate) {
  const segs = (segments || []).length
    ? [...segments].sort((a, b) => a.at - b.at)
    : [{ at: 0, rate: fallbackRate }];
  if (segs[0].at > 0) segs.unshift({ at: 0, rate: fallbackRate });
  let log = 0;
  const t = Math.max(0, elapsedMs);
  for (let i = 0; i < segs.length; i += 1) {
    const from = segs[i].at;
    const to = i + 1 < segs.length ? segs[i + 1].at : t;
    const a = Math.max(from, 0);
    const b = Math.min(Math.max(to, from), t);
    if (b > a) log += segs[i].rate * ((b - a) / 1000);
  }
  return Math.max(1, Math.exp(log));
}

export function applyBombs(raw, bombs) {
  let m = Number(raw) || 1;
  const list = [...(bombs || [])].sort((a, b) => a.at - b.at);
  for (const bomb of list) {
    if (raw + 0.001 >= bomb.at) {
      const drop = Math.min(0.45, Math.max(0, Number(bomb.drop) || 0));
      m = Math.max(1, m * (1 - drop));
    }
  }
  return m;
}

export function activeEvent(events, elapsedMs) {
  for (const ev of events || []) {
    if ((ev.type === 'turbulence' || ev.type === 'boost' || ev.type === 'clouds') && elapsedMs >= ev.fromMs && elapsedMs <= ev.toMs) {
      return ev.type;
    }
  }
  return null;
}

export function publicEvents(mod) {
  return {
    golden: Boolean(mod.golden),
    landingZone: mod.landingZone,
    ringAt: mod.ringAt,
    ringBonus: mod.ringBonus,
    bombs: mod.bombs || [],
    events: mod.events,
  };
}
