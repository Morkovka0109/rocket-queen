import { io } from 'socket.io-client';
import { t } from './i18n.js';

function formatMoney(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function connectGame({ telegram, ui }) {
  const namespace = import.meta.env.VITE_SOCKET_NS || '/aviator';
  const origin = import.meta.env.DEV ? 'http://localhost:3001' : '';
  const socket = io(`${origin}${namespace}`, {
    autoConnect: true,
    transports: ['polling', 'websocket'],
  });

  let myBet = null;
  let phase = 'waiting';
  let myId = null;

  const mine = (payload) => !payload?.userId || !myId || String(payload.userId) === String(myId);

  const syncPlay = () => {
    ui.setMode(phase === 'flying' ? 'flying' : 'launch');
  };

  socket.on('connect', () => {
    ui.setStatus(t.connected);
    socket.emit('auth', { initData: telegram.initData, devId: telegram.devId });
  });
  socket.on('connect_error', (err) => ui.setStatus(err.message || t.connectionFailed));

  socket.on('auth_ok', (payloadIn) => {
    const tokens =
      payloadIn.profile?.tokens ??
      payloadIn.tokens ??
      (payloadIn.balanceCents != null ? payloadIn.balanceCents / 100 : null);
    if (tokens != null) ui.setBalance(tokens);
    ui.setStatus(payloadIn.user.id === 'dev-player' ? t.devMode : t.authenticated);
    myId = payloadIn.user.id;
  });
  socket.on('auth_error', ({ error }) => ui.setStatus(error));

  socket.on('round_state', (state) => {
    if (state.phase === 'waiting' && (phase === 'flying' || ui.isLaunched())) return;
    phase = state.phase;
    ui.setPhase(state.phase);
    ui.setHistory(state.history || []);
    if (state.phase === 'flying') {
      if (state.roundEvents) ui.applyRoundEvents(state.roundEvents);
      ui.setPhase('flying');
      ui.launchPlane();
      ui.setProgress(state.progress || 0, state.multiplier || 1, state.altitude, state.distance);
    }
    if (state.phase === 'crashed') ui.setCrashed(state.crashPoint, state.reason);
    if (state.phase === 'landed') ui.land();
    if (state.phase === 'waiting') {
      ui.setWaiting();
      ui.setMultiplier(1);
      ui.setProgress(0, 1);
    }
    ui.setBets(state.bets || []);
    syncPlay();
  });

  socket.on('waiting', (state) => {
    if (!mine(state)) return;
    if (phase === 'flying' && ui.isLaunched()) return;
    phase = 'waiting';
    myBet = null;
    ui.setPhase('waiting');
    ui.setWaiting();
    ui.setMultiplier(1);
    ui.setProgress(0, 1);
    ui.clearCrash();
    syncPlay();
  });

  socket.on('flying', (state) => {
    if (!mine(state)) return;
    phase = 'flying';
    ui.applyRoundEvents(state.roundEvents);
    ui.setPhase('flying');
    ui.launchPlane();
    syncPlay();
  });

  socket.on('tick', ({ multiplier, progress, altitude, distance, userId }) => {
    if (!mine({ userId })) return;
    if (!ui.isLaunched()) return;
    ui.setProgress(progress || 0, multiplier || 1, altitude, distance);
  });

  socket.on('crashed', ({ crashPoint, roundId, reason, userId }) => {
    if (!mine({ userId })) return;
    phase = 'crashed';
    ui.setPhase('crashed');
    ui.setCrashed(crashPoint, reason);
    ui.pushHistory(0, roundId);
    ui.setStreak(0);
    syncPlay();
    telegram.haptic('heavy');
    if (myBet) telegram.notify('error');
  });

  socket.on('landed', (data) => {
    if (!mine(data)) return;
    phase = 'landed';
    ui.setPhase('landed');
    ui.land(data.payoutCents);
    if (data.balanceCents != null) ui.setBalance(data.balanceCents / 100);
    const payout = data.payoutCents ?? 0;
    ui.setStatus(t.outAt(Number(data.multiplier).toFixed(2), formatMoney(payout)));
    if (data.streak != null) ui.setStreak(data.streak);
    ui.pushHistory(data.multiplier, data.roundId);
    ui.setMyBetCents(0);
    myBet = null;
    syncPlay();
    telegram.notify('success');
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
    if (data.profile?.tokens != null) ui.setBalance(data.profile.tokens);
    else if (data.balanceCents != null) ui.setBalance(data.balanceCents / 100);
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

  socket.on('bonus_ok', (data) => {
    if (data.balanceCents != null) ui.setBalance(data.balanceCents / 100);
    ui.setStatus(t.bonusOk((data.amountCents || 0) / 100));
    telegram.notify('success');
  });

  socket.on('error_message', ({ error }) => {
    ui.setStatus(error);
    telegram.notify('error');
  });

  ui.onPlay(() => {
    if (phase === 'waiting' || phase === 'crashed' || phase === 'landed') {
      socket.emit('launch', { amount: ui.getBetAmount(), speed: ui.getSpeed() });
    }
  });

  ui.onSpeed((value) => {
    if (phase === 'flying') socket.emit('set_speed', { speed: value });
  });

  ui.onBonus(() => socket.emit('claim_bonus'));

  return socket;
}
