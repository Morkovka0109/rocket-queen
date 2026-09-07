"use strict";

module.exports = (sequelize, DataTypes) => {
  const AviatorRound = sequelize.define(
    "AviatorRound",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "waiting",
      },
      crashPoint: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      waitMs: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      startedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      crashedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: "aviator_rounds",
      timestamps: true,
      indexes: [{ fields: ["status", "createdAt"] }],
    },
  );

  AviatorRound.associate = (models) => {
    if (models.AviatorBet) {
      AviatorRound.hasMany(models.AviatorBet, {
        foreignKey: "roundId",
        as: "bets",
      });
    }
  };

  return AviatorRound;
};
