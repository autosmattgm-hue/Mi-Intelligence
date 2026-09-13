/* ============ MI PWA — installable app + offline shell ============ */
(function () {
  'use strict';

  const LS_INSTALL_DISMISSED = 'mi.pwa.installDismissed';
  const state = { deferredPrompt: null, standalone: false };

  function $(id) { return document.getElementById(id); }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true
      || /display=standalone/i.test(window.location.search);
  }

  function toggleInstallBtn(show) {
    const btn = $('installBtn');
    if (!btn) return;
    if (show && !state.standalone && !localStorage.getItem(LS_INSTALL_DISMISSED)) {
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
  }

  function setupInstallButton() {
    const btn = $('installBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (state.deferredPrompt) {
        state.deferredPrompt.prompt();
        const choice = await state.deferredPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          if (window.MI && MI.toast) MI.toast('success', 'Installing MI…', 'MI is being installed as an app on your device.');
        } else if (window.MI && MI.toast) {
          MI.toast('info', 'Install cancelled', 'You can install MI anytime from the ⬇️ button or the browser menu.');
        }
        state.deferredPrompt = null;
        toggleInstallBtn(false);
      } else if (window.MI && MI.toast) {
        MI.toast('info', 'Install via browser', 'Use your browser menu → "Install app" (or "Add to Home Screen" on mobile).');
      }
    });
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        if (window.MI && MI.toast && !localStorage.getItem('mi.pwa.welcomed')) {
          localStorage.setItem('mi.pwa.welcomed', '1');
          if (!state.standalone) MI.toast('info', '🔋 MI is offline-ready', 'The app now works as an installable PWA — tap ⬇️ to add it to your device.');
        }
        reg.update();
      }).catch(() => { /* offline-optional; skip silently */ });
    });
  }

  function init() {
    state.standalone = isStandalone();
    window.MI = window.MI || {};

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredPrompt = e;
      toggleInstallBtn(true);
    });

    window.addEventListener('appinstalled', () => {
      state.standalone = true;
      toggleInstallBtn(false);
      if (window.MI && MI.toast) MI.toast('success', '✅ MI installed', 'Welcome to the MI app — launch it from your home screen, taskbar or app list.');
    });

    window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
      state.standalone = e.matches;
      toggleInstallBtn();
    });

    setupInstallButton();
    toggleInstallBtn();
    registerSW();
  }

  document.addEventListener('DOMContentLoaded', init);
})();