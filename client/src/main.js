import { bootTelegram } from './telegram.js';
import { connectGame } from './gameClient.js';
import { bindApp } from './ui.js';
import { t } from './i18n.js';

async function start() {
  const boot = document.getElementById('boot-screen');
  const gate = document.getElementById('tg-gate');
  try {
    const telegram = bootTelegram();
    if (import.meta.env.PROD && !telegram.initData) {
      boot?.classList.add('is-hidden');
      if (gate) {
        gate.hidden = false;
        const line = gate.querySelector('p');
        if (line) line.textContent = t.openInTelegram;
      }
      return;
    }
    const root = document.getElementById('app');
    const ui = bindApp(root);
    const name = telegram.user?.username || telegram.user?.first_name || t.player;
    ui.setPlayer(name);
    connectGame({ telegram, ui });
    boot?.classList.add('is-hidden');
  } catch (err) {
    if (boot) boot.textContent = err?.message || t.loadFail;
    console.error(err);
  }
}

start();
