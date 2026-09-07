const { numberValue } = require("./notify");

function serializeProfile(user) {
  return {
    telegramId: String(user.id),
    firstName: user.firstName || user.first_name || user.name2 || "",
    lastName: user.lastName || user.last_name || null,
    username: user.username || null,
    tokens: numberValue(user.moneta),
    caseBalance: numberValue(user.case_balance),
  };
}

function serializeBet(bet, userLookup) {
  const user = userLookup?.get(String(bet.userId));
  return {
    userId: String(bet.userId),
    slot: bet.slot ?? 0,
    username: user?.username || "Игрок",
    amount: numberValue(bet.amount),
    cashedOut: Boolean(bet.cashedOut),
    cashoutMultiplier: bet.cashoutHundredths ? bet.cashoutHundredths / 100 : null,
  };
}

function serializeHistoryItem(round) {
  return {
    id: round.id,
    status: round.status,
    crashPoint: round.crashPoint == null ? null : numberValue(round.crashPoint),
    createdAt: round.createdAt,
  };
}

module.exports = { serializeProfile, serializeBet, serializeHistoryItem };
