import { validateInitData, createDevUser } from '../telegram/validateInitData.js';

const usersBySocket = new Map();
const lastBonusAt = new Map();
const BONUS_CENTS = 10_000;
const BONUS_COOLDOWN_MS = 60_000;

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
  };
}

function formatBet(bet, userLookup) {
  const user = userLookup.get(bet.userId);
  return {
    userId: bet.userId,
    slot: bet.slot ?? 0,
    username: user?.username || 'Игрок',
    amountCents: bet.amountCents,
    cashedOut: bet.cashedOut,
    cashoutMultiplier: bet.cashoutHundredths ? bet.cashoutHundredths / 100 : null,
  };
}

function emitToUser(nsp, userId, event, payload) {
  nsp.to(`user:${userId}`).emit(event, payload);
}

function parseSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(5, Math.max(1, n));
}

export function attachSocketHandlers({ io, game, balances, config }) {
  const nsp = io.of(config.socketNamespace || '/aviator');
  const knownUsers = new Map();

  const broadcastBets = () => {
    nsp.emit('bets_sync', {
      bets: game.getActiveBets().map((bet) => formatBet(bet, knownUsers)),
    });
  };

  game.on('flying', (state) => {
    emitToUser(nsp, state.userId, 'flying', state);
    broadcastBets();
  });
  game.on('tick', (tick) => emitToUser(nsp, tick.userId, 'tick', tick));
  game.on('speed', (state) => emitToUser(nsp, state.userId, 'speed_changed', state));
  game.on('waiting', (state) => emitToUser(nsp, state.userId, 'waiting', state));

  game.on('bet', ({ userId, amountCents, roundId, slot }) => {
    nsp.emit('player_bet', {
      roundId,
      userId,
      slot: slot ?? 0,
      username: knownUsers.get(userId)?.username || 'Игрок',
      amountCents,
    });
  });

  game.on('landed', (state) => {
    emitToUser(nsp, state.userId, 'landed', {
      ...state,
      paid: false,
      balanceCents: balances.get(state.userId),
    });
    broadcastBets();
  });

  game.on('crashed', (state) => {
    emitToUser(nsp, state.userId, 'crashed', state);
    broadcastBets();
  });

  nsp.on('connection', (socket) => {
    socket.emit('round_state', {
      ...game.getPublicState(),
      bets: game.getActiveBets().map((bet) => formatBet(bet, knownUsers)),
    });

    socket.on('auth', (payload = {}) => {
      const initData = typeof payload.initData === 'string' ? payload.initData : '';
      let user = validateInitData(initData, config.botToken);

      if (!user && (config.allowDevAuth || config.nodeEnv !== 'production')) {
        user = createDevUser(payload.devId);
      }

      if (!user) {
        socket.emit('auth_error', { error: 'Неверные данные Telegram' });
        return;
      }

      knownUsers.set(user.id, user);
      usersBySocket.set(socket.id, user);
      socket.data.user = user;
      socket.join(`user:${user.id}`);
      socket.emit('auth_ok', {
        user: publicUser(user),
        balanceCents: balances.get(user.id),
      });
      socket.emit('round_state', {
        ...game.getStateFor(user.id),
        bets: game.getActiveBets().map((bet) => formatBet(bet, knownUsers)),
      });
    });

    socket.on('launch', (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit('error_message', { error: 'Сначала войдите' });
        return;
      }

      const amount = Number(payload.amount);
      if (!Number.isFinite(amount)) {
        socket.emit('error_message', { error: 'Некорректная сумма ставки' });
        return;
      }
      const amountCents = Math.round(amount * 100);
      if (amountCents < config.minBetCents || amountCents > config.maxBetCents) {
        socket.emit('error_message', {
          error: `Ставка от ${config.minBetCents / 100} до ${config.maxBetCents / 100}`,
        });
        return;
      }

      game.forfeit(user.id);
      if (!balances.debit(user.id, amountCents)) {
        socket.emit('error_message', { error: 'Недостаточно средств' });
        return;
      }

      const started = game.launch(user.id, amountCents, parseSpeed(payload.speed));
      if (!started.ok) {
        balances.credit(user.id, amountCents);
        socket.emit('error_message', { error: started.error });
        return;
      }

      socket.emit('bet_accepted', {
        roundId: started.roundId,
        slot: 0,
        amountCents,
        balanceCents: balances.get(user.id),
        roundEvents: started.roundEvents,
        durationMs: started.durationMs,
      });
    });

    socket.on('set_speed', (payload = {}) => {
      const user = socket.data.user;
      if (!user) return;
      game.setSpeed(user.id, parseSpeed(payload.speed));
    });

    socket.on('collect', (payload = {}) => {
      const user = socket.data.user;
      if (!user) return;
      game.collectPickup(user.id, payload);
    });

    socket.on('airborne', (payload = {}) => {
      const user = socket.data.user;
      if (!user) return;
      game.syncAirborne(user.id, payload.t);
    });

    socket.on('cashout', (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit('error_message', { error: 'Сначала войдите' });
        return;
      }
      const gameId = payload.roundId || payload.gameId || game.getStateFor(user.id).roundId;
      const result = game.cashOut(user.id, gameId);
      if (!result.ok) {
        socket.emit('error_message', { error: result.error });
        return;
      }
      const balanceCents = balances.credit(user.id, result.payoutCents);
      emitToUser(nsp, user.id, 'cashout_ok', {
        roundId: result.roundId,
        multiplier: result.multiplier,
        payoutCents: result.payoutCents,
        payout: result.payoutCents / 100,
        balanceCents,
        profile: { tokens: balanceCents / 100 },
      });
    });

    socket.on('claim_bonus', () => {
      const user = socket.data.user;
      if (!user) {
        socket.emit('error_message', { error: 'Сначала войдите' });
        return;
      }
      const prev = lastBonusAt.get(user.id) || 0;
      const wait = BONUS_COOLDOWN_MS - (Date.now() - prev);
      if (wait > 0) {
        socket.emit('error_message', {
          error: `Бонус через ${Math.ceil(wait / 1000)} с`,
        });
        return;
      }
      lastBonusAt.set(user.id, Date.now());
      balances.credit(user.id, BONUS_CENTS);
      socket.emit('bonus_ok', {
        amountCents: BONUS_CENTS,
        balanceCents: balances.get(user.id),
      });
    });

    socket.on('disconnect', () => {
      usersBySocket.delete(socket.id);
    });
  });
}
