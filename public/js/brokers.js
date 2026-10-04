/* MIBrokers v6 part 1: state + urls + execute */
(function () {
  'use strict';
  var LS = 'mi.broker.v1';
  var state = { broker: 'pocket', fxAccount: 'mt5' };
  try { var s = JSON.parse(localStorage.getItem(LS) || 'null'); if (s) state = Object.assign(state, s); } catch (e) {}
  function save() { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) {} }
  var POCKET = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/';
  var POCKET_OTC = 'https://pocketoption.com/en/cabinet/demo-quick-high-low/';
  // Live MT5 REAL terminal (user-provided). MT4 Real has no Pocket web URL,
  // so MT4 routes to the Exness MT4 account area (user can change in Settings).
  var POCKET_MT5_LIVE = 'https://pocketoption.com/en/cabinet/mt5/live/';
  var MT5 = 'https://www.metatrader5.com/';
  var MT4 = 'https://www.metatrader4.com/';
  var EXNESS = 'https://www.exness.com/accounts/';
  function brokerUrl(mode, sym) {
    sym = String(sym || 'EURUSD').toUpperCase();
    var otc = /_OTC$/.test(sym);
    if (mode === 'pocket') return otc ? POCKET_OTC : POCKET;
    if (mode === 'crypto') {
      if (sym.endsWith('USDT')) return 'https://www.binance.com/en/trade/' + sym.replace(/USDT$/, '') + '_USDT?theme=dark&type=spot';
      return 'https://www.binance.com/en/markets';
    }
    // Forex LIVE + OTC route to the chosen broker.
    // Pocket + MT5 Real → the LIVE MT5 terminal link (user-provided).
    // Pocket + MT4 Real → Exness MT4 area (Pocket has no MT4-web URL).
    if (otc) return (state.broker === 'pocket' || state.broker === 'mt5') && state.fxAccount === 'mt5' ? POCKET_MT5_LIVE : POCKET_OTC;
    if (state.broker === 'pocket') return state.fxAccount === 'mt4' ? EXNESS : POCKET_MT5_LIVE;
    if (state.broker === 'exness') return EXNESS;
    if (state.fxAccount === 'mt4') return MT4;
    return POCKET_MT5_LIVE;
  }
  function activationLabel() {
    if (state.broker === 'pocket') return 'Activated for Pocket Option Forex ' + (state.fxAccount === 'mt4' ? 'MT4 Real' : 'MT5 Real');
    if (state.broker === 'exness') return 'Activated for Exness Forex ' + (state.fxAccount === 'mt4' ? 'MT4 Real' : 'MT5 Real');
    return 'Activated for ' + (state.fxAccount === 'mt4' ? 'MT4 Real' : 'MT5 Real');
  }
  async function execute(sig, side) {
    var mode = (window.MI && MI.mode) || sig.mode || 'crypto';
    var url = brokerUrl(mode, sig.symbol);
    var ticket = 'MI ' + (sig.asset || sig.symbol) + ' ' + side + ' Entry ' + sig.entry + ' TP ' + (sig.takeProfit || '-') + ' SL ' + (sig.stopLoss || '-') + ' Conf ' + sig.confidence + '%';
    try { await navigator.clipboard.writeText(ticket); } catch (e) {}
    try {
      var h = []; try { h = JSON.parse(localStorage.getItem('mi.broker.history.v1') || '[]'); } catch (e) {}
      h.unshift({ ts: Date.now(), symbol: sig.symbol, asset: sig.asset, side: side, broker: state.broker, fxAccount: state.fxAccount });
      localStorage.setItem('mi.broker.history.v1', JSON.stringify(h.slice(0, 50)));
    } catch (e) {}
    if (window.MI && MI.toast) MI.toast('success', side + ' ticket copied', (sig.asset || sig.symbol) + ' broker opened in new tab. Paste TP/SL.');
    try { window.open(url, '_blank', 'noopener'); } catch (e) {}
    return ticket;
  }
  window.MIBrokers = window.MIBrokers || {};
  window.MIBrokers.get = function () { return { broker: state.broker, fxAccount: state.fxAccount }; };
  window.MIBrokers._state = state; window.MIBrokers._save = save;
  window.MIBrokers.label = activationLabel; window.MIBrokers.url = brokerUrl; window.MIBrokers.execute = execute;
})();
