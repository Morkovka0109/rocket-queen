import crypto from 'crypto';

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Validates Telegram Mini App initData.
 * @see https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (!timingSafeEqualHex(computed, hash)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  if (Date.now() / 1000 - authDate > maxAgeSec) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user?.id) return null;

  return {
    id: String(user.id),
    username: user.username || user.first_name || `user_${user.id}`,
    firstName: user.first_name || '',
    lastName: user.last_name || '',
    photoUrl: user.photo_url || null,
  };
}

export function createDevUser(seed) {
  const tag = typeof seed === 'string' ? seed.replace(/[^a-z0-9-]/gi, '').slice(0, 24) : '';
  return {
    id: tag ? `dev-${tag}` : 'dev-player',
    username: 'Игрок',
    firstName: 'Dev',
    lastName: 'Queen',
    photoUrl: null,
    isDev: true,
  };
}
