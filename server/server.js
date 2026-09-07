import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { loadConfig } from './src/config.js';
import { GameEngine } from './src/game/GameEngine.js';
import { BalanceStore } from './src/store/balances.js';
import { attachSocketHandlers } from './src/socket/handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config({ path: path.join(__dirname, '.env') });
const config = loadConfig();

const app = express();
app.use(cors({ origin: config.clientOrigin, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'aviator' });
});

if (config.nodeEnv === 'production') {
  const dist = path.join(__dirname, '../client/dist');
  app.use(express.static(dist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: config.clientOrigin, methods: ['GET', 'POST'] },
});

const balances = new BalanceStore(config.startingBalanceCents);
const game = new GameEngine({
  houseEdge: config.houseEdge,
  tickMs: config.tickMs,
  crashDisplayMs: config.crashDisplayMs,
});

attachSocketHandlers({ io, game, balances, config });
game.start();

httpServer.listen(config.port, () => {
  console.log(`Aviator server listening on :${config.port}`);
});
