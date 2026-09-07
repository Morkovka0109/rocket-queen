import { EventEmitter } from 'events';
import crypto from 'crypto';
import {
  generateFlight,
  multiplierAt,
  altitudeAt,
  distanceAt,
  toHundredths,
  publicFlight,
  clampSpeed,
  durationForSpeed,
} from './flightPlan.js';

export const PHASE = {
  WAITING: 'waiting',
  FLYING: 'flying',
  CRASHED: 'crashed',
  LANDED: 'landed',
};

export class GameEngine extends EventEmitter {
  constructor({ houseEdge, tickMs, crashDisplayMs }) {
    super();
    this.houseEdge = houseEdge;
    this.tickMs = tickMs;
    this.crashDisplayMs = Number(crashDisplayMs) > 0 ? Number(crashDisplayMs) : 2800;

    /** @type {Map<string, object>} */
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

  getActiveBets() {
    const bets = [];
    for (const session of this.sessions.values()) {
      if (session.phase === PHASE.WAITING) continue;
      bets.push({
        userId: session.userId,
        slot: 0,
        amountCents: session.amountCents,
        cashedOut: session.phase === PHASE.LANDED,
        cashoutHundredths:
          session.phase === PHASE.LANDED ? toHundredths(session.finalMult) : null,
      });
    }
    return bets;
  }

  launch(userId, amountCents, speed = 2) {
    const id = String(userId);
    const current = this.sessions.get(id);
    if (current && current.phase === PHASE.FLYING) {
      return { ok: false, error: 'Самолёт уже в воздухе' };
    }

    const plan = generateFlight(this.houseEdge);
    const speedN = clampSpeed(speed);
    const durationMs = durationForSpeed(plan, speedN);
    const session = {
      userId: id,
      roundId: crypto.randomUUID(),
      phase: PHASE.FLYING,
      plan,
      amountCents,
      speed: speedN,
      startedAt: Date.now(),
      durationMs,
      finalMult: 1,
      cashedOut: false,
    };
    this.sessions.set(id, session);
    this._ensureTicker();

    this.emit('bet', {
      roundId: session.roundId,
      userId: id,
      slot: 0,
      amountCents,
    });
    this.emit('flying', {
      userId: id,
      roundId: session.roundId,
      phase: PHASE.FLYING,
      durationMs,
      speed: speedN,
      serverTime: Date.now(),
      roundEvents: publicFlight(plan),
    });
    return {
      ok: true,
      roundId: session.roundId,
      durationMs,
      roundEvents: publicFlight(plan),
    };
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
    this.emit('speed', {
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

  _progressOf(session) {
    const raw = (Date.now() - session.startedAt) / session.durationMs;
    const cap = session.plan.lands ? 1 : session.plan.crashAt;
    return Math.min(Math.max(raw, 0), cap);
  }

  _onTick() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.phase === PHASE.FLYING) {
        const progress = this._progressOf(session);
        const multiplier = multiplierAt(progress, session.plan);
        this.emit('tick', {
          userId: session.userId,
          roundId: session.roundId,
          progress,
          multiplier: toHundredths(multiplier) / 100,
          altitude: altitudeAt(progress, session.plan),
          distance: distanceAt(progress),
          course: progress,
          serverTime: now,
        });
        if (progress >= (session.plan.lands ? 1 : session.plan.crashAt) - 1e-6) {
          this._finish(session);
        }
      } else if (
        (session.phase === PHASE.CRASHED || session.phase === PHASE.LANDED) &&
        now - session.endedAt >= this.crashDisplayMs
      ) {
        this.sessions.delete(session.userId);
        this.emit('waiting', {
          userId: session.userId,
          ...this.idleState(),
        });
      }
    }
  }

  _finish(session) {
    const progress = this._progressOf(session);
    const multiplier = multiplierAt(progress, session.plan);
    session.finalMult = multiplier;
    session.endedAt = Date.now();

    if (session.plan.lands) {
      session.phase = PHASE.LANDED;
      session.cashedOut = true;
      const streak = (this.streaks.get(session.userId) || 0) + 1;
      this.streaks.set(session.userId, streak);
      const payoutCents = Math.floor((session.amountCents * toHundredths(multiplier)) / 100);
      this.history.unshift(multiplier);
      if (this.history.length > 24) this.history.length = 24;
      this.emit('landed', {
        userId: session.userId,
        roundId: session.roundId,
        phase: PHASE.LANDED,
        crashPoint: multiplier,
        multiplier,
        payoutCents,
        amountCents: session.amountCents,
        history: this.history,
        streak,
        extras: [],
        serverTime: Date.now(),
      });
    } else {
      session.phase = PHASE.CRASHED;
      this.streaks.set(session.userId, 0);
      this.history.unshift(0);
      if (this.history.length > 24) this.history.length = 24;
      this.emit('crashed', {
        userId: session.userId,
        roundId: session.roundId,
        phase: PHASE.CRASHED,
        crashPoint: multiplier,
        multiplier,
        reason: 'crash',
        history: this.history,
        lost: [{ userId: session.userId, slot: 0 }],
        serverTime: Date.now(),
      });
    }
  }

  _publicSession(session) {
    const progress =
      session.phase === PHASE.FLYING ? this._progressOf(session) : session.plan.lands ? 1 : session.plan.crashAt;
    const multiplier =
      session.phase === PHASE.FLYING ? multiplierAt(progress, session.plan) : session.finalMult;
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
      reason: session.phase === PHASE.CRASHED ? 'crash' : undefined,
    };
  }
}
