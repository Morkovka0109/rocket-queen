import { io } from 'socket.io-client';
import { t } from './i18n.js';
import { createGame, cashOutGame } from './api.js';

function formatMoney(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function tokensFrom(payload) {
  return (
    payload?.profile?.tokens ??
    payload?.tokens ??
    (payload?.balanceCents != null ? payload.balanceCents / 100 : null)
  );
}

export function connectGame({ telegram, ui }) {
  const namespace = import.meta.env.VITE_SOCKET_NS || '/aviator';
  // Same-origin in the browser (Vite proxies /socket.io in dev). Direct
  // http://localhost:3001 hits a CORS/credentials block and shows "xhr poll error".
  const origin = import.meta.env.VITE_SOCKET_ORIGIN || '';
  const socket = io(`${origin}${namespace}`, {
    autoConnect: true,
    transports: ['polling', 'websocket'],
    withCredentials: true,
  });

  let myBet = null;
  let phase = 'waiting';
  let myId = null;
  let gameId = null;
  let pendingPayoutCents = 0;
  let collected = false;
  let busy = false;

  const mine = (payload) => !payload?.userId || !myId || String(payload.userId) === String(myId);

  const syncPlay = () => {
    ui.setMode(phase === 'flying' ? 'flying' : 'launch');
    telegram.setStayOpen?.(phase === 'flying' || (phase === 'landed' && !collected));
  };

  const applyBalance = (payload) => {
    const tokens = tokensFrom(payload);
    if (tokens != null) ui.setBalance(tokens);
  };

  const startRound = async () => {
    if (busy) return;
    busy = true;
    try {
      const data = await createGame(telegram, {
        amount: ui.getBetAmount(),
        speed: ui.getSpeed(),
      });
      gameId = data.game?.id || null;
      collected = false;
      pendingPayoutCents = 0;
      const amountCents = Math.round(Number(data.game?.amount || ui.getBetAmount()) * 100);
      myBet = { amountCents };
      applyBalance(data);
      ui.setMyBetCents(amountCents);
      telegram.haptic('light');
      if (data.game?.roundEvents) {
        phase = 'flying';
        ui.applyRoundEvents(data.game.roundEvents);
        ui.setPhase('flying');
        ui.launchPlane();
        syncPlay();
      }
    } catch (err) {
      ui.setStatus(err.message || t.connectionFailed);
      telegram.notify('error');
    } finally {
      busy = false;
    }
  };

  const collectWin = async () => {
    if (busy || collected || !gameId) return;
    busy = true;
    try {
      const data = await cashOutGame(telegram, gameId);
      collected = true;
      telegram.setStayOpen?.(false);
      const payout =
        data.payoutCents ??
        (data.paidOut != null ? Math.round(Number(data.paidOut) * 100) : pendingPayoutCents);
      applyBalance(data);
      ui.markCollected(payout);
      ui.setStatus(
        t.outAt(Number(data.multiplier || 0).toFixed(2), formatMoney(payout)),
      );
      ui.setMyBetCents(0);
      myBet = null;
      telegram.notify('success');
    } catch (err) {
      ui.setStatus(err.message || t.connectionFailed);
      telegram.notify('error');
    } finally {
      busy = false;
    }
  };

  socket.on('connect', () => {
    ui.setStatus(t.connected);
    socket.emit('auth', { initData: telegram.initData, devId: telegram.devId });
  });
  socket.on('connect_error', (err) => ui.setStatus(err.message || t.connectionFailed));

  socket.on('auth_ok', (payloadIn) => {
    applyBalance(payloadIn);
    ui.setStatus(payloadIn.user.id === 'dev-player' || String(payloadIn.user.id).startsWith('dev-') ? t.devMode : t.authenticated);
    myId = payloadIn.user.id;
  });
  socket.on('auth_error', ({ error }) => ui.setStatus(error));

  socket.on('round_state', (state) => {
    if (state.phase === 'waiting' && (phase === 'flying' || ui.isLaunched())) return;
    phase = state.phase;
    ui.setPhase(state.phase);
    ui.setHistory(state.history || []);
    if (state.roundId) gameId = state.roundId;
    if (state.phase === 'flying') {
      if (state.roundEvents) ui.applyRoundEvents(state.roundEvents);
      ui.setPhase('flying');
      ui.launchPlane();
      ui.setProgress(state.progress || 0, state.multiplier || 1, state.altitude, state.distance);
    }
    if (state.phase === 'crashed') ui.setCrashed(state.crashPoint, state.reason, state.missAt);
    if (state.phase === 'landed') {
      const payoutCents = state.payoutCents ?? Math.round(Number(state.payout || 0) * 100);
      pendingPayoutCents = payoutCents;
      collected = Boolean(state.paid);
      ui.land(payoutCents, { collect: !state.paid, landAt: state.landAt });
    }
    if (state.phase === 'waiting') {
      ui.setWaiting();
      ui.setMultiplier(1);
      ui.setProgress(0, 1);
      gameId = null;
      collected = false;
    }
    ui.setBets(state.bets || []);
    syncPlay();
  });

  socket.on('waiting', (state) => {
    if (!mine(state)) return;
    if (phase === 'flying' && ui.isLaunched()) return;
    if (phase === 'landed' && !collected) return;
    phase = 'waiting';
    myBet = null;
    gameId = null;
    collected = false;
    pendingPayoutCents = 0;
    ui.setPhase('waiting');
    ui.setWaiting();
    ui.setMultiplier(1);
    ui.setProgress(0, 1);
    ui.clearCrash();
    syncPlay();
  });

  socket.on('flying', (state) => {
    if (!mine(state)) return;
    if (state.roundId) gameId = state.roundId;
    if (phase === 'flying' && ui.isLaunched()) return;
    phase = 'flying';
    collected = false;
    if (state.roundEvents) ui.applyRoundEvents(state.roundEvents);
    ui.setPhase('flying');
    ui.launchPlane();
    syncPlay();
  });

  socket.on('tick', ({ multiplier, progress, altitude, distance, energy, userId }) => {
    if (!mine({ userId })) return;
    ui.setProgress(progress || 0, multiplier || 1, altitude, distance, energy);
  });

  socket.on('crashed', ({ crashPoint, roundId, reason, userId, missAt }) => {
    if (!mine({ userId })) return;
    phase = 'crashed';
    collected = false;
    pendingPayoutCents = 0;
    ui.setPhase('crashed');
    ui.setCrashed(crashPoint, reason, missAt);
    ui.pushHistory(0, roundId);
    ui.setStreak(0);
    syncPlay();
    telegram.haptic('heavy');
    if (myBet) telegram.notify('error');
  });

  socket.on('landed', (data) => {
    if (!mine(data)) return;
    phase = 'landed';
    if (data.roundId) gameId = data.roundId;
    const payoutCents = data.payoutCents ?? Math.round(Number(data.payout || 0) * 100);
    pendingPayoutCents = payoutCents;
    collected = Boolean(data.paid);
    ui.setPhase('landed');
    ui.land(payoutCents, { collect: !collected, landAt: data.landAt });
    if (data.streak != null) ui.setStreak(data.streak);
    ui.pushHistory(data.multiplier, data.roundId);
    syncPlay();
  });

  socket.on('player_bet', (bet) => {
    ui.addBet({
      ...bet,
      amountCents: bet.amountCents ?? Math.round(Number(bet.amount || 0) * 100),
    });
  });
  socket.on('player_bet_cancelled', (bet) => ui.removeBet(bet));
  socket.on('player_cashout', (cashout) => ui.markCashout(cashout));
  socket.on('bets_sync', ({ bets }) => ui.setBets(bets || []));

  socket.on('bet_accepted', (data) => {
    const amountCents = data.amountCents ?? Math.round(Number(data.amount || 0) * 100);
    myBet = { amountCents };
    if (data.roundId) gameId = data.roundId;
    applyBalance(data);
    ui.setMyBetCents(amountCents);
    telegram.haptic('light');
    if (data.roundEvents) {
      phase = 'flying';
      ui.applyRoundEvents(data.roundEvents);
      ui.setPhase('flying');
      ui.launchPlane();
      syncPlay();
    }
  });

  socket.on('cashout_ok', (data) => {
    collected = true;
    telegram.setStayOpen?.(false);
    applyBalance(data);
    const payout =
      data.payoutCents ?? (data.payout != null ? Math.round(Number(data.payout) * 100) : pendingPayoutCents);
    ui.markCollected(payout);
    if (data.streak != null) ui.setStreak(data.streak);
    ui.setStatus(t.outAt(Number(data.multiplier || 0).toFixed(2), formatMoney(payout)));
    ui.setMyBetCents(0);
    myBet = null;
    telegram.notify('success');
  });

  socket.on('bonus_ok', (data) => {
    applyBalance(data);
    ui.setStatus(t.bonusOk((data.amountCents || 0) / 100));
    telegram.notify('success');
  });

  socket.on('error_message', ({ error }) => {
    ui.setStatus(error);
    telegram.notify('error');
  });

  ui.onPlay(() => {
    if (phase === 'waiting' || phase === 'crashed' || (phase === 'landed' && collected)) {
      startRound();
    }
  });

  ui.onCollect(() => {
    collectWin();
  });

  ui.onPickup((ev) => {
    if (phase !== 'flying') return;
    ui.notePickup(ev);
    socket.emit('collect', ev);
  });

  ui.onAirborne((t) => {
    if (phase === 'flying') socket.emit('airborne', { t });
  });

  ui.onSpeed((value) => {
    if (phase === 'flying') socket.emit('set_speed', { speed: value });
  });

  socket.on('speed_changed', ({ speed, durationMs, userId }) => {
    if (!mine({ userId })) return;
    ui.setFlightSpeed(speed, durationMs);
  });

  ui.onBonus(() => socket.emit('claim_bonus'));

  return socket;
}
