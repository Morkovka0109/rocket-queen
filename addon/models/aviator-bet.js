"use strict";

module.exports = (sequelize, DataTypes) => {
  const AviatorBet = sequelize.define(
    "AviatorBet",
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      roundId: {
        type: DataTypes.UUID,
        allowNull: false,
      },
      userId: {
        type: DataTypes.BIGINT,
        allowNull: false,
      },
      slot: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      amount: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      autoCashout: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: "pending",
      },
      cashoutMultiplier: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      payout: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      auto: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      tableName: "aviator_bets",
      timestamps: true,
      indexes: [
        { fields: ["userId", "createdAt"] },
        { fields: ["roundId", "userId", "slot"], unique: true },
        { fields: ["userId", "status"] },
      ],
    },
  );

  AviatorBet.associate = (models) => {
    if (models.User) {
      AviatorBet.belongsTo(models.User, {
        foreignKey: "userId",
        targetKey: "id",
        as: "user",
      });
    }
    if (models.AviatorRound) {
      AviatorBet.belongsTo(models.AviatorRound, {
        foreignKey: "roundId",
        as: "round",
      });
    }
  };

  return AviatorBet;
};
