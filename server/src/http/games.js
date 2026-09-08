import express from 'express';
import { validateInitData, createDevUser } from '../telegram/validateInitData.js';

function initDataFromRequest(req) {
  const directHeader = req.get('X-Telegram-Init-Data');
  if (directHeader) return directHeader;
  const authorization = req.get('Authorization') || '';
  if (authorization.startsWith('Bearer ')) return authorization.slice('Bearer '.length);
  if (typeof req.body?.initData === 'string' && req.body.initData) return req.body.initData;
  return '';
}

function parseSpeed(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(5, Math.max(1, n));
}

export function createGamesRouter({ game, balances, config }) {
  const router = express.Router();

  function requirePlayer(req, res) {
    const initData = initDataFromRequest(req);
    let user = validateInitData(initData, config.botToken);
    if (!user && (config.allowDevAuth || config.nodeEnv !== 'production')) {
      user = createDevUser(req.get('X-Dev-Id') || req.body?.devId);
    }
    if (!user) {
      res.status(401).json({ error: 'Откройте игру из Telegram' });
      return null;
    }
    return user;
  }

  router.post('/aviator/games', (req, res) => {
    const user = requirePlayer(req, res);
    if (!user) return;

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount)) {
      res.status(400).json({ error: 'Некорректная сумма ставки' });
      return;
    }
    const amountCents = Math.round(amount * 100);
    if (amountCents < config.minBetCents || amountCents > config.maxBetCents) {
      res.status(400).json({
        error: `Ставка от ${config.minBetCents / 100} до ${config.maxBetCents / 100}`,
      });
      return;
    }

    game.forfeit(user.id);
    if (!balances.debit(user.id, amountCents)) {
      res.status(400).json({
        error: 'Недостаточно средств',
        code: 'INSUFFICIENT_TOKENS',
        balance: balances.get(user.id) / 100,
      });
      return;
    }

    const started = game.launch(user.id, amountCents, parseSpeed(req.body?.speed));
    if (!started.ok) {
      balances.credit(user.id, amountCents);
      res.status(400).json({ error: started.error });
      return;
    }

    res.status(201).json({
      game: {
        id: started.roundId,
        status: 'flying',
        amount,
        durationMs: started.durationMs,
        roundEvents: started.roundEvents,
      },
      profile: { tokens: balances.get(user.id) / 100 },
      balanceCents: balances.get(user.id),
    });
  });

  router.post('/aviator/games/:gameId/cashout', (req, res) => {
    const user = requirePlayer(req, res);
    if (!user) return;

    const result = game.cashOut(user.id, req.params.gameId);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }

    const balanceCents = balances.credit(user.id, result.payoutCents);
    res.json({
      result: 'cashout',
      prize: result.payoutCents / 100,
      paidOut: result.payoutCents / 100,
      multiplier: result.multiplier,
      game: {
        id: result.roundId,
        status: 'won',
        payout: result.payoutCents / 100,
        multiplier: result.multiplier,
      },
      profile: { tokens: balanceCents / 100 },
      payoutCents: result.payoutCents,
      balanceCents,
    });
  });

  return router;
}
