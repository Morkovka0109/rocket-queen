const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const {
  generateFlight,
  multiplierAt,
  toHundredths,
  publicFlight,
  clampSpeed,
  durationForSpeed,
} = require("./flight-plan");

const PHASE = {
  WAITING: "waiting",
  FLYING: "flying",
  CRASHED: "crashed",
  LANDED: "landed",
};

class GameEngine extends EventEmitter {
  constructor({ houseEdge, tickMs, crashDisplayMs }) {
    super();
    this.houseEdge = houseEdge;
    this.tickMs = tickMs;
    this.crashDisplayMs = Number(crashDisplayMs) > 0 ? Number(crashDisplayMs) : 2800;
    this.sessions = new Map();
    this.history = [];
    this.streaks = new Map();
    this._tickTimer = null;
  }

  start() {
    this._ensureTicker();
  }

  stop() {
    clearInterval(this._tickTimer);
    this._tickTimer = null;
  }

  idleState() {
    return {
      phase: PHASE.WAITING,
      roundId: null,
      multiplier: 1,
      progress: 0,
      history: this.history,
      serverTime: Date.now(),
    };
  }

  getStateFor(userId) {
    const session = this.sessions.get(String(userId));
    if (!session) return this.idleState();
    return this._publicSession(session);
  }

  getPublicState() {
    return this.idleState();
  }

  getRoundBets() {
    return this.getActiveBets();
  }

  getActiveBets() {
    const bets = [];
    for (const session of this.sessions.values()) {
      if (session.phase === PHASE.WAITING) continue;
      bets.push({
        userId: session.userId,
        slot: 0,
        amount: session.amount,
        cashedOut: Boolean(session.paid),
        cashoutHundredths: session.paid ? toHundredths(session.finalMult) : null,
      });
    }
    return bets;
  }

  launch(userId, amount, speed = 1.2) {
    const id = String(userId);
    const current = this.sessions.get(id);
    if (current && current.phase === PHASE.FLYING) {
      return { ok: false, error: "Самолёт уже в воздухе" };
    }
    const plan = generateFlight(this.houseEdge);
    const speedN = clampSpeed(speed);
    const durationMs = durationForSpeed(plan, speedN);
    const session = {
      userId: id,
      roundId: crypto.randomUUID(),
      phase: PHASE.FLYING,
      plan,
      amount,
      speed: speedN,
      startedAt: Date.now(),
      durationMs,
      finalMult: 1,
      cashedOut: false,
      paid: false,
    };
    this.sessions.set(id, session);
    this._ensureTicker();
    this.emit("bet", { roundId: session.roundId, userId: id, slot: 0, amount });
    this.emit("flying", {
      userId: id,
      roundId: session.roundId,
      phase: PHASE.FLYING,
      durationMs,
      speed: speedN,
      serverTime: Date.now(),
      roundEvents: publicFlight(plan),
    });
    return { ok: true, roundId: session.roundId, durationMs, roundEvents: publicFlight(plan) };
  }

  setSpeed(userId, speed) {
    const session = this.sessions.get(String(userId));
    if (!session || session.phase !== PHASE.FLYING) return { ok: false };
    const progress = this._progressOf(session);
    const speedN = clampSpeed(speed);
    const durationMs = durationForSpeed(session.plan, speedN);
    session.speed = speedN;
    session.durationMs = durationMs;
    session.startedAt = Date.now() - progress * durationMs;
    this.emit("speed", {
      userId: session.userId,
      roundId: session.roundId,
      speed: speedN,
      durationMs,
      progress,
      serverTime: Date.now(),
    });
    return { ok: true, speed: speedN, durationMs };
  }

  _ensureTicker() {
    if (this._tickTimer) return;
    this._tickTimer = setInterval(() => this._onTick(), this.tickMs);
  }

  _endProgress(session) {
    if (session.plan.lands) return 1;
    const at = Number(session.plan.crashAt);
    if (!Number.isFinite(at)) return 1;
    return Math.min(1, Math.max(0.75, at));
  }

  _progressOf(session) {
    const raw = (Date.now() - session.startedAt) / session.durationMs;
    return Math.min(Math.max(raw, 0), this._endProgress(session));
  }

