const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const {
  generateFlight,
  toHundredths,
  publicFlight,
  clampSpeed,
  durationForSpeed,
  applyEnergyEvent,
  applyMultiplierEvent,
  altitudeFromEnergy,
  shipApproach,
  ENERGY_DECAY,
  ENERGY_MIN,
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

  launch(userId, amount, speed = 2) {
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
      lastTickAt: Date.now(),
      durationMs,
      progress: 0,
      energy: 1,
      mult: 1,
      eventIndex: 0,
      shipIndex: 0,
      missAt: null,
      landAt: null,
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

  _endProgress(_session) {
    return 1;
  }

  _progressOf(session) {
    return Math.min(Math.max(Number(session.progress) || 0, 0), this._endProgress(session));
  }

  _advance(session, now) {
    const last = session.lastTickAt || now;
    const dt = Math.max(0, Math.min(250, now - last));
    session.lastTickAt = now;
    if (dt <= 0) return;
    if (!Number.isInteger(session.eventIndex)) session.eventIndex = 0;
    const dur = Math.max(1500, session.durationMs || 9000);
    const dP = dt / dur;
    session.progress = Math.min(1, (session.progress || 0) + dP);
    session.energy = Math.max(ENERGY_MIN, (session.energy || 1) * Math.exp(-ENERGY_DECAY * dP));
  }

  syncAirborne(userId, t) {
    const session = this.sessions.get(String(userId));
    if (!session || session.phase !== PHASE.FLYING) return { ok: false };
    const skip = Math.min(0.45, Math.max(0, Number(t) || 0));
    const from = session.progress || 0;
    if (skip <= from + 0.01) return { ok: true };
    const dP = skip - from;
    session.energy = Math.max(ENERGY_MIN, (session.energy || 1) * Math.exp(-ENERGY_DECAY * dP));
    session.progress = skip;
    session.lastTickAt = Date.now();
    this.emit("tick", {
      userId: session.userId,
      roundId: session.roundId,
      progress: this._progressOf(session),
      multiplier: session.mult,
      energy: session.energy,
      speed: session.energy,
      course: session.progress,
      serverTime: Date.now(),
    });
    return { ok: true, progress: session.progress, energy: session.energy };
  }

  collectPickup(userId, payload = {}) {
    const session = this.sessions.get(String(userId));
    if (!session || session.phase !== PHASE.FLYING) return { ok: false };
    const events = session.plan.events || [];
    const kind = payload.kind;
    const t = Number(payload.t);
    const id = Number(payload.id);
    let ev = Number.isInteger(id) && events[id] && events[id].kind === kind ? events[id] : null;
    if (!ev) {
      ev = events.find((item) => !item.hit && item.kind === kind && Math.abs(Number(item.t) - t) < 0.03);
    }
    if (!ev || ev.hit) return { ok: false };
    const p = session.progress || 0;
    const at = Number(ev.t);
    if (at > p + 0.45 || p > at + 0.35) return { ok: false };
    ev.hit = true;
    session.energy = applyEnergyEvent(session.energy, ev);
    session.mult = applyMultiplierEvent(session.mult || 1, ev);
    this.emit("tick", {
      userId: session.userId,
      roundId: session.roundId,
      progress: this._progressOf(session),
      multiplier: session.mult,
      altitude: altitudeFromEnergy(session.energy),
      energy: session.energy,
      speed: session.energy,
      course: session.progress,
      serverTime: Date.now(),
    });
    if ((session.mult || 1) < 1) {
      session.missAt = Number(ev.t);
      this._finish(session, false);
    }
    return { ok: true, multiplier: session.mult, energy: session.energy };
  }

  _onTick() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.phase === PHASE.FLYING) {
        this._advance(session, now);
        const progress = this._progressOf(session);
        const multiplier = session.mult || 1;
        this.emit("tick", {
          userId: session.userId,
          roundId: session.roundId,
          progress,
          multiplier: toHundredths(multiplier) / 100,
          energy: session.energy,
          speed: session.energy,
          course: progress,
          serverTime: now,
        });
        if ((session.mult || 1) < 1) {
          session.missAt = this._progressOf(session);
          this._finish(session, false);
        } else {
          this._checkShips(session);
        }
      } else if (this._canClear(session, now)) {
        this.sessions.delete(session.userId);
        this.emit("waiting", { userId: session.userId, ...this.idleState() });
      }
    }
  }

  _checkShips(session) {
    if (session.phase !== PHASE.FLYING) return;
    if (!Number.isInteger(session.shipIndex)) session.shipIndex = 0;
    const ships = session.plan.ships || [];
    const progress = this._progressOf(session);
    const speed = session.energy;
    if (!ships.length) {
      if (progress >= 0.97) this._finish(session, true);
      return;
    }
    while (session.shipIndex < ships.length && ships[session.shipIndex].t <= progress) {
      const ship = ships[session.shipIndex];
      session.shipIndex += 1;
      const last = session.shipIndex >= ships.length;
      const result = shipApproach(speed, ship, last);
      if (result === "water") {
        session.missAt = ship.t;
        this._finish(session, false);
        return;
      }
      if (result === "land") {
        session.landAt = ship.t;
        this._finish(session, true);
        return;
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

  _finish(session, landed) {
    const progress = this._progressOf(session);
    const multiplier = session.mult || 1;
    session.finalMult = multiplier;
    session.endedAt = Date.now();
    if (landed) {
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
        landAt: session.landAt,
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
        missAt: session.missAt,
        history: this.history,
        lost: [{ userId: session.userId, slot: 0 }],
        serverTime: Date.now(),
      });
    }
  }

  _publicSession(session) {
    const progress =
      session.phase === PHASE.FLYING ? this._progressOf(session) : this._endProgress(session);
    const multiplier = session.phase === PHASE.FLYING ? session.mult || 1 : session.finalMult;
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
      missAt: session.phase === PHASE.CRASHED ? session.missAt : undefined,
      landAt: session.phase === PHASE.LANDED ? session.landAt : undefined,
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
