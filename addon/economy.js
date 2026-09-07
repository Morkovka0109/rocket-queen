const { serializeProfile } = require("./serialize");
const { notifyAviatorCashout, numberValue, PAYOUT_GROUP_ID } = require("./notify");
const { toHundredths } = require("./flight-plan");

function emitToUser(nsp, userId, event, payload) {
  if (!nsp) return;
  nsp.to(`user:${userId}`).emit(event, payload);
}

function createEconomy({ models, game, config, telegram, Markup }) {
  const { User, AviatorRound, AviatorBet, sequelize, Chest, Settings } = models;
  let nsp = null;

  const setNamespace = (next) => {
    nsp = next;
  };

  async function forfeitOpenBets(userId, transaction) {
    await AviatorBet.update(
      { status: "lost", payout: 0 },
      { where: { userId, status: "pending" }, transaction },
    );
    game.forfeit(userId);
  }

  async function startGame(user, { amount, speed }) {
    const stake = Number(amount);
    if (!Number.isFinite(stake)) {
      return { ok: false, status: 400, error: "Некорректная сумма ставки" };
    }
    if (stake < config.minBet || stake > config.maxBet) {
      return {
        ok: false,
        status: 400,
        error: `Ставка от ${config.minBet} до ${config.maxBet} жетонов`,
      };
    }

    const transaction = await sequelize.transaction();
    try {
      const locked = await User.findOne({
        where: { id: user.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!locked) {
        await transaction.rollback();
        return { ok: false, status: 404, error: "Пользователь не найден в базе бота" };
      }

      const tokens = numberValue(locked.moneta);
      if (tokens < stake) {
        await transaction.rollback();
        return {
          ok: false,
          status: 400,
          error: `Не хватает жетонов. Нужно ${stake}, у тебя ${tokens}.`,
          code: "INSUFFICIENT_TOKENS",
          balance: tokens,
        };
      }

      await forfeitOpenBets(locked.id, transaction);
      await locked.decrement("moneta", { by: stake, transaction });

      const started = game.launch(String(locked.id), stake, speed);
      if (!started.ok) {
        await transaction.rollback();
        return { ok: false, status: 400, error: started.error };
      }

      try {
        await AviatorRound.findOrCreate({
          where: { id: started.roundId },
          defaults: {
            id: started.roundId,
            status: "flying",
            waitMs: config.waitMs || 0,
            startedAt: new Date(),
          },
          transaction,
        });
        await AviatorBet.create(
          {
            roundId: started.roundId,
            userId: locked.id,
            slot: 0,
            amount: stake,
            status: "pending",
          },
          { transaction },
        );
        await transaction.commit();
      } catch (error) {
        game.forfeit(locked.id);
        throw error;
      }
      await locked.reload();

      const payload = {
        ok: true,
        status: 201,
        game: {
          id: started.roundId,
          status: "flying",
          amount: stake,
          speed: Number(speed) || 2,
          durationMs: started.durationMs,
          roundEvents: started.roundEvents,
        },
        profile: serializeProfile(locked),
        user: locked,
      };
      emitToUser(nsp, locked.id, "bet_accepted", {
        roundId: started.roundId,
        slot: 0,
        amount: stake,
        profile: payload.profile,
        roundEvents: started.roundEvents,
        durationMs: started.durationMs,
      });
      return payload;
    } catch (error) {
      if (transaction && !transaction.finished) {
        await transaction.rollback().catch(() => {});
      }
      throw error;
    }
  }

  async function cashOutGame(user, gameId) {
    if (!gameId) {
      return { ok: false, status: 400, error: "Не указана игра" };
    }

    const transaction = await sequelize.transaction();
    let markedPaid = false;
    try {
      const bet = await AviatorBet.findOne({
        where: { roundId: gameId, userId: user.id, slot: 0 },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!bet) {
        await transaction.rollback();
        return { ok: false, status: 404, error: "Игра не найдена" };
      }
      if (bet.status === "cashed_out") {
        await transaction.rollback();
        return { ok: false, status: 400, error: "Выигрыш уже забран" };
      }
      if (bet.status !== "pending") {
        await transaction.rollback();
        return { ok: false, status: 400, error: "Игра уже завершена" };
      }

      let result = game.cashOut(String(user.id), gameId);
      if (!result.ok) {
        const round = await AviatorRound.findOne({
          where: { id: gameId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const multiplier = numberValue(round?.crashPoint);
        const amount = numberValue(bet.amount);
        const payout = Math.floor((amount * toHundredths(multiplier)) / 100);
        if (round?.status === "landed" && payout > 0) {
          result = {
            ok: true,
            userId: String(user.id),
            roundId: gameId,
            amount,
            multiplier,
            payout,
            extras: [],
            streak: 0,
          };
        }
      }
      if (!result.ok) {
        await transaction.rollback();
        return { ok: false, status: 400, error: result.error };
      }
      markedPaid = Boolean(game.getStateFor(user.id).paid);

      const locked = await User.findOne({
        where: { id: user.id },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!locked) {
        game.undoCashOut(user.id);
        await transaction.rollback();
        return { ok: false, status: 404, error: "Пользователь не найден в базе бота" };
      }

      await bet.update(
        {
          status: "cashed_out",
          cashoutMultiplier: result.multiplier,
          payout: result.payout,
          auto: false,
        },
        { transaction },
      );
      await AviatorRound.update(
        { status: "cashed_out", crashPoint: result.multiplier, crashedAt: new Date() },
        { where: { id: gameId }, transaction },
      );
      await locked.increment("case_balance", { by: result.payout, transaction });
      await transaction.commit();
      await locked.reload();

      const payload = {
        ok: true,
        status: 200,
        result: "cashout",
        prize: result.payout,
        paidOut: result.payout,
        multiplier: result.multiplier,
        amount: result.amount,
        game: {
          id: gameId,
          status: "won",
          amount: result.amount,
          multiplier: result.multiplier,
          payout: result.payout,
        },
        profile: serializeProfile(locked),
        user: locked,
      };

      emitToUser(nsp, locked.id, "cashout_ok", {
        roundId: gameId,
        slot: 0,
        multiplier: result.multiplier,
        payout: result.payout,
        auto: false,
        extras: result.extras || [],
        streak: result.streak || 0,
        profile: payload.profile,
      });

      notifyAviatorCashout({
        telegram,
        Markup,
        Chest,
        Settings,
        user: locked,
        payout: result.payout,
        multiplier: result.multiplier,
        amount: result.amount,
        payoutGroupId: config.payoutGroupId || PAYOUT_GROUP_ID,
      }).catch((err) => console.error("Ошибка уведомления Aviator:", err));

      return payload;
    } catch (error) {
      if (markedPaid) game.undoCashOut(user.id);
      if (transaction && !transaction.finished) {
        await transaction.rollback().catch(() => {});
      }
      throw error;
    }
  }

  async function markLost(roundId, userId) {
    await AviatorBet.update(
      { status: "lost", payout: 0 },
      { where: { roundId, userId, status: "pending" } },
    );
    await AviatorRound.update(
      { status: "crashed", crashedAt: new Date() },
      { where: { id: roundId } },
    );
  }

  return { setNamespace, startGame, cashOutGame, markLost };
}

module.exports = { createEconomy };
