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

function createHttpRouter({ models, botToken, game, config }) {
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
