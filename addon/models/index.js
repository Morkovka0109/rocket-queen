const defineAviatorRound = require("./aviator-round");
const defineAviatorBet = require("./aviator-bet");

function getModels(database) {
  const User = database.User;
  const sequelize = database.sequelize || User?.sequelize;
  const DataTypes = database.DataTypes || sequelize?.Sequelize?.DataTypes;

  if (!User || !sequelize || !DataTypes) {
    throw new Error("database must export User and sequelize (or User.sequelize).");
  }

  const AviatorRound =
    database.AviatorRound || defineAviatorRound(sequelize, DataTypes);
  const AviatorBet = database.AviatorBet || defineAviatorBet(sequelize, DataTypes);

  if (typeof AviatorRound.associate === "function") {
    AviatorRound.associate({ User, AviatorBet, AviatorRound });
  }
  if (typeof AviatorBet.associate === "function") {
    AviatorBet.associate({ User, AviatorBet, AviatorRound });
  }

  return {
    User,
    AviatorRound,
    AviatorBet,
    sequelize,
    Chest: database.Chest || null,
    Settings: database.Settings || null,
  };
}

module.exports = { getModels };
