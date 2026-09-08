import { createChart } from './chart.js';
import { t } from './i18n.js';
import { getAudio } from './audio.js';

function fan(value) {
  return `${Number(value).toFixed(2).replace('.', ',')} ФАН`;
}

export function bindApp(root) {
  const els = {
    app: root,
    balance: root.querySelector('#balance'),
    play: root.querySelector('#play-btn'),
    playCaption: root.querySelector('#play-caption'),
    label: root.querySelector('#plane-label'),
    stage: root.querySelector('.stage'),
    height: root.querySelector('#stat-height'),
    distance: root.querySelector('#stat-distance'),
    mult: root.querySelector('#stat-mult'),
    betView: root.querySelector('#bet-view'),
    betUp: root.querySelector('#bet-up'),
    betDown: root.querySelector('#bet-down'),
    bonus: root.querySelector('#bonus-btn'),
    status: root.querySelector('#status'),
    canvas: root.querySelector('#game-root'),
    leaders: root.querySelector('#leaders'),
    leadersBtn: root.querySelector('#leaders-btn'),
    betList: root.querySelector('#bet-list'),
    history: root.querySelector('#history'),
    fxFlash: root.querySelector('#fx-flash'),
    fxLose: root.querySelector('#fx-lose'),
    fxDim: root.querySelector('#fx-dim'),
    eventBanner: root.querySelector('#event-banner'),
    streakChip: root.querySelector('#streak-chip'),
    roundOverlay: root.querySelector('#round-overlay'),
    roundTitle: root.querySelector('#round-title'),
    roundAmount: root.querySelector('#round-amount'),
    roundContinue: root.querySelector('#round-continue'),
    speeds: [...root.querySelectorAll('.speed')],
    sound: root.querySelector('#sound-btn'),
  };

  const chart = createChart(els.canvas);
  chart.onPickup((ev) => pickupHandler?.(ev));
  chart.onAirborne((t) => airborneHandler?.(t));
  const audio = getAudio();
  let betAmount = 1;
  let speed = 2;
  let playHandler = null;
  let bonusHandler = null;
  let speedHandler = null;
  let collectHandler = null;
  let pickupHandler = null;
  let airborneHandler = null;
  let overlayKind = 'continue';
  let pickLockUntil = 0;
  let myCents = 0;
  let targetMult = 1;
  let shownMult = 1;
  let targetBal = 0;
  let shownBal = 0;
  let balReady = false;
  let altitude = 0;
  let distanceM = 0;
  let progress = 0;
  let roundEvents = null;
  let playerStreak = 0;
  const history = [];
  const bets = new Map();
  try {
    const saved = Number(localStorage.getItem('aviator-fan-bet'));
    if (Number.isFinite(saved) && saved > 0) betAmount = saved;
    const savedSpeed = Number(localStorage.getItem('aviator-fan-speed'));
    if (Number.isFinite(savedSpeed) && savedSpeed >= 1) speed = savedSpeed;
  } catch {
    /* ignore */
  }

  const hideOverlay = () => {
    if (!els.roundOverlay) return;
    els.roundOverlay.hidden = true;
  };

  const showOverlay = ({ title, amount, action, kind }) => {
    if (!els.roundOverlay) return;
    overlayKind = kind || 'continue';
    els.roundTitle.textContent = title;
    if (amount) {
      els.roundAmount.hidden = false;
      els.roundAmount.textContent = amount;
    } else {
      els.roundAmount.hidden = true;
      els.roundAmount.textContent = '';
    }
    els.roundContinue.textContent = action;
    els.roundOverlay.hidden = false;
  };

  els.roundContinue?.addEventListener('click', () => {
    audio.click();
    if (overlayKind === 'cashout') {
      collectHandler?.();
      return;
    }
    hideOverlay();
    if (overlayKind === 'again' || overlayKind === 'continue') playHandler?.();
  });

  const syncSoundBtn = () => {
    if (!els.sound) return;
    els.sound.classList.toggle('is-muted', audio.muted);
    els.sound.setAttribute('aria-label', audio.muted ? t.soundOff : t.soundOn);
  };
  syncSoundBtn();
  root.addEventListener('pointerdown', () => audio.unlock(), true);
  els.sound?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    audio.unlock();
    audio.toggleMute();
    syncSoundBtn();
  });

  const persist = () => {
    try {
      localStorage.setItem('aviator-fan-bet', String(betAmount));
      localStorage.setItem('aviator-fan-speed', String(speed));
    } catch {
      /* ignore */
    }
  };

  const bang = (node, cls, ms) => {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    window.clearTimeout(node._fx);
    node._fx = window.setTimeout(() => node.classList.remove(cls), ms);
  };

  const writeMult = (n) => {
    els.mult.textContent = `x${n.toFixed(2).replace('.', ',')}`;
    els.height.textContent = `${altitude.toFixed(1)}m`;
    els.distance.textContent = `${distanceM.toFixed(1)}m`;
    const show = myCents > 0 ? (myCents * Math.floor(n * 100)) / 100 / 100 : betAmount;
    if (els.app.dataset.phase !== 'landed' && els.app.dataset.phase !== 'crashed') {
      els.label.textContent = fan(show);
    }
  };

  const moveLabel = () => {
    const pos = chart.labelPos();
    // The label is centred on the plane, so keep it inside the stage to stop it
    // being clipped when the plane sits near an edge on narrow screens.
    const half = els.label.offsetWidth / 2;
    const max = els.stage?.clientWidth || els.app.clientWidth;
    els.label.style.left = `${Math.min(Math.max(pos.x, half + 4), max - half - 4)}px`;
    els.label.style.top = `${pos.y}px`;
    const dm = targetMult - shownMult;
    if (dm !== 0) {
      shownMult = targetMult;
      writeMult(shownMult);
    }
    const db = targetBal - shownBal;
    if (Math.abs(db) > 0.008) {
      shownBal += db * 0.16;
      els.balance.textContent = fan(shownBal);
    } else if (shownBal !== targetBal) {
      shownBal = targetBal;
      els.balance.textContent = fan(shownBal);
    }
    requestAnimationFrame(moveLabel);
  };
  moveLabel();

  const renderBet = () => {
    els.betView.textContent = fan(betAmount);
  };

  const renderSpeeds = () => {
    for (const btn of els.speeds) {
      btn.classList.toggle('is-on', Number(btn.dataset.speed) === speed);
    }
  };

  const renderHistory = () => {
    if (!els.history) return;
    els.history.innerHTML = history
      .slice(0, 16)
      .map((value) => {
        if (!value) return `<span class="hist hist-crash">срыв</span>`;
        const cls = value >= 10 ? 'hist-high' : value >= 2 ? 'hist-mid' : 'hist-low';
        return `<span class="hist ${cls}">x${Number(value).toFixed(2).replace('.', ',')}</span>`;
      })
      .join('');
  };

  els.betUp.addEventListener('click', () => {
    audio.click();
    betAmount = Math.min(500, Math.round((betAmount + 1) * 100) / 100);
    persist();
    renderBet();
  });
  els.betDown.addEventListener('click', () => {
    audio.click();
    betAmount = Math.max(1, Math.round((betAmount - 1) * 100) / 100);
    persist();
    renderBet();
  });
  for (const btn of els.speeds) {
    btn.addEventListener('click', () => {
      audio.click();
      speed = Number(btn.dataset.speed);
      persist();
      renderSpeeds();
      chart.setSpeed(speed);
      speedHandler?.(speed);
    });
  }
  chart.setSpeed(speed);
  els.play.addEventListener('click', () => {
    audio.unlock();
    audio.click();
    playHandler?.();
  });
  els.bonus?.addEventListener('click', () => {
    audio.click();
    bonusHandler?.();
  });
  if (els.leadersBtn && els.leaders) {
    els.leadersBtn.addEventListener('click', () => {
      els.leaders.hidden = !els.leaders.hidden;
    });
  }

  renderBet();
  renderSpeeds();

  const writeBanner = (active) => {
    if (!els.eventBanner) return;
    els.eventBanner.hidden = true;
    els.eventBanner.textContent = '';
    els.app.classList.remove('is-golden');
  };

  const writeStreak = () => {
    if (!els.streakChip) return;
    const show = playerStreak >= 2;
    els.streakChip.hidden = !show;
    if (show) els.streakChip.textContent = t.streakChip(playerStreak);
  };

  const renderBets = () => {
    if (!els.betList) return;
    els.betList.innerHTML = [...bets.values()]
      .map((bet) => {
        const amount = fan((bet.amountCents || 0) / 100);
        const extra = bet.cashedOut
          ? `${Number(bet.cashoutMultiplier).toFixed(2).replace('.', ',')}x`
          : amount;
        return `<li><strong>${bet.username}</strong><span>${extra}</span></li>`;
      })
      .join('');
  };

  return {
    onPlay(fn) {
      playHandler = fn;
    },
    onCollect(fn) {
      collectHandler = fn;
    },
    onPickup(fn) {
      pickupHandler = fn;
    },
    notePickup(ev) {
      pickLockUntil = Date.now() + 240;
      let m = targetMult || 1;
      const n = Number(String(ev?.value ?? '').replace(/[^\d.]/g, ''));
      if (ev?.kind === 'add') m += n || 0;
      else if (ev?.kind === 'mul') m *= n || 1;
      else if (ev?.kind === 'rocket') m *= 0.5;
      this.setMultiplier(Math.min(250, Math.floor(m * 100) / 100));
    },
    onAirborne(fn) {
      airborneHandler = fn;
    },
    onAutoCashoutChange() {},
    onBonus(fn) {
      bonusHandler = fn;
    },
    onSpeed(fn) {
      speedHandler = fn;
    },
    setFlightSpeed(n, durationMs) {
      chart.setSpeed(n, durationMs);
    },
    setBalance(value) {
      const next = Number(value) || 0;
      if (balReady && next !== targetBal) {
        els.balance.classList.remove('is-up', 'is-down');
        void els.balance.offsetWidth;
        els.balance.classList.add(next > targetBal ? 'is-up' : 'is-down');
      }
      targetBal = next;
      if (!balReady) {
        shownBal = next;
        els.balance.textContent = fan(next);
        balReady = true;
      }
    },
    setPlayer() {},
    setStatus(text) {
      els.status.textContent = text || '';
    },
    setPhase(phase) {
      const prev = els.app.dataset.phase;
      els.app.dataset.phase = phase;
      if (phase === 'flying') chart.startFlying();
      if (phase === 'waiting' && prev && prev !== 'waiting') bang(els.fxDim, 'is-on', 580);
    },
    setMode(mode) {
      els.app.dataset.mode = mode === 'flying' ? 'flying' : 'launch';
      const flying = mode === 'flying';
      const caption = flying ? t.flying : t.launch;
      els.play.setAttribute('aria-label', caption);
      if (els.playCaption) els.playCaption.textContent = caption;
    },
    setMultiplier(value) {
      const n = Number(value) || 1;
      chart.setMultiplier(n);
      targetMult = n;
      shownMult = n;
      writeMult(n);
    },
    setProgress(p, multiplier, alt, dist, energy) {
      progress = Math.max(0, Number(p) || 0);
      if (alt != null && Number.isFinite(Number(alt))) altitude = Number(alt);
      if (dist != null && Number.isFinite(Number(dist))) distanceM = Number(dist);
      else distanceM = Math.round(progress * 3800) / 10;
      if (energy != null && Number.isFinite(Number(energy))) {
        chart.setEnergy?.(energy);
        if (alt == null || !Number.isFinite(Number(alt))) {
          altitude = Math.round((6 + Number(energy) * 48) * 10) / 10;
        }
      }
      chart.setProgress(progress);
      if (multiplier != null && Date.now() >= pickLockUntil) this.setMultiplier(multiplier);
      else writeMult(shownMult);
    },
    setWaiting() {
      chart.reset();
      els.label.classList.remove('is-win');
      progress = 0;
      altitude = 0;
      distanceM = 0;
      targetMult = 1;
      shownMult = 1;
      writeMult(1);
      this.clearEvents();
    },
    applyRoundEvents(mod) {
      roundEvents = mod || null;
      chart.applyRoundEvents(mod);
      writeBanner(null);
    },
    setActiveEvent(type) {
      chart.setActiveEvent(type);
      writeBanner(type);
    },
    setStreak(n) {
      playerStreak = Math.max(0, Number(n) || 0);
      writeStreak();
    },
    clearEvents() {
      roundEvents = null;
      chart.applyRoundEvents(null);
      writeBanner(null);
    },
    launchPlane() {
      hideOverlay();
      chart.launch();
    },
    isLaunched() {
      return chart.isLaunched();
    },
    abortLaunch() {
      chart.abortLaunch();
    },
    setCrashed(point, reason, missAt) {
      const n = Number(point) || 1;
      targetMult = n;
      shownMult = n;
      writeMult(n);
      els.label.classList.remove('is-win');
      chart.crash(n, () => {
        showOverlay({ title: t.defeat, action: t.again, kind: 'again' });
        bang(els.fxLose, 'is-on', 700);
      }, missAt);
    },
    land(payoutCents, { collect = true, landAt } = {}) {
      const won = Number(payoutCents);
      const amount = Number.isFinite(won) && won > 0 ? fan(won / 100) : '';
      els.app.dataset.phase = 'landed';
      els.label.textContent = amount || t.landed;
      els.label.classList.remove('is-win');
      void els.label.offsetWidth;
      els.label.classList.add('is-win');
      chart.land(() => {
        showOverlay({
          title: t.victory,
          amount,
          action: collect ? t.cashout : t.continue,
          kind: collect ? 'cashout' : 'continue',
        });
        bang(els.fxFlash, 'is-on', 450);
      }, landAt);
    },
    markCollected(payoutCents) {
      const won = Number(payoutCents);
      const amount = Number.isFinite(won) && won > 0 ? fan(won / 100) : '';
      if (amount) {
        els.roundAmount.hidden = false;
        els.roundAmount.textContent = amount;
      }
      overlayKind = 'continue';
      if (els.roundContinue) els.roundContinue.textContent = t.continue;
    },
    setHistory(list) {
      history.length = 0;
      history.push(...(list || []));
      renderHistory();
    },
    pushHistory(value) {
      history.unshift(Number(value) || 0);
      if (history.length > 24) history.length = 24;
      renderHistory();
    },
    clearCrash() {
      myCents = 0;
      els.label.classList.remove('is-win');
      els.label.textContent = fan(betAmount);
      hideOverlay();
    },
    setMyBetCents(cents) {
      myCents = cents;
    },
    getBetAmount() {
      return betAmount;
    },
    getSpeed() {
      return speed;
    },
    getAutoCashout() {
      return null;
    },
    setBets(list) {
      bets.clear();
      for (const bet of list) bets.set(`${bet.userId}:${bet.slot ?? 0}`, bet);
      renderBets();
    },
    addBet(bet) {
      bets.set(`${bet.userId}:${bet.slot ?? 0}`, { ...bet, cashedOut: false });
      renderBets();
    },
    removeBet(bet) {
      bets.delete(`${bet.userId}:${bet.slot ?? 0}`);
      renderBets();
    },
    markCashout(cashout) {
      const key = `${cashout.userId}:${cashout.slot ?? 0}`;
      const current = bets.get(key) || cashout;
      bets.set(key, { ...current, cashedOut: true, cashoutMultiplier: cashout.multiplier });
      renderBets();
    },
  };
}
