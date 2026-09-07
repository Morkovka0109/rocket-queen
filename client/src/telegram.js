// Dev builds have no Telegram identity, so each tab needs its own so that
// several open tabs do not fight over one shared server-side round.
function tabId() {
  try {
    let id = sessionStorage.getItem('aviator:tab');
    if (!id) {
      id = Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('aviator:tab', id);
    }
    return id;
  } catch {
    return '';
  }
}

export function bootTelegram() {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;

  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.requestFullscreen?.();
      tg.disableVerticalSwipes?.();
      tg.enableClosingConfirmation?.();
      tg.setHeaderColor?.('#071433');
      tg.setBackgroundColor?.('#071433');
    } catch (err) {
      console.warn('Telegram WebApp chrome init failed', err);
    }

    const applyInsets = () => {
      const safe = tg.safeAreaInset || {};
      const content = tg.contentSafeAreaInset || {};
      root.style.setProperty('--tg-safe-top', `${(safe.top || 0) + (content.top || 0)}px`);
      root.style.setProperty('--tg-safe-bottom', `${(safe.bottom || 0) + (content.bottom || 0)}px`);
    };

    try {
      applyInsets();
      tg.onEvent?.('fullscreenChanged', applyInsets);
      tg.onEvent?.('safeAreaChanged', applyInsets);
      tg.onEvent?.('contentSafeAreaChanged', applyInsets);
    } catch (err) {
      console.warn('Telegram inset sync failed', err);
    }
  }

  return {
    initData: tg?.initData || '',
    devId: tabId(),
    user: tg?.initDataUnsafe?.user || null,
    haptic: (type = 'medium') => {
      try {
        tg?.HapticFeedback?.impactOccurred(type);
      } catch {
        /* outside Telegram */
      }
    },
    notify: (type = 'success') => {
      try {
        tg?.HapticFeedback?.notificationOccurred(type);
      } catch {
        /* outside Telegram */
      }
    },
  };
}
