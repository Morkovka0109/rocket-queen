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

function applyChrome(tg) {
  const root = document.documentElement;
  const height = Number(tg.viewportStableHeight || tg.viewportHeight || window.innerHeight) || window.innerHeight;
  root.style.setProperty('--tg-vh', `${height}px`);
  root.style.setProperty('--app-height', `${height}px`);

  const safe = tg.safeAreaInset || {};
  const content = tg.contentSafeAreaInset || {};
  root.style.setProperty('--tg-safe-top', `${(safe.top || 0) + (content.top || 0)}px`);
  root.style.setProperty('--tg-safe-bottom', `${(safe.bottom || 0) + (content.bottom || 0)}px`);
  root.style.setProperty('--tg-safe-left', `${safe.left || 0}px`);
  root.style.setProperty('--tg-safe-right', `${safe.right || 0}px`);
}

function lockScroll() {
  const block = (event) => {
    if (event.target?.closest?.('button, a, input, textarea, .round-continue, .leaders')) return;
    event.preventDefault();
  };
  document.addEventListener('touchmove', block, { passive: false });
  document.addEventListener('gesturestart', (event) => event.preventDefault());
  document.addEventListener('contextmenu', (event) => event.preventDefault());
}

export function bootTelegram() {
  const tg = window.Telegram?.WebApp;
  const root = document.documentElement;
  const isTelegram = Boolean(tg?.initData);

  if (tg && isTelegram) {
    try {
      tg.ready();
      tg.expand();
      tg.requestFullscreen?.();
      tg.disableVerticalSwipes?.();
      tg.lockOrientation?.('portrait');
      tg.setHeaderColor?.('#071433');
      tg.setBackgroundColor?.('#071433');
      tg.setBottomBarColor?.('#071433');
      tg.SettingsButton?.hide?.();
      tg.MainButton?.hide?.();
      tg.BackButton?.show?.();
      tg.BackButton?.onClick?.(() => tg.close());
    } catch (err) {
      console.warn('Telegram WebApp chrome init failed', err);
    }

    root.classList.add('is-telegram');
    if (tg.platform) root.dataset.tgPlatform = tg.platform;
    applyChrome(tg);
    lockScroll();

    const onViewport = () => {
      applyChrome(tg);
      window.dispatchEvent(new Event('resize'));
    };
    try {
      tg.onEvent?.('viewportChanged', onViewport);
      tg.onEvent?.('fullscreenChanged', onViewport);
      tg.onEvent?.('safeAreaChanged', onViewport);
      tg.onEvent?.('contentSafeAreaChanged', onViewport);
      tg.onEvent?.('themeChanged', onViewport);
    } catch (err) {
      console.warn('Telegram inset sync failed', err);
    }
    window.addEventListener('resize', () => applyChrome(tg));
  }

  const setStayOpen = (stay) => {
    try {
      if (!tg) return;
      if (stay) tg.enableClosingConfirmation?.();
      else tg.disableClosingConfirmation?.();
    } catch {
      /* ignore */
    }
  };

  return {
    initData: tg?.initData || '',
    devId: tabId(),
    user: tg?.initDataUnsafe?.user || null,
    isTelegram,
    platform: tg?.platform || 'unknown',
    setStayOpen,
    close: () => {
      try {
        tg?.close?.();
      } catch {
        /* ignore */
      }
    },
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
