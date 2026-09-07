const { telegramUserFromInitData } = require("./telegram-auth");
const { serializeProfile, serializeBet } = require("./serialize");
const { numberValue } = require("./notify");

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
  economy,
}) {
  const { AviatorRound, AviatorBet, sequelize } = models;
  const nsp = io.of(config.namespace);
  const knownUsers = new Map();
  let persistQueue = Promise.resolve();

  const enqueue = (task) => {
    persistQueue = persistQueue.then(task).catch((err) => {
      console.error("Aviator persist error:", err);
    });
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

  game.on("waiting", (state) => emitToUser(nsp, state.userId, "waiting", state));
  game.on("flying", (state) => emitToUser(nsp, state.userId, "flying", state));
  game.on("tick", (tick) => emitToUser(nsp, tick.userId, "tick", tick));
  game.on("speed", (state) => emitToUser(nsp, state.userId, "speed_changed", state));
  game.on("crashed", (state) => {
    emitToUser(nsp, state.userId, "crashed", state);
    enqueue(() => persistRoundCrashed(state));
  });
  game.on("landed", (state) => {
    emitToUser(nsp, state.userId, "landed", {
      ...state,
      paid: false,
    });
    enqueue(async () => {
      await AviatorRound.update(
        { status: "landed", crashPoint: state.multiplier },
        { where: { id: state.roundId } },
      );
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
      const user = await createPlayer(models.User, telegramUser);
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

    socket.on("launch", async (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      try {
        const result = await economy.startGame(user, {
          amount: payload.amount,
          speed: payload.speed,
        });
        if (!result.ok) {
          socket.emit("error_message", { error: result.error, code: result.code });
          return;
        }
        socket.data.user = result.user;
        knownUsers.set(String(result.user.id), result.user);
      } catch (error) {
        console.error("Aviator launch:", error);
        socket.emit("error_message", { error: "Не удалось запустить самолёт" });
      }
    });

    socket.on("set_speed", (payload = {}) => {
      const user = socket.data.user;
      if (!user) return;
      game.setSpeed(String(user.id), payload.speed);
    });

    socket.on("cashout", async (payload = {}) => {
      const user = socket.data.user;
      if (!user) {
        socket.emit("error_message", { error: "Сначала войдите" });
        return;
      }
      const gameId = payload.roundId || payload.gameId || game.getStateFor(user.id).roundId;
      try {
        const result = await economy.cashOutGame(user, gameId);
        if (!result.ok) {
          socket.emit("error_message", { error: result.error });
          return;
        }
        socket.data.user = result.user;
        knownUsers.set(String(result.user.id), result.user);
      } catch (error) {
        console.error("Aviator cashout:", error);
        socket.emit("error_message", { error: "Не удалось забрать выигрыш" });
      }
    });
  });

  return nsp;
}

module.exports = { attachAviatorSockets };
