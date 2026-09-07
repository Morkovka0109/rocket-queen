function apiOrigin() {
  if (import.meta.env.DEV) return '';
  return import.meta.env.VITE_API_ORIGIN || '';
}

function authHeaders(telegram) {
  const headers = { 'Content-Type': 'application/json' };
  if (telegram?.initData) {
    headers.Authorization = `Bearer ${telegram.initData}`;
    headers['X-Telegram-Init-Data'] = telegram.initData;
  }
  if (telegram?.devId) headers['X-Dev-Id'] = telegram.devId;
  return headers;
}

async function readJson(res) {
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || res.statusText };
  }
  if (!res.ok) {
    const error = new Error(data.error || res.statusText || 'Ошибка запроса');
    error.status = res.status;
    error.code = data.code;
    error.body = data;
    throw error;
  }
  return data;
}

export async function createGame(telegram, { amount, speed }) {
  const res = await fetch(`${apiOrigin()}/api/aviator/games`, {
    method: 'POST',
    headers: authHeaders(telegram),
    body: JSON.stringify({ amount, speed, initData: telegram.initData, devId: telegram.devId }),
  });
  return readJson(res);
}

export async function cashOutGame(telegram, gameId) {
  const res = await fetch(`${apiOrigin()}/api/aviator/games/${gameId}/cashout`, {
    method: 'POST',
    headers: authHeaders(telegram),
    body: JSON.stringify({ initData: telegram.initData, devId: telegram.devId }),
  });
  return readJson(res);
}
