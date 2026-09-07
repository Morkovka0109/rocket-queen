const { loadAddonConfig } = require("./config");
const { getModels } = require("./models");
const { GameEngine } = require("./game-engine");
const { createHttpRouter } = require("./http-router");
const { attachAviatorSockets } = require("./socket");

function loadTelegraf() {
  try {
    return require("telegraf");
  } catch {
    return null;
  }
}

/**
 * Подключает Aviator к существующему боту.
 *
 * const { createAviatorAddon } = require("./aviator/addon");
 * const addon = createAviatorAddon({ database, botToken, io });
 * app.use(addon.router);
 */
function createAviatorAddon({
  database,
  botToken = process.env.TELEGRAM_BOT_TOKEN,
  io,
  options = {},
} = {}) {
  if (!io) {
    throw new Error("createAviatorAddon требует Socket.IO server (io)");
  }

  const config = loadAddonConfig(options);
  const models = getModels(database);
  const game = new GameEngine(config);
  const telegraf = loadTelegraf();
  const telegram = botToken && telegraf?.Telegram ? new telegraf.Telegram(botToken) : null;
  const Markup = telegraf?.Markup || null;

  const { router, createPlayer } = createHttpRouter({
    models,
    botToken,
    game,
    config,
  });

  const namespace = attachAviatorSockets({
    io,
    game,
    models,
    botToken,
    config,
    createPlayer,
    telegram,
    Markup,
  });

  const ready = (async () => {
    if (options.sync) {
      await models.AviatorRound.sync();
      await models.AviatorBet.sync();
    }
    if (options.autoStart !== false) game.start();
  })();

  return {
    router,
    engine: game,
    namespace,
    models,
    config,
    ready,
  };
}

module.exports = {
  createAviatorAddon,
  loadAddonConfig,
};
