function numberValue(value) {
  return Number(value || 0);
}

// Те же три чата, что у мин: админ-группа выплат, allGroupId, payoutsChannelId.
const PAYOUT_GROUP_ID = Number(process.env.AVIATOR_PAYOUT_GROUP || -1002634360526);

async function notifyAviatorCashout({
  telegram,
  Markup,
  Chest,
  Settings,
  user,
  payout,
  multiplier,
  amount,
  payoutGroupId = PAYOUT_GROUP_ID,
}) {
  if (!telegram || !Chest || payout <= 0) return;

  const chest = await Chest.create({
    userId: user.id,
    amount: payout,
    status: 0,
  });

  const settings = Settings ? await Settings.findOne() : null;
  const nick = user.username ? `@${user.username}` : user.name || user.id;
  const seeker = user.hash || user.s_id || user.id;
  const caseBalance = numberValue(user.case_balance);
  const adminText =
    `<b>Пользователю ${nick} начислен баланс за Aviator <code>${payout}</code> USDT\n` +
    `Множитель: ${Number(multiplier).toFixed(2)}x\n` +
    `Ставка: <code>${amount}</code> жетонов\n` +
    `Текущий его баланс: <code>${caseBalance}</code> USDT</b>`;
  const publicText =
    `<b>✈️ Мини-игра: Aviator\n` +
    `🎟 Ставка: <code>${amount}</code> жетонов\n` +
    `📈 Вывод: <code>${Number(multiplier).toFixed(2)}x</code>\n` +
    `💰 Выигрыш: <code>${payout}</code> USDT\n` +
    `🕵️ Искатель #${seeker} посадил самолёт и забрал банк</b>`;

  const payoutButton =
    Markup && typeof Markup.callbackButton === "function"
      ? Markup.callbackButton("💸 Выплатить", `admin_chest_payout_${chest.id}`)
      : null;
  const processingButton =
    Markup && typeof Markup.callbackButton === "function"
      ? Markup.callbackButton("⏳ В обработке", "none")
      : null;
  const adminKeyboard =
    payoutButton && typeof Markup.inlineKeyboard === "function"
      ? {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([[payoutButton]]),
        }
      : { parse_mode: "HTML" };

  const payMsg = payoutGroupId
    ? await telegram.sendMessage(payoutGroupId, adminText, adminKeyboard).catch((err) => {
        console.error("Ошибка уведомления Aviator (админ-группа):", err.message);
        return null;
      })
    : null;

  if (settings?.allGroupId) {
    await telegram
      .sendMessage(settings.allGroupId, publicText, { parse_mode: "HTML" })
      .catch((err) => console.error("Ошибка уведомления Aviator (allGroupId):", err.message));
  }

  const payoutMsg = settings?.payoutsChannelId
    ? await telegram
        .sendMessage(settings.payoutsChannelId, publicText, {
          parse_mode: "HTML",
          reply_markup:
            processingButton && typeof Markup.inlineKeyboard === "function"
              ? Markup.inlineKeyboard([[processingButton]])
              : undefined,
        })
        .catch((err) => {
          console.error("Ошибка уведомления Aviator (payoutsChannel):", err.message);
          return null;
        })
    : null;

  await chest.update({
    payMessageId: payMsg?.message_id || null,
    channelMessageId: payoutMsg?.message_id || null,
  });
}

module.exports = { notifyAviatorCashout, numberValue, PAYOUT_GROUP_ID };
