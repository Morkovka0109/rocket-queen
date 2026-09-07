const crypto = require("node:crypto");

function telegramUserFromInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  const rawUser = params.get("user");
  if (!hash || !Number.isFinite(authDate) || !rawUser) return null;

  const checkString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

  const received = Buffer.from(hash, "hex");
  const calculated = Buffer.from(expected, "hex");
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (
    received.length !== calculated.length ||
    !crypto.timingSafeEqual(received, calculated) ||
    age > 86_400 ||
    age < -300
  ) {
    return null;
  }

  try {
    const user = JSON.parse(rawUser);
    return user?.id && user?.first_name ? user : null;
  } catch {
    return null;
  }
}

function initDataFromRequest(req) {
  const directHeader = req.get("X-Telegram-Init-Data");
  if (directHeader) return directHeader;
  const authorization = req.get("Authorization") || "";
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
}

module.exports = { telegramUserFromInitData, initDataFromRequest };