  _onTick() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.phase === PHASE.FLYING) {
        const progress = this._progressOf(session);
        const multiplier = multiplierAt(progress, session.plan);
        this.emit("tick", {
          userId: session.userId,
          roundId: session.roundId,
          progress,
          multiplier: toHundredths(multiplier) / 100,
          course: progress,
          serverTime: now,
        });
        if (progress >= this._endProgress(session) - 1e-6) {
          this._finish(session);
        }
      } else if (this._canClear(session, now)) {
        this.sessions.delete(session.userId);
        this.emit("waiting", { userId: session.userId, ...this.idleState() });
      }
    }
  }

  _canClear(session, now) {
    if (!session.endedAt || now - session.endedAt < this.crashDisplayMs) return false;
    if (session.phase === PHASE.CRASHED) return true;
    return session.phase === PHASE.LANDED && session.paid;
  }

  forfeit(userId) {
    const session = this.sessions.get(String(userId));
    if (!session) return { ok: true };
    if (session.phase === PHASE.FLYING || (session.phase === PHASE.LANDED && !session.paid)) {
      this.sessions.delete(String(userId));
      this.streaks.set(String(userId), 0);
    }
    return { ok: true };
  }

  cashOut(userId, gameId) {
    const session = this.sessions.get(String(userId));
    if (!session) return { ok: false, error: "Нет активного полёта" };
    if (gameId && String(session.roundId) !== String(gameId)) {
      return { ok: false, error: "Игра не найдена" };
    }
    if (session.paid) return { ok: false, error: "Выигрыш уже забран" };
    if (session.phase === PHASE.CRASHED) {
      return { ok: false, error: "Самолёт упал в воду" };
    }
    if (session.phase !== PHASE.LANDED) {
      return { ok: false, error: "Забрать можно после посадки" };
    }
    const multiplier = session.finalMult;
    const payout = Math.floor((session.amount * toHundredths(multiplier)) / 100);
    if (payout <= 0) return { ok: false, error: "Нечего забирать" };
    session.paid = true;
    session.cashedOut = true;
    session.endedAt = Date.now();
    return {
      ok: true,
      userId: session.userId,
      roundId: session.roundId,
      amount: session.amount,
      multiplier,
      payout,
      auto: false,
      slot: 0,
      extras: session.plan.golden ? ["golden"] : [],
      streak: this.streaks.get(session.userId) || 0,
    };
  }

  undoCashOut(userId) {
    const session = this.sessions.get(String(userId));
    if (!session || session.phase !== PHASE.LANDED) return;
    session.paid = false;
    session.cashedOut = false;
  }

  _finish(session) {
    const progress = this._progressOf(session);
    const multiplier = multiplierAt(progress, session.plan);
    session.finalMult = multiplier;
    session.endedAt = Date.now();
    if (session.plan.lands) {
      session.phase = PHASE.LANDED;
      session.cashedOut = false;
      session.paid = false;
      const streak = (this.streaks.get(session.userId) || 0) + 1;
      this.streaks.set(session.userId, streak);
      const payout = Math.floor((session.amount * toHundredths(multiplier)) / 100);
      this.history.unshift(multiplier);
      if (this.history.length > 24) this.history.length = 24;
      this.emit("landed", {
        userId: session.userId,
        roundId: session.roundId,
        phase: PHASE.LANDED,
        crashPoint: multiplier,
        multiplier,
        payout,
        paid: false,
        amount: session.amount,
        history: this.history,
        streak,
        extras: session.plan.golden ? ["golden"] : [],
        serverTime: Date.now(),
      });
    } else {
      session.phase = PHASE.CRASHED;
      session.paid = false;
      this.streaks.set(session.userId, 0);
      this.history.unshift(0);
      if (this.history.length > 24) this.history.length = 24;
      this.emit("crashed", {
        userId: session.userId,
        roundId: session.roundId,
        phase: PHASE.CRASHED,
        crashPoint: multiplier,
        multiplier,
        reason: "crash",
        history: this.history,
        lost: [{ userId: session.userId, slot: 0 }],
        serverTime: Date.now(),
      });
    }
  }

  _publicSession(session) {
    const progress =
      session.phase === PHASE.FLYING ? this._progressOf(session) : this._endProgress(session);
    const multiplier = session.phase === PHASE.FLYING ? multiplierAt(progress, session.plan) : session.finalMult;
    return {
      phase: session.phase,
      roundId: session.roundId,
      multiplier,
      progress,
      history: this.history,
      serverTime: Date.now(),
      durationMs: session.durationMs,
      roundEvents: publicFlight(session.plan),
      crashPoint: session.phase === PHASE.CRASHED || session.phase === PHASE.LANDED ? session.finalMult : undefined,
      reason: session.phase === PHASE.CRASHED ? "crash" : undefined,
      paid: Boolean(session.paid),
      payout:
        session.phase === PHASE.LANDED
          ? Math.floor((session.amount * toHundredths(session.finalMult)) / 100)
          : 0,
      canCashout: session.phase === PHASE.LANDED && !session.paid,
    };
  }
}

module.exports = { GameEngine, PHASE };
