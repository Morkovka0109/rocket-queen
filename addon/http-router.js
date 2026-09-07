const express = require("express");
const { telegramUserFromInitData, initDataFromRequest } = require("./telegram-auth");
const { serializeProfile, serializeHistoryItem } = require("./serialize");
const { numberValue } = require("./notify");

async function createPlayer(User, telegramUser) {
  const user = await User.findOne({ where: { id: telegramUser.id } });
  if (!user) return null;
  const next = {};
  if (telegramUser.username && user.username !== telegramUser.username) {
    next.username = telegramUser.username;
  }
  if (telegramUser.first_name && user.name2 !== telegramUser.first_name) {
    next.name2 = telegramUser.first_name;
  }
  if (Object.keys(next).length) await user.update(next);
  return user;
}

function createHttpRouter({ models, botToken, game, config, economy }) {
  const { User, AviatorRound, AviatorBet } = models;
  const router = express.Router();

  async function requirePlayer(req, res) {
    const telegramUser = telegramUserFromInitData(initDataFromRequest(req), botToken);
    if (!telegramUser) {
      res.status(401).json({ error: "Откройте игру из Telegram" });
      return null;
    }
    const user = await createPlayer(User, telegramUser);
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден в базе бота" });
      return null;
    }
    return user;
  }

  router.post("/telegram/session", async (req, res) => {
    const telegramUser = telegramUserFromInitData(req.body?.initData, botToken);
    if (!telegramUser) {
      res.status(400).json({ error: "Недействительные данные Telegram WebApp" });
      return;
    }
    const user = await createPlayer(User, telegramUser);
    if (!user) {
      res.status(404).json({ error: "Пользователь не найден в базе бота" });
      return;
    }
    res.json(serializeProfile(user));
  });

  router.get("/aviator/me", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (user) res.json(serializeProfile(user));
  });

  router.post("/aviator/games", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    try {
      const result = await economy.startGame(user, {
        amount: req.body?.amount,
        speed: req.body?.speed,
      });
      if (!result.ok) {
        res.status(result.status || 400).json({
          error: result.error,
          code: result.code,
          balance: result.balance,
        });
        return;
      }
      res.status(201).json({
        game: result.game,
        profile: result.profile,
      });
    } catch (error) {
      console.error("Aviator POST /games:", error);
      res.status(500).json({ error: "Не удалось запустить самолёт" });
    }
  });

  router.get("/aviator/games/active", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    const bet = await AviatorBet.findOne({
      where: { userId: user.id, status: "pending" },
      order: [["createdAt", "DESC"]],
    });
    if (!bet) {
      res.json({ game: null });
      return;
    }
    res.json({
      game: {
        id: bet.roundId,
        status: "active",
        amount: numberValue(bet.amount),
        ...game.getStateFor(user.id),
      },
    });
  });

  router.get("/aviator/games/:gameId", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    let bet = await AviatorBet.findOne({
      where: { roundId: req.params.gameId, userId: user.id },
    });
    if (!bet) {
      bet = await AviatorBet.findOne({
        where: { id: req.params.gameId, userId: user.id },
      });
    }
    if (!bet) {
      res.status(404).json({ error: "Игра не найдена" });
      return;
    }
    res.json({
      id: bet.roundId,
      status: bet.status,
      amount: numberValue(bet.amount),
      payout: numberValue(bet.payout),
      multiplier: bet.cashoutMultiplier == null ? null : numberValue(bet.cashoutMultiplier),
      ...game.getStateFor(user.id),
    });
  });

  router.post("/aviator/games/:gameId/cashout", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    try {
      const result = await economy.cashOutGame(user, req.params.gameId);
      if (!result.ok) {
        res.status(result.status || 400).json({ error: result.error });
        return;
      }
      res.json({
        result: result.result,
        prize: result.prize,
        paidOut: result.paidOut,
        multiplier: result.multiplier,
        game: result.game,
        profile: result.profile,
      });
    } catch (error) {
      console.error("Aviator POST /games/:id/cashout:", error);
      res.status(500).json({ error: "Не удалось забрать выигрыш" });
    }
  });

  router.get("/aviator/state", (_req, res) => {
    res.json({
      ...game.getPublicState(),
      minBet: config.minBet,
      maxBet: config.maxBet,
    });
  });

  router.get("/aviator/stats", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    const bets = await AviatorBet.findAll({ where: { userId: user.id } });
    const played = bets.length;
    const won = bets.filter((bet) => bet.status === "cashed_out");
    const lost = bets.filter((bet) => bet.status === "lost");
    res.json({
      gamesPlayed: played,
      gamesWon: won.length,
      gamesLost: lost.length,
      winRate: played ? Math.round((won.length / played) * 100) : 0,
      totalWon: won.reduce((sum, bet) => sum + numberValue(bet.payout), 0),
      bestPayout: Math.max(0, ...won.map((bet) => numberValue(bet.payout))),
      currentTokens: numberValue(user.moneta),
      currentCaseBalance: numberValue(user.case_balance),
    });
  });

  router.get("/aviator/history", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    const rounds = await AviatorRound.findAll({
      where: { status: "crashed" },
      order: [["createdAt", "DESC"]],
      limit: 24,
    });
    res.json(rounds.map(serializeHistoryItem));
  });

  router.get("/aviator/bets/recent", async (req, res) => {
    const user = await requirePlayer(req, res);
    if (!user) return;
    const bets = await AviatorBet.findAll({
      where: { userId: user.id },
      order: [["createdAt", "DESC"]],
      limit: 12,
    });
    res.json(
      bets.map((bet) => ({
        id: bet.id,
        roundId: bet.roundId,
        amount: numberValue(bet.amount),
        status: bet.status,
        cashoutMultiplier: bet.cashoutMultiplier == null ? null : numberValue(bet.cashoutMultiplier),
        payout: bet.status === "cashed_out" ? numberValue(bet.payout) : 0,
        createdAt: bet.createdAt,
      })),
    );
  });

  return { router, createPlayer };
}

module.exports = { createHttpRouter };
