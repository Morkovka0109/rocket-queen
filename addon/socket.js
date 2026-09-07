const { telegramUserFromInitData } = require("./telegram-auth");
const { toHundredths } = require("./crash-math");
const { serializeProfile, serializeBet } = require("./serialize");
const { notifyAviatorCashout, numberValue } = require("./notify");
const { PHASE } = require("./game-engine");

function parseSlot(raw) {
  return Number(raw) === 1 ? 1 : 0;
}

function prefKey(userId, slot) {
  return `${userId}:${slot}`;
}

function parseAutoCashout(raw) {
  if (raw === null || raw === undefined || raw === false || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const hundredths = toHundredths(value);
  if (hundredths < 101 || hundredths > 1_000_000_00) return null;
  return hundredths;
}

function emitToUser(nsp, userId, event, payload) {
  nsp.to(`user:${userId}`).emit(event, payload);
}

function publicUser(user) {
  return {
    id: String(user.id),
    username: user.username,
    firstName: user.firstName || user.first_name || user.name2,
  };
}

function attachAviatorSockets({
  io,
  game,
  models,
  botToken,
  config,
  createPlayer,
  telegram,
  Markup,
}) {
  const { User, AviatorRound, AviatorBet, sequelize, Chest, Settings } = models;
  const nsp = io.of(config.namespace);
  const knownUsers = new Map();
  const autoCashoutPrefs = new Map();
  let persistQueue = Promise.resolve();

  const enqueue = (task) => {
    persistQueue = persistQueue.then(task).catch((err) => {
      console.error("Aviator persist error:", err);
    });
  };

  const persistRoundWaiting = async (state) => {
    await AviatorRound.findOrCreate({
      where: { id: state.roundId },
      defaults: {
        id: state.roundId,
        status: "waiting",
        waitMs: state.waitMs,
      },
    });
  };

  const persistRoundFlying = async (roundId) => {
    await AviatorRound.update(
      { status: "flying", startedAt: new Date() },
      { where: { id: roundId } },
    );
  };

  const persistRoundCrashed = async ({ roundId, crashPoint, lost }) => {
    const transaction = await sequelize.transaction();
    try {
      await AviatorRound.update(
        { status: "crashed", crashPoint, crashedAt: new Date() },
        { where: { id: roundId }, transaction },
      );
      if (lost?.length) {
        for (const item of lost) {
          await AviatorBet.update(
            { status: "lost", payout: 0 },
            {
              where: {
                roundId,
                userId: item.userId,
                slot: item.slot ?? 0,
                status: "pending",
              },
              transaction,
            },
          );
        }
      }
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  };

  game.on("waiting", (state) => {
    emitToUser(nsp, state.userId, "waiting", state);
    if (state.roundId) enqueue(() => persistRoundWaiting(state));
  });
  game.on("flying", (state) => {
    emitToUser(nsp, state.userId, "flying", state);
    enqueue(async () => {
      await AviatorRound.findOrCreate({
        where: { id: state.roundId },
        defaults: { id: state.roundId, status: "flying", startedAt: new Date() },
      });
      await persistRoundFlying(state.roundId);
    });
  });
  game.on("tick", (tick) => emitToUser(nsp, tick.userId, "tick", tick));
  game.on("speed", (state) => emitToUser(nsp, state.userId, "speed_changed", state));
  game.on("crashed", (state) => {
    emitToUser(nsp, state.userId, "crashed", state);
    enqueue(() => persistRoundCrashed(state));
  });
  game.on("landed", (state) => {
    emitToUser(nsp, state.userId, "landed", state);
    game.emit("cashout", {
      userId: state.userId,
      amount: state.amount,
      multiplier: state.multiplier,
      payout: state.payout,
      roundId: state.roundId,
      auto: false,
      slot: 0,
      extras: state.extras,
      streak: state.streak,
    });
  });

  game.on("bet", ({ userId, amount, roundId, slot }) => {
    nsp.emit("player_bet", {
      roundId,
      userId,
      slot: slot ?? 0,
      username: knownUsers.get(String(userId))?.username || "Игрок",
      amount,
    });
  });

  game.on("bet_cancelled", ({ userId, amount, roundId, slot }) => {
    nsp.emit("player_bet_cancelled", {
      roundId,
      userId,
      slot: slot ?? 0,
      amount,
    });
  });

  game.on("cashout", ({ userId, amount, multiplier, payout, roundId, auto, slot, extras, streak }) => {
    enqueue(async () => {
      const transaction = await sequelize.transaction();
      try {
        const user = await User.findOne({
          where: { id: userId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!user) {
          await transaction.rollback();
          return;
        }
        await AviatorBet.update(
          {
            status: "cashed_out",
            cashoutMultiplier: multiplier,
            payout,
            auto: Boolean(auto),
          },
          { where: { roundId, userId, slot: slot ?? 0 }, transaction },
        );
        await user.increment("case_balance", { by: payout, transaction });
        await transaction.commit();
        await user.reload();

        nsp.emit("player_cashout", {
          roundId,
          userId: String(userId),
          slot: slot ?? 0,
          username: knownUsers.get(String(userId))?.username || user.username || "Игрок",
          amount,
          multiplier,
          payout,
          auto: Boolean(auto),
        });
        emitToUser(nsp, userId, "cashout_ok", {
          roundId,
          slot: slot ?? 0,
          multiplier,
          payout,
          auto: Boolean(auto),
          extras: extras || [],
          streak: streak || 0,
          profile: serializeProfile(user),
        });

        notifyAviatorCashout({
          telegram,
          Markup,
          Chest,
          Settings,
          user,
          payout,
          multiplier,
          amount,
          payoutGroupId: config.payoutGroupId,
        }).catch((err) => console.error("Ошибка уведомления Aviator:", err));
      } catch (error) {
        await transaction.rollback();
        throw error;
      }
    });
  });

  nsp.on("connection", (socket) => {
    socket.emit("round_state", {
      ...game.getPublicState(),
      bets: game.getRoundBets().map((bet) => serializeBet(bet, knownUsers)),
      minBet: config.minBet,
      maxBet: config.maxBet,
    });

    socket.on("auth", async (payload = {}) => {
      const initData = typeof payload.initData === "string" ? payload.initData : "";
      const telegramUser = telegramUserFromInitData(initData, botToken);
      if (!telegramUser) {
        socket.emit("auth_error", { error: "Неверные данные Telegram" });
        return;
      }
      const user = await createPlayer(User, telegramUser);
      if (!user) {
        socket.emit("auth_error", { error: "Пользователь не найден в базе бота" });
        return;
      }
      knownUsers.set(String(user.id), user);
      socket.data.user = user;
      socket.join(`user:${user.id}`);
      socket.emit("auth_ok", {
        user: publicUser(user),
        profile: serializeProfile(user),
        tokens: numberValue(user.moneta),
        caseBalance: numberValue(user.case_balance),
      });
      socket.emit("round_state", {
        ...game.getStateFor(user.id),
        bets: game.getRoundBets().map((bet) => serializeBet(bet, knownUsers)),
        minBet: config.minBet,
        maxBet: config.maxBet,
      });
    });

    socket.on("place_bet", async (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }

      const slot = parseSlot(payload.slot);
      const amount = Number(payload.amount);
      if (!Number.isFinite(amount)) {
        socket.emit("error_message", { error: "Некорректная сумма ставки" });
        return;
      }
      if (amount < config.minBet || amount > config.maxBet) {
        socket.emit("error_message", {
          error: `Ставка от ${config.minBet} до ${config.maxBet} жетонов`,
        });
        return;
      }

      if (game.phase !== PHASE.WAITING || !game.roundId) {
        socket.emit("error_message", { error: "Ставки принимаются только в ожидании" });
        return;
      }
      if (game.betsByRound.get(game.roundId)?.has(`${user.id}:${slot}`)) {
        socket.emit("error_message", { error: "В этой панели ставка уже сделана" });
        return;
      }

      let autoCashoutHundredths = parseAutoCashout(payload.autoCashout);
      if (autoCashoutHundredths == null && autoCashoutPrefs.has(prefKey(user.id, slot))) {
        autoCashoutHundredths = autoCashoutPrefs.get(prefKey(user.id, slot));
      }
      if (payload.autoCashout != null && payload.autoCashout !== false && autoCashoutHundredths == null) {
        socket.emit("error_message", { error: "Автовывод: укажите коэффициент от 1.01x" });
        return;
      }
      if (autoCashoutHundredths != null) {
        autoCashoutPrefs.set(prefKey(user.id, slot), autoCashoutHundredths);
      }

      const roundId = game.roundId;
      const transaction = await sequelize.transaction();
      try {
        const locked = await User.findOne({
          where: { id: user.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const tokens = numberValue(locked.moneta);
        if (tokens < amount) {
          await transaction.rollback();
          socket.emit("error_message", {
            error: `Не хватает жетонов. Нужно ${amount}, у тебя ${tokens}.`,
            code: "INSUFFICIENT_TOKENS",
          });
          return;
        }

        await AviatorRound.findOrCreate({
          where: { id: roundId },
          defaults: { id: roundId, status: "waiting", waitMs: game.waitMs },
          transaction,
        });
        await locked.decrement("moneta", { by: amount, transaction });
        await AviatorBet.create(
          {
            roundId,
            userId: user.id,
            slot,
            amount,
            autoCashout: autoCashoutHundredths ? autoCashoutHundredths / 100 : null,
            status: "pending",
          },
          { transaction },
        );
        await transaction.commit();

        const placed = game.placeBet(String(user.id), amount, autoCashoutHundredths, slot);
        if (!placed.ok) {
          await sequelize.transaction(async (refundTx) => {
            await AviatorBet.destroy({
              where: { roundId, userId: user.id, slot },
              transaction: refundTx,
            });
            await locked.increment("moneta", { by: amount, transaction: refundTx });
          });
          socket.emit("error_message", { error: placed.error });
          return;
        }

        await locked.reload();
        socket.data.user = locked;
        knownUsers.set(String(locked.id), locked);
        socket.emit("bet_accepted", {
          roundId: placed.roundId,
          slot,
          amount,
          autoCashout: autoCashoutHundredths ? autoCashoutHundredths / 100 : null,
          profile: serializeProfile(locked),
        });
        if (payload.launch) {
          const started = game.launch();
          if (!started.ok) socket.emit("error_message", { error: started.error });
        }
      } catch (error) {
        if (transaction && !transaction.finished) {
          await transaction.rollback().catch(() => {});
        }
        console.error("Aviator place_bet:", error);
        socket.emit("error_message", { error: "Не удалось сделать ставку" });
      }
    });

    socket.on("launch", async (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      const amount = Number(payload.amount);
      if (!Number.isFinite(amount)) {
        socket.emit("error_message", { error: "Некорректная сумма ставки" });
        return;
      }
      if (amount < config.minBet || amount > config.maxBet) {
        socket.emit("error_message", {
          error: `Ставка от ${config.minBet} до ${config.maxBet} жетонов`,
        });
        return;
      }
      const speed = Number(payload.speed) || 1.2;
      const transaction = await sequelize.transaction();
      try {
        const locked = await User.findOne({
          where: { id: user.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const tokens = numberValue(locked.moneta);
        if (tokens < amount) {
          await transaction.rollback();
          socket.emit("error_message", {
            error: `Не хватает жетонов. Нужно ${amount}, у тебя ${tokens}.`,
            code: "INSUFFICIENT_TOKENS",
          });
          return;
        }
        const started = game.launch(String(user.id), amount, speed);
        if (!started.ok) {
          await transaction.rollback();
          socket.emit("error_message", { error: started.error });
          return;
        }
        await AviatorRound.findOrCreate({
          where: { id: started.roundId },
          defaults: { id: started.roundId, status: "flying", startedAt: new Date() },
          transaction,
        });
        await locked.decrement("moneta", { by: amount, transaction });
        await AviatorBet.create(
          {
            roundId: started.roundId,
            userId: user.id,
            slot: 0,
            amount,
            status: "pending",
          },
          { transaction },
        );
        await transaction.commit();
        await locked.reload();
        socket.data.user = locked;
        knownUsers.set(String(locked.id), locked);
        socket.emit("bet_accepted", {
          roundId: started.roundId,
          slot: 0,
          amount,
          profile: serializeProfile(locked),
        });
      } catch (error) {
        if (transaction && !transaction.finished) {
          await transaction.rollback().catch(() => {});
        }
        console.error("Aviator launch:", error);
        socket.emit("error_message", { error: "Не удалось запустить самолёт" });
      }
    });

    socket.on("cancel_bet", async (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      const slot = parseSlot(payload.slot);
      const result = game.cancelBet(String(user.id), slot);
      if (!result.ok) {
        socket.emit("error_message", { error: result.error });
        return;
      }
      try {
        await sequelize.transaction(async (tx) => {
          await AviatorBet.destroy({
            where: { roundId: game.roundId, userId: user.id, slot, status: "pending" },
            transaction: tx,
          });
          const locked = await User.findOne({
            where: { id: user.id },
            transaction: tx,
            lock: tx.LOCK.UPDATE,
          });
          await locked.increment("moneta", { by: result.amount, transaction: tx });
          await locked.reload({ transaction: tx });
          socket.data.user = locked;
          socket.emit("bet_cancelled", {
            slot,
            amount: result.amount,
            profile: serializeProfile(locked),
          });
        });
      } catch (error) {
        console.error("Aviator cancel_bet:", error);
        socket.emit("error_message", { error: "Не удалось отменить ставку" });
      }
    });

    socket.on("set_speed", (payload = {}) => {
      const user = socket.data.user;
      if (!user) return;
      game.setSpeed(String(user.id), payload.speed);
    });

    socket.on("set_auto_cashout", (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      const slot = parseSlot(payload.slot);
      const enabled = Boolean(payload.enabled);
      const hundredths = enabled ? parseAutoCashout(payload.at) : null;
      if (enabled && hundredths == null) {
        socket.emit("error_message", { error: "Автовывод: укажите коэффициент от 1.01x" });
        return;
      }
      autoCashoutPrefs.set(prefKey(user.id, slot), hundredths);
      const result = game.setBetAutoCashout(String(user.id), hundredths, slot);
      if (!result.ok) {
        socket.emit("error_message", { error: result.error });
        return;
      }
      socket.emit("auto_cashout_set", {
        slot,
        enabled,
        at: hundredths ? hundredths / 100 : null,
        appliedToBet: Boolean(result.stored),
      });
    });

    socket.on("cashout", (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      const result = game.cashOut(String(user.id), { slot: parseSlot(payload.slot) });
      if (!result.ok) socket.emit("error_message", { error: result.error });
    });
  });

  return nsp;
}

module.exports = { attachAviatorSockets };
